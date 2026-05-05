//! Sidecar process supervision.
//!
//! - Python FastAPI on http://127.0.0.1:8731  (apps/sidecar-py)
//! - Node Fastify on http://127.0.0.1:8732   (apps/sidecar-node)
//!
//! Source resolution (in order):
//!   1. Installed runtime: `<data_dir>/runtime/sidecar-{py,node}/...`
//!   2. Dev workspace: discovered via CARGO_MANIFEST_DIR or `current_exe()` parent
//!
//! The supervisor:
//!   - Holds the spawned `Child` handle (no orphans on respawn).
//!   - Probes the port BEFORE spawning to avoid duplicate spawns / port conflicts.
//!   - Captures stderr to a per-sidecar log file under `<cache_dir>/logs/`.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::installer::paths;
use crate::installer::python_env;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarStatus {
    Stopped,
    Starting,
    Running,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SidecarState {
    pub python: SidecarStatus,
    pub node: SidecarStatus,
    pub ollama: SidecarStatus,
}

pub struct Supervisor {
    state: Arc<Mutex<SidecarState>>,
    python_child: Arc<Mutex<Option<Child>>>,
    node_child: Arc<Mutex<Option<Child>>>,
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(SidecarState {
                python: SidecarStatus::Stopped,
                node: SidecarStatus::Stopped,
                ollama: SidecarStatus::Stopped,
            })),
            python_child: Arc::new(Mutex::new(None)),
            node_child: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn snapshot(&self) -> SidecarState {
        self.state.lock().await.clone()
    }

    /// Kick off both sidecars in the background. Best-effort.
    pub async fn start_all(&self) -> Result<()> {
        let _ = self.spawn_python_if_needed().await;
        let _ = self.spawn_node_if_needed().await;
        let _ = crate::installer::ollama::ensure_running().await;
        Ok(())
    }

    /// Probe → if up, mark running. If not but a child handle exists, take and kill it.
    /// Then spawn fresh and remember the handle.
    async fn spawn_python_if_needed(&self) -> Result<()> {
        if probe_python().await {
            self.state.lock().await.python = SidecarStatus::Running;
            return Ok(());
        }
        // Drop any stale child first
        self.kill_python_child().await;
        // Don't fight an external listener
        if port_is_bound("127.0.0.1:8731").await {
            return Err(anyhow!(":8731 already bound by another process"));
        }
        let child = spawn_python().await?;
        *self.python_child.lock().await = Some(child);
        self.state.lock().await.python = SidecarStatus::Starting;
        Ok(())
    }

    async fn spawn_node_if_needed(&self) -> Result<()> {
        if probe_node().await {
            self.state.lock().await.node = SidecarStatus::Running;
            return Ok(());
        }
        self.kill_node_child().await;
        if port_is_bound("127.0.0.1:8732").await {
            return Err(anyhow!(":8732 already bound"));
        }
        let child = spawn_node().await?;
        *self.node_child.lock().await = Some(child);
        self.state.lock().await.node = SidecarStatus::Starting;
        Ok(())
    }

    async fn kill_python_child(&self) {
        let mut guard = self.python_child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    async fn kill_node_child(&self) {
        let mut guard = self.node_child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    pub async fn run_health_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;

            let py_ok = probe_python().await;
            let node_ok = probe_node().await;
            let ollama_ok = crate::installer::ollama::is_running().await;

            // Reap dead children to avoid Zombies. If process exited, drop
            // the handle so the next spawn can start fresh.
            {
                let mut g = self.python_child.lock().await;
                if let Some(child) = g.as_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        *g = None;
                    }
                }
            }
            {
                let mut g = self.node_child.lock().await;
                if let Some(child) = g.as_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        *g = None;
                    }
                }
            }

            // Restart only if not responsive AND we don't already hold a live child
            if !py_ok {
                let has_live = self.python_child.lock().await.is_some();
                if !has_live {
                    let _ = self.spawn_python_if_needed().await;
                }
            }
            if !node_ok {
                let has_live = self.node_child.lock().await.is_some();
                if !has_live {
                    let _ = self.spawn_node_if_needed().await;
                }
            }

            let mut s = self.state.lock().await;
            s.python = if py_ok { SidecarStatus::Running } else { SidecarStatus::Stopped };
            s.node = if node_ok { SidecarStatus::Running } else { SidecarStatus::Stopped };
            s.ollama = if ollama_ok { SidecarStatus::Running } else { SidecarStatus::Stopped };
        }
    }
}

/// On-demand: ensure the Python sidecar is up (used by installer for HF downloads).
pub async fn ensure_python_sidecar() -> Result<()> {
    if probe_python().await {
        return Ok(());
    }
    spawn_python().await?.wait_with_output().await.ok(); // detached: we don't track here
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if probe_python().await {
            return Ok(());
        }
    }
    Err(anyhow!("Python sidecar failed to start within 30s"))
}

#[allow(dead_code)]
pub async fn ensure_node_sidecar() -> Result<()> {
    if probe_node().await {
        return Ok(());
    }
    let _ = spawn_node().await?;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if probe_node().await {
            return Ok(());
        }
    }
    Err(anyhow!("Node sidecar failed to start within 15s"))
}

async fn probe_python() -> bool {
    reqwest::Client::new()
        .get("http://127.0.0.1:8731/health")
        .timeout(std::time::Duration::from_secs(1))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn probe_node() -> bool {
    reqwest::Client::new()
        .get("http://127.0.0.1:8732/health")
        .timeout(std::time::Duration::from_secs(1))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn port_is_bound(addr: &str) -> bool {
    tokio::net::TcpStream::connect(addr).await.is_ok()
}

async fn spawn_python() -> Result<Child> {
    let py = python_env::python_exe_resolved()?;
    if !py.exists() {
        return Err(anyhow!("python not installed: {}", py.display()));
    }
    let server = resolve_sidecar("sidecar-py", "server.py")
        .ok_or_else(|| anyhow!("sidecar-py/server.py not found"))?;
    let cwd = server.parent().unwrap().to_path_buf();
    let assets_music = workspace_root()
        .map(|w| w.join("assets").join("music"))
        .unwrap_or_else(|| paths::paths().unwrap().data_dir.join("assets/music"));
    let out_dir = paths::paths()?.data_dir.join("projects");
    let _ = std::fs::create_dir_all(&out_dir);

    let log = open_log("sidecar-py.log")?;
    let log_err = log.try_clone()?;

    tracing::info!(server = %server.display(), "spawning python sidecar");
    let child = Command::new(&py)
        .arg(&server)
        .current_dir(&cwd)
        .env("PYTHONPATH", cwd.join("src"))
        .env("XIANXIA_MUSIC_DIR", assets_music)
        .env("XIANXIA_OUT_DIR", out_dir)
        .env("HF_HOME", paths::paths()?.data_dir.join("hf-cache"))
        .env("HF_HUB_ENABLE_HF_TRANSFER", "1")
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    Ok(child)
}

async fn spawn_node() -> Result<Child> {
    let node = resolve_node_binary().ok_or_else(|| anyhow!("node not installed yet"))?;
    let server = resolve_sidecar_node_entry()
        .ok_or_else(|| anyhow!("sidecar-node entry point not found (run `pnpm --filter @xianxia/sidecar-node build` or use the wizard)"))?;
    let cwd = server.parent().unwrap().to_path_buf();

    let log = open_log("sidecar-node.log")?;
    let log_err = log.try_clone()?;

    tracing::info!(server = %server.display(), "spawning node sidecar");
    let child = Command::new(&node)
        .arg(&server)
        .current_dir(&cwd)
        .env("XIANXIA_NODE_PORT", "8732")
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    Ok(child)
}

fn open_log(name: &str) -> Result<std::fs::File> {
    let dir = paths::paths()?.cache_dir.join("logs");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(name);
    Ok(std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?)
}

fn resolve_sidecar(folder: &str, entry: &str) -> Option<PathBuf> {
    if let Ok(p) = paths::runtime_dir() {
        let candidate = p.join(folder).join(entry);
        if candidate.exists() {
            return Some(strip_extended(candidate));
        }
    }
    if let Some(ws) = workspace_root() {
        let candidate = ws.join("apps").join(folder).join(entry);
        if candidate.exists() {
            return Some(strip_extended(candidate));
        }
    }
    None
}

fn resolve_sidecar_node_entry() -> Option<PathBuf> {
    if let Ok(p) = paths::runtime_dir() {
        let installed = p.join("sidecar-node").join("dist").join("server.js");
        if installed.exists() {
            return Some(strip_extended(installed));
        }
    }
    if let Some(ws) = workspace_root() {
        let dev = ws.join("apps").join("sidecar-node").join("dist").join("server.js");
        if dev.exists() {
            return Some(strip_extended(dev));
        }
    }
    None
}

fn resolve_node_binary() -> Option<PathBuf> {
    // Prefer embedded portable Node if installed in runtime/node
    if let Ok(node_root) = paths::node_dir() {
        if let Ok(entries) = std::fs::read_dir(&node_root) {
            for entry in entries.flatten() {
                if entry.file_type().ok()?.is_dir() {
                    #[cfg(target_os = "windows")]
                    let candidate = entry.path().join("node.exe");
                    #[cfg(not(target_os = "windows"))]
                    let candidate = entry.path().join("bin").join("node");
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    // Fallback to system PATH (auto-detected)
    crate::installer::detect::resolved_node().or_else(|| which::which("node").ok())
}

fn workspace_root() -> Option<PathBuf> {
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let candidate = std::path::Path::new(manifest)
            .join("..")
            .join("..")
            .join("..");
        if candidate.exists() {
            return Some(strip_extended(candidate.canonicalize().ok()?));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut p = exe.parent()?.to_path_buf();
        for _ in 0..6 {
            if p.join("apps").join("sidecar-py").exists() {
                return Some(strip_extended(p));
            }
            if !p.pop() {
                break;
            }
        }
    }
    None
}

/// Windows `canonicalize()` returns paths with the `\\?\` extended-length
/// prefix, which Node.js (and some other tools) refuse to parse. Strip it.
fn strip_extended(p: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p
}

#[tauri::command]
pub async fn get_sidecar_state(
    sup: tauri::State<'_, Arc<Supervisor>>,
) -> Result<SidecarState, String> {
    Ok(sup.snapshot().await)
}

#[tauri::command]
pub fn get_workspace_root() -> Option<String> {
    workspace_root().map(|p| p.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct SidecarLogs {
    pub python: String,
    pub node: String,
}

#[tauri::command]
pub fn get_sidecar_logs() -> Result<SidecarLogs, String> {
    let dir = paths::paths().map_err(|e| e.to_string())?.cache_dir.join("logs");
    let read = |name: &str| -> String {
        let p = dir.join(name);
        std::fs::read_to_string(&p).unwrap_or_else(|_| format!("(no log yet at {})", p.display()))
    };
    Ok(SidecarLogs {
        python: read("sidecar-py.log"),
        node: read("sidecar-node.log"),
    })
}
