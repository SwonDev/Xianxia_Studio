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

mod extract;
mod hf_seed;

pub use extract::extract_bundled_sidecars;

use crate::installer::paths;
use crate::installer::python_env;
use crate::process_ext::HideConsole;

/// Max age (seconds) for the `.llamacpp_suspended` sentinel before the
/// supervisor treats it as stale and respawns llama-server anyway. The
/// longest legitimate non-LLM stretch is TTS (~10 min) + image batch
/// (~16-20 min for 16 beats) + DepthFlow (~4 min) + MusicGen (up to
/// 40 min on long videos) = ~75 min. We pick 90 min so a healthy long-
/// form run never trips the TTL while still capping a forgotten suspend.
/// Combined with the proactive `wake_llm()` calls in `pipeline/mod.rs`
/// before any LLM-bearing phase, this TTL acts as a safety net rather
/// than the primary recovery mechanism.
const SUSPEND_FLAG_TTL_SECS: u64 = 90 * 60;

/// Builds a PATH for spawned sidecars that ALWAYS includes the locations
/// where ffmpeg/ffprobe might live, in addition to the parent process's PATH.
/// This is the cornerstone of the Auto principle for video tooling: the
/// supervisor guarantees that any subprocess (HyperFrames, FFmpeg post-pass,
/// burn-in, frame extraction, depth segmentation) finds ffmpeg without the
/// user ever touching PATH on their machine.
///
/// Order (highest priority first):
///   1. `<data_dir>/runtime/ffmpeg/bin`     — installer-managed ffmpeg
///   2. `<data_dir>/runtime/sidecar-node/node_modules/.bin` — execa local
///   3. `<data_dir>/runtime/python/python` — embedded Python dir (Windows
///      DLL search order looks here for ffmpeg.exe co-located with python.exe)
///   4. `<LOCALAPPDATA>/Microsoft/WinGet/Links` — typical WinGet ffmpeg
///   5. Inherited PATH from the Tauri process (system PATH)
fn augmented_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(p) = paths::paths() {
        dirs.push(p.data_dir.join("runtime").join("ffmpeg").join("bin"));
        dirs.push(p.data_dir.join("runtime").join("sidecar-node").join("node_modules").join(".bin"));
        dirs.push(p.data_dir.join("runtime").join("python").join("python"));
    }
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local_appdata).join("Microsoft").join("WinGet").join("Links"));
    }
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let inherited_paths: Vec<PathBuf> = std::env::split_paths(&inherited).collect();
    dirs.extend(inherited_paths);
    // Deduplicate while preserving order, keeping only directories that exist
    // OR could exist (some ffmpeg dirs are created post-spawn after install).
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let unique: Vec<PathBuf> = dirs
        .into_iter()
        .filter(|p| {
            let key = p.to_string_lossy().to_lowercase();
            seen.insert(key)
        })
        .collect();
    std::env::join_paths(unique).unwrap_or(inherited)
}

/// Kills sidecar processes (python.exe / node.exe) inherited from a previous
/// instance of the app. Critical after auto-updates: when v0.1.X → v0.1.X+1
/// applies, the OS replaces the .exe but the daemons spawned by v0.1.X
/// keep running, holding port 8731 / 8732 / 8188 with stale code. The new
/// supervisor would then see the port bound and back off forever, leaving
/// the user with the previous version's bugs (e.g. stale CORS rules).
///
/// We match orphans through TWO criteria, since either alone misses cases:
///   1. **Exe path under `<data_dir>/runtime/`** — catches the embedded
///      Python interpreter spawned for the sidecar.
///   2. **Cmdline references `<data_dir>/runtime/`** — catches a *system*
///      Node (e.g. `C:\nvm4w\nodejs\node.exe`) running our
///      `runtime/sidecar-node/dist/server.js`. Without this, the Node
///      sidecar survived auto-updates because its exe lives outside our
///      runtime tree, and the new supervisor saw :8732 already bound.
pub fn kill_orphan_sidecars() {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    let runtime = match paths::runtime_dir() {
        Ok(p) => p,
        Err(_) => return,
    };
    let runtime = std::fs::canonicalize(&runtime).unwrap_or(runtime);
    let runtime_str = runtime.to_string_lossy().to_lowercase();

    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut killed = 0;
    for (pid, proc_) in sys.processes() {
        let exe_canon = proc_.exe().map(|p| {
            std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
        });

        // Criterion 1: executable inside our runtime tree.
        let exe_inside_runtime = exe_canon
            .as_ref()
            .map(|p| p.starts_with(&runtime))
            .unwrap_or(false);

        // Criterion 2: any cmdline argument points inside our runtime tree.
        // This catches system `node.exe` running our `runtime/sidecar-node/
        // dist/server.js`, which would otherwise escape the filter.
        let cmd_refs_runtime = proc_.cmd().iter().any(|arg| {
            arg.to_string_lossy().to_lowercase().contains(&runtime_str)
        });

        if exe_inside_runtime || cmd_refs_runtime {
            tracing::warn!(
                ?pid,
                exe = ?exe_canon,
                cmd_refs_runtime,
                "killing orphan sidecar from previous app instance",
            );
            if proc_.kill() {
                killed += 1;
            }
        }
    }
    if killed > 0 {
        tracing::info!(killed, "purged orphan sidecars; new supervisor can now bind ports cleanly");
    }

    // v0.2.2 self-heal — drop any leftover `.llamacpp_suspended` from a
    // previous instance that crashed mid-pipeline. The orphaned llama-server
    // was just killed above, so the sentinel is meaningless; carrying it
    // into the new session would suppress the very first respawn and leave
    // the user staring at a stopped dot. Independent of the TTL check in
    // `spawn_llama_if_needed` (which guards against in-session stalls).
    if let Ok(p) = paths::paths() {
        let flag = p.data_dir.join(".llamacpp_suspended");
        if flag.is_file() {
            if std::fs::remove_file(&flag).is_ok() {
                tracing::info!("cleared stale llama-server suspend flag from previous session");
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarStatus {
    Stopped,
    Starting,
    Running,
    #[allow(dead_code)] // surfaced by future health failure paths
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SidecarState {
    pub python: SidecarStatus,
    pub node: SidecarStatus,
    pub ollama: SidecarStatus,
    #[serde(default = "default_status")]
    pub comfyui: SidecarStatus,
    /// v0.2.0 — llama.cpp llama-server on :8733. Coexists with `ollama`
    /// so the UI can show both dots; the backend abstraction
    /// (`llm_backend.py`) decides which one to call per request.
    #[serde(default = "default_status")]
    pub llamacpp: SidecarStatus,
}

#[allow(dead_code)] // serde default — reachable when older state JSONs deserialize
fn default_status() -> SidecarStatus { SidecarStatus::Stopped }

/// Tracks recent spawn failures so we don't spam-respawn a sidecar that keeps
/// crashing (e.g. port already bound by an orphaned process). After N failures
/// in M seconds we wait `cooldown` before trying again.
#[derive(Default)]
struct SpawnGuard {
    last_attempt: Option<std::time::Instant>,
    consecutive_fails: u32,
}

impl SpawnGuard {
    fn should_skip(&self) -> bool {
        let Some(last) = self.last_attempt else { return false; };
        let cooldown = std::time::Duration::from_secs(match self.consecutive_fails {
            0 => 0,
            1..=2 => 5,
            3..=5 => 15,
            _ => 30,
        });
        last.elapsed() < cooldown
    }
    fn record_attempt(&mut self) { self.last_attempt = Some(std::time::Instant::now()); }
    fn record_failure(&mut self) { self.consecutive_fails = self.consecutive_fails.saturating_add(1); }
    fn record_success(&mut self) { self.consecutive_fails = 0; }
}

pub struct Supervisor {
    state: Arc<Mutex<SidecarState>>,
    python_child: Arc<Mutex<Option<Child>>>,
    node_child: Arc<Mutex<Option<Child>>>,
    comfy_child: Arc<Mutex<Option<Child>>>,
    llama_child: Arc<Mutex<Option<Child>>>,
    python_guard: Arc<Mutex<SpawnGuard>>,
    node_guard: Arc<Mutex<SpawnGuard>>,
    comfy_guard: Arc<Mutex<SpawnGuard>>,
    llama_guard: Arc<Mutex<SpawnGuard>>,
    /// Set to `true` while a background `install_llamacpp` task is running.
    /// Prevents the health loop from kicking off a second auto-install while
    /// the first is still downloading the ~110 MB archive.
    llama_autoinstall_inflight: Arc<Mutex<bool>>,
    /// Set to `true` once `try_autoinstall_llamacpp` has fired this session.
    /// Without this guard a transient install failure (network drop, antivirus
    /// quarantine) would retry on every health tick (every 3 s) and DDoS the
    /// GitHub releases endpoint with our own client.
    llama_autoinstall_attempted: Arc<Mutex<bool>>,
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(SidecarState {
                python: SidecarStatus::Stopped,
                node: SidecarStatus::Stopped,
                ollama: SidecarStatus::Stopped,
                comfyui: SidecarStatus::Stopped,
                llamacpp: SidecarStatus::Stopped,
            })),
            python_child: Arc::new(Mutex::new(None)),
            node_child: Arc::new(Mutex::new(None)),
            comfy_child: Arc::new(Mutex::new(None)),
            llama_child: Arc::new(Mutex::new(None)),
            python_guard: Arc::new(Mutex::new(SpawnGuard::default())),
            node_guard: Arc::new(Mutex::new(SpawnGuard::default())),
            comfy_guard: Arc::new(Mutex::new(SpawnGuard::default())),
            llama_guard: Arc::new(Mutex::new(SpawnGuard::default())),
            llama_autoinstall_inflight: Arc::new(Mutex::new(false)),
            llama_autoinstall_attempted: Arc::new(Mutex::new(false)),
        }
    }

    #[allow(dead_code)] // public API — kept for tracing / future debug snapshots
    pub async fn snapshot(&self) -> SidecarState {
        self.state.lock().await.clone()
    }

    /// Eager probe + snapshot. Used by the topbar's `get_sidecar_state` query
    /// so the dots flip green within one poll interval, regardless of the
    /// health loop's sleep cadence.
    pub async fn probe_snapshot(&self) -> SidecarState {
        let py_ok = probe_python().await;
        let node_ok = probe_node().await;
        // v0.2.2 — Ollama is opt-in. When disabled we skip the probe so a
        // user with `ollama.exe` in PATH for unrelated reasons doesn't see
        // its dot light up in the topbar. Returning false here also keeps
        // the UI panel hidden via the explicit toggle gate on the frontend.
        let ollama_ok = if crate::app_settings::load().ollama_enabled {
            crate::installer::ollama::is_running().await
        } else {
            false
        };
        let comfy_ok = probe_comfyui().await;
        let llama_ok = probe_llamacpp().await;
        // Same tolerance logic as the health loop: child alive + port bound = Running.
        let py_alive = self.python_child.lock().await.is_some() && port_is_bound("127.0.0.1:8731").await;
        let node_alive = self.node_child.lock().await.is_some() && port_is_bound("127.0.0.1:8732").await;
        let comfy_alive = self.comfy_child.lock().await.is_some() && port_is_bound("127.0.0.1:8188").await;
        let llama_alive = self.llama_child.lock().await.is_some() && port_is_bound("127.0.0.1:8733").await;
        let mut s = self.state.lock().await;
        if py_ok || py_alive { s.python = SidecarStatus::Running; }
        if node_ok || node_alive { s.node = SidecarStatus::Running; }
        if ollama_ok { s.ollama = SidecarStatus::Running; }
        if comfy_ok || comfy_alive { s.comfyui = SidecarStatus::Running; }
        if llama_ok || llama_alive { s.llamacpp = SidecarStatus::Running; }
        s.clone()
    }

    /// Kick off all sidecars in the background. Best-effort.
    pub async fn start_all(&self) -> Result<()> {
        let _ = self.spawn_python_if_needed().await;
        let _ = self.spawn_node_if_needed().await;
        // v0.2.2 — Ollama is opt-in. Only `ensure_running` it when the
        // user explicitly toggled it from Settings. Without this gate
        // a stray `ollama.exe` left over from a v0.1.x install would
        // get auto-started on every app launch and silently reserve
        // VRAM the user expected to be free.
        if crate::app_settings::load().ollama_enabled {
            let _ = crate::installer::ollama::ensure_running().await;
        }
        let _ = self.spawn_llama_if_needed().await;
        let _ = self.spawn_comfyui_if_needed().await;
        Ok(())
    }

    /// Probe → if up, mark running. If not but a child handle exists, take and kill it.
    /// Then spawn fresh and remember the handle. Backoff on consecutive failures
    /// so we don't fork-bomb when something keeps crashing.
    async fn spawn_python_if_needed(&self) -> Result<()> {
        if probe_python().await {
            self.state.lock().await.python = SidecarStatus::Running;
            self.python_guard.lock().await.record_success();
            return Ok(());
        }
        if self.python_guard.lock().await.should_skip() {
            return Err(anyhow!("python sidecar in cooldown after repeated failures"));
        }
        self.python_guard.lock().await.record_attempt();
        self.kill_python_child().await;
        if port_is_bound("127.0.0.1:8731").await {
            self.python_guard.lock().await.record_failure();
            return Err(anyhow!(":8731 already bound by another process"));
        }
        match spawn_python().await {
            Ok(child) => {
                *self.python_child.lock().await = Some(child);
                self.state.lock().await.python = SidecarStatus::Starting;
                Ok(())
            }
            Err(e) => {
                self.python_guard.lock().await.record_failure();
                Err(e)
            }
        }
    }

    async fn spawn_node_if_needed(&self) -> Result<()> {
        if probe_node().await {
            self.state.lock().await.node = SidecarStatus::Running;
            self.node_guard.lock().await.record_success();
            return Ok(());
        }
        if self.node_guard.lock().await.should_skip() {
            return Err(anyhow!("node sidecar in cooldown"));
        }
        self.node_guard.lock().await.record_attempt();
        self.kill_node_child().await;
        if port_is_bound("127.0.0.1:8732").await {
            self.node_guard.lock().await.record_failure();
            return Err(anyhow!(":8732 already bound"));
        }
        match spawn_node().await {
            Ok(child) => {
                *self.node_child.lock().await = Some(child);
                self.state.lock().await.node = SidecarStatus::Starting;
                Ok(())
            }
            Err(e) => {
                self.node_guard.lock().await.record_failure();
                Err(e)
            }
        }
    }

    /// v0.2.0 — spawn llama-server if (a) the binary is installed and
    /// (b) an active model config (or a discoverable GGUF) is available.
    /// Returns Ok(()) on every path the user shouldn't see as an error —
    /// missing install or missing model is "feature not enabled yet",
    /// not "the supervisor crashed".
    async fn spawn_llama_if_needed(&self) -> Result<()> {
        // Fast-path: already responding on :8733.
        if probe_llamacpp().await {
            self.state.lock().await.llamacpp = SidecarStatus::Running;
            self.llama_guard.lock().await.record_success();
            return Ok(());
        }
        // v0.2.0 VRAM coordination — the Python sidecar drops a
        // `.llamacpp_suspended` sentinel at `<data_dir>/` when the
        // pipeline calls `/unload?target=llm` between phases. While that
        // flag exists we MUST NOT respawn llama-server, otherwise its
        // ~5 GB of VRAM would compete with ComfyUI / TTS for the GPU.
        // The next LLM call (from `LlamaCppBackend.chat`) deletes the
        // flag and we get spawned on the very next health-loop tick.
        //
        // v0.2.2 self-heal — TTL of `SUSPEND_FLAG_TTL_SECS`. If the
        // pipeline phase that was supposed to reclaim the LLM (music,
        // subtitles, shorts captions) crashes or simply never calls into
        // `LlamaCppBackend.chat()` (legacy clients, library-only music
        // path), the flag would stay forever and the user would see a
        // dead llama-server with no UI feedback. After the TTL elapses
        // we treat the flag as stale, remove it, and respawn. This
        // matches the "autoreparación" contract — the pipeline always
        // recovers without the user noticing.
        if let Ok(p) = crate::installer::paths::paths() {
            let flag = p.data_dir.join(".llamacpp_suspended");
            if flag.is_file() {
                let stale = std::fs::metadata(&flag)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map(|d| d.as_secs() > SUSPEND_FLAG_TTL_SECS)
                    .unwrap_or(false);
                if stale {
                    let _ = std::fs::remove_file(&flag);
                    tracing::warn!(
                        ttl_secs = SUSPEND_FLAG_TTL_SECS,
                        "llama-server suspend flag exceeded TTL — clearing and respawning"
                    );
                    // fall through to spawn path below
                } else {
                    self.state.lock().await.llamacpp = SidecarStatus::Stopped;
                    return Ok(());
                }
            }
        }
        // Auto-install path: if the binary isn't on disk yet but the user
        // already has an LLM-compatible GGUF (legacy v0.1.x install) or an
        // active model config (T4 model browser), download llama.cpp in the
        // background. The first health-loop tick that sees the binary on
        // disk will then spawn llama-server normally.
        let install = match crate::installer::llamacpp::detect_llamacpp() {
            Some(i) => i,
            None => {
                let want_install = crate::installer::llamacpp::read_active_config()
                    .ok()
                    .flatten()
                    .is_some()
                    || !crate::installer::llamacpp::discover_gguf_paths().is_empty();
                if want_install {
                    self.maybe_trigger_llama_autoinstall().await;
                } else {
                    self.state.lock().await.llamacpp = SidecarStatus::Stopped;
                }
                return Ok(());
            }
        };
        // Resolve the active model config. Fall back to a discovered GGUF
        // (legacy Ollama HF cache) so v0.1.x users land on a usable
        // default before T4's model browser writes a real config.
        let cfg = match crate::installer::llamacpp::read_active_config()? {
            Some(c) => c,
            None => match crate::installer::llamacpp::discover_default_config() {
                Some(c) => c,
                None => {
                    self.state.lock().await.llamacpp = SidecarStatus::Stopped;
                    tracing::info!(
                        "llama-server: no GGUF discovered yet — skipping spawn until T4 downloads one"
                    );
                    return Ok(());
                }
            },
        };
        if self.llama_guard.lock().await.should_skip() {
            return Err(anyhow!("llama.cpp in cooldown after repeated failures"));
        }
        self.llama_guard.lock().await.record_attempt();
        self.kill_llama_child().await;
        if port_is_bound("127.0.0.1:8733").await {
            self.llama_guard.lock().await.record_failure();
            return Err(anyhow!(":8733 already bound"));
        }
        match spawn_llama_server(&install.server_binary, &cfg).await {
            Ok(child) => {
                *self.llama_child.lock().await = Some(child);
                self.state.lock().await.llamacpp = SidecarStatus::Starting;
                Ok(())
            }
            Err(e) => {
                self.llama_guard.lock().await.record_failure();
                tracing::warn!(error = %e, "llama-server spawn failed");
                Err(e)
            }
        }
    }

    async fn spawn_comfyui_if_needed(&self) -> Result<()> {
        if probe_comfyui().await {
            self.state.lock().await.comfyui = SidecarStatus::Running;
            self.comfy_guard.lock().await.record_success();
            return Ok(());
        }
        if self.comfy_guard.lock().await.should_skip() {
            return Err(anyhow!("comfyui in cooldown"));
        }
        self.comfy_guard.lock().await.record_attempt();
        self.kill_comfy_child().await;
        if port_is_bound("127.0.0.1:8188").await {
            self.comfy_guard.lock().await.record_failure();
            return Err(anyhow!(":8188 already bound"));
        }
        match spawn_comfyui().await {
            Ok(child) => {
                *self.comfy_child.lock().await = Some(child);
                self.state.lock().await.comfyui = SidecarStatus::Starting;
                Ok(())
            }
            Err(e) => {
                self.comfy_guard.lock().await.record_failure();
                Err(e)
            }
        }
    }

    /// Force-restart the Python sidecar — used after installing optional
    /// components from Settings so the new pip package is importable without
    /// the user having to relaunch the app.
    pub async fn respawn_python(&self) {
        // Reset cooldown so the next spawn isn't blocked by a stale fail count.
        *self.python_guard.lock().await = SpawnGuard::default();
        self.kill_python_child().await;
        // Wait briefly for the kernel to release the port before the supervisor
        // health loop respawns.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _ = self.spawn_python_if_needed().await;
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

    async fn kill_llama_child(&self) {
        let mut guard = self.llama_child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    /// Trigger `install_llamacpp(pick_flavor())` in a background task IFF:
    ///   * we haven't already attempted it this session (avoid retry loops
    ///     on transient network failure)
    ///   * no install is in flight right now
    /// While the install runs the topbar dot shows `Starting` so the user
    /// gets feedback. When the install task finishes the next health-loop
    /// tick will `detect_llamacpp` and spawn `llama-server` normally.
    ///
    /// This is the canonical "autoinstalable" path the user asked for —
    /// llama.cpp behaves like the other runtimes (Python, Node, FFmpeg):
    /// the supervisor handles it without UI plumbing.
    async fn maybe_trigger_llama_autoinstall(&self) {
        {
            let attempted = self.llama_autoinstall_attempted.lock().await;
            if *attempted {
                self.state.lock().await.llamacpp = SidecarStatus::Stopped;
                return;
            }
        }
        {
            let inflight = self.llama_autoinstall_inflight.lock().await;
            if *inflight {
                self.state.lock().await.llamacpp = SidecarStatus::Starting;
                return;
            }
        }
        // Surface "starting" as soon as the download begins so the topbar
        // dot flips to gold while bytes stream. The health loop will flip
        // it to Running once /health on :8733 answers.
        self.state.lock().await.llamacpp = SidecarStatus::Starting;
        let inflight_flag = Arc::clone(&self.llama_autoinstall_inflight);
        let attempted_flag = Arc::clone(&self.llama_autoinstall_attempted);
        let state_for_task = Arc::clone(&self.state);
        tokio::spawn(async move {
            *inflight_flag.lock().await = true;
            let flavor = crate::installer::llamacpp::pick_flavor();
            tracing::info!(?flavor, "auto-installing llama.cpp in background");
            match crate::installer::llamacpp::install_llamacpp(flavor, None).await {
                Ok(inst) => {
                    tracing::info!(
                        flavor = ?inst.flavor,
                        binary = %inst.server_binary.display(),
                        "llama.cpp auto-install OK"
                    );
                }
                Err(e) => {
                    tracing::warn!(error = %e, "llama.cpp auto-install failed");
                    state_for_task.lock().await.llamacpp = SidecarStatus::Stopped;
                }
            }
            *inflight_flag.lock().await = false;
            *attempted_flag.lock().await = true;
        });
    }

    async fn kill_comfy_child(&self) {
        let mut guard = self.comfy_child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    /// v0.2.6 — Force kill + respawn ComfyUI.
    ///
    /// The pipeline's `ensure_comfyui_vram` calls this when ComfyUI's
    /// worker is wedged on a hung prompt (the Windows CUDA-Sysmem-fallback
    /// thrash failure: ≈958 s/step instead of ≈7 s/step). ComfyUI's
    /// async `/free` cannot recover a stuck worker — only a fresh process
    /// can. A new ComfyUI holds zero models, so the card returns to
    /// ~full free for the phase that needed the VRAM (Whisper, the
    /// thumbnail cold reload). Symmetric to `respawn_python`.
    pub async fn respawn_comfyui(&self) {
        // Reset the cooldown so the kill below isn't blocked by a stale
        // fail count, and the immediate respawn isn't skipped.
        *self.comfy_guard.lock().await = SpawnGuard::default();
        self.kill_comfy_child().await;
        // A worker stuck in a CUDA call can take a few seconds to die
        // after TerminateProcess; ComfyUI holds :8188 until the Python
        // process is fully gone. Wait for the port to release (≤10 s) so
        // the respawn doesn't bail with ":8188 already bound".
        for _ in 0..20 {
            if !port_is_bound("127.0.0.1:8188").await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let _ = self.spawn_comfyui_if_needed().await;
    }

    pub async fn run_health_loop(self: Arc<Self>) {
        loop {
            // v0.7.15 — probes en paralelo (antes secuencial). El probe de
            // ComfyUI puede tardar 1-2 s en healtcheck si está bajo carga;
            // sumado a python/node/llama secuenciales daba ~3-4 s por
            // tick. Con `tokio::join!` el ciclo dura ~max(per-probe),
            // mejora la latencia de los dots del topbar sin coste extra
            // (las probes son I/O, no compiten por CPU).
            let ollama_enabled = crate::app_settings::load().ollama_enabled;
            let (py_ok, node_ok, comfy_ok, llama_ok, ollama_ok) = tokio::join!(
                probe_python(),
                probe_node(),
                probe_comfyui(),
                probe_llamacpp(),
                async move {
                    if ollama_enabled {
                        crate::installer::ollama::is_running().await
                    } else {
                        false
                    }
                },
            );

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
            {
                let mut g = self.comfy_child.lock().await;
                if let Some(child) = g.as_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        *g = None;
                    }
                }
            }
            {
                let mut g = self.llama_child.lock().await;
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
            if !comfy_ok {
                let has_live = self.comfy_child.lock().await.is_some();
                if !has_live {
                    let _ = self.spawn_comfyui_if_needed().await;
                }
            }
            if !llama_ok {
                let has_live = self.llama_child.lock().await.is_some();
                if !has_live {
                    let _ = self.spawn_llama_if_needed().await;
                }
            }

            // A "busy" sidecar (e.g. Python mid-TTS torch.generate) may not respond
            // to /health within the probe timeout, but it's still alive and serving.
            // If the child handle is live AND the port is bound, treat it as Running
            // so the UI doesn't flash STOPPED during heavy GPU work.
            let py_child_alive = self.python_child.lock().await.is_some();
            let node_child_alive = self.node_child.lock().await.is_some();
            let comfy_child_alive = self.comfy_child.lock().await.is_some();
            let llama_child_alive = self.llama_child.lock().await.is_some();
            let py_port = port_is_bound("127.0.0.1:8731").await;
            let node_port = port_is_bound("127.0.0.1:8732").await;
            let comfy_port = port_is_bound("127.0.0.1:8188").await;
            let llama_port = port_is_bound("127.0.0.1:8733").await;

            {
                let mut s = self.state.lock().await;
                s.python = if py_ok || (py_child_alive && py_port) {
                    SidecarStatus::Running
                } else { SidecarStatus::Stopped };
                s.node = if node_ok || (node_child_alive && node_port) {
                    SidecarStatus::Running
                } else { SidecarStatus::Stopped };
                s.ollama = if ollama_ok { SidecarStatus::Running } else { SidecarStatus::Stopped };
                // ComfyUI starts slowly (~30s). If we hold a live child but probe is
                // still false, mark as Starting (not Stopped) so the UI doesn't flicker.
                s.comfyui = if comfy_ok || (comfy_child_alive && comfy_port) {
                    SidecarStatus::Running
                } else if comfy_child_alive {
                    SidecarStatus::Starting
                } else {
                    SidecarStatus::Stopped
                };
                // llama-server: model loading can take 10-30 s on first spawn
                // (mmap + GPU layer offload). Same Starting fallback as Comfy.
                s.llamacpp = if llama_ok || (llama_child_alive && llama_port) {
                    SidecarStatus::Running
                } else if llama_child_alive {
                    SidecarStatus::Starting
                } else {
                    SidecarStatus::Stopped
                };
            }

            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
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

async fn probe_comfyui() -> bool {
    reqwest::Client::new()
        .get("http://127.0.0.1:8188/system_stats")
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn probe_llamacpp() -> bool {
    // llama-server's /health returns 200 once the model is fully loaded
    // and 503 while it's still mmapping / offloading layers. Either is a
    // sign that the process is live and serving — we treat both as "up"
    // so the UI doesn't flap during the 10-30 s warmup window.
    reqwest::Client::new()
        .get("http://127.0.0.1:8733/health")
        .timeout(std::time::Duration::from_secs(1))
        .send()
        .await
        .map(|r| {
            let s = r.status().as_u16();
            s == 200 || s == 503
        })
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
    // Always use the central data_dir music library so the user's added tracks
    // (via the Settings UI) are visible to the sidecar. The bootstrap step in
    // commands::music seeds this dir from the workspace bundle on first run.
    let assets_music = paths::paths()
        .map(|p| p.data_dir.join("assets").join("music"))
        .unwrap_or_else(|_| std::path::PathBuf::from("./assets/music"));
    let out_dir = paths::paths()?.data_dir.join("projects");
    let _ = std::fs::create_dir_all(&out_dir);

    let log = open_log("sidecar-py.log")?;
    let log_err = log.try_clone()?;

    tracing::info!(server = %server.display(), "spawning python sidecar");
    let comfy_dir = paths::paths()?.data_dir.join("runtime").join("comfyui");
    let hf_home = paths::paths()?.data_dir.join("hf-cache");
    // Seed HF cache from the user's standard ~/.cache/huggingface/hub before
    // spawning so already-downloaded models (Whisper, Z-Image, Qwen TTS, etc.)
    // don't get re-downloaded into our isolated data_dir cache. Hardlinks
    // when possible (zero disk overhead), copy fallback. Idempotent.
    hf_seed::seed_from_user_cache(&hf_home);
    // v0.2.2 — LLM backend is llama.cpp by default and ONLY. Ollama is
    // available behind an explicit opt-in (Settings → "Activar Ollama"),
    // which flips `app-settings.json::ollama_enabled` and respawns this
    // sidecar with `XIANXIA_LLM_BACKEND=ollama`. The previous "auto"
    // mode silently fell back to Ollama whenever the llama-server
    // health probe failed, which contradicted the product promise that
    // llama.cpp is the always-on runtime and Ollama is a strict
    // alternative. If llama-server is genuinely unreachable we surface
    // it as a backend error instead of switching engines mid-pipeline.
    //
    // Explicit env override (`XIANXIA_LLM_BACKEND=...` exported by the
    // user or a dev launch script) still takes precedence — it's the
    // tester escape hatch.
    let llm_backend = std::env::var("XIANXIA_LLM_BACKEND").unwrap_or_else(|_| {
        if crate::app_settings::load().ollama_enabled {
            "ollama".to_string()
        } else {
            "llamacpp".to_string()
        }
    });
    let child = Command::new(&py)
        .arg(&server)
        .current_dir(&cwd)
        .env("PATH", augmented_path())
        .env("PYTHONPATH", cwd.join("src"))
        .env("XIANXIA_MUSIC_DIR", assets_music)
        .env("XIANXIA_OUT_DIR", out_dir)
        .env("HF_HOME", &hf_home)
        .env("HF_HUB_ENABLE_HF_TRANSFER", "1")
        // Always prefer the ComfyUI path (faster, supports GGUF auto-detection
        // for 8 GB cards). The Python /image route falls back to diffusers
        // automatically if ComfyUI isn't reachable on :8188.
        .env("XIANXIA_USE_COMFYUI", "1")
        .env("XIANXIA_COMFY_DIR", comfy_dir)
        .env("XIANXIA_LLM_BACKEND", &llm_backend)
        .env("XIANXIA_LLAMACPP_URL", "http://127.0.0.1:8733")
        .env("XIANXIA_OLLAMA_URL", "http://127.0.0.1:11434")
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .hide_console()
        .spawn()?;
    Ok(child)
}

/// Spawn `llama-server` with the flags derived from `LlmModelConfig`.
///
/// All flags come from the config; nothing is hardcoded in this function
/// so the model browser (T4) is the single source of truth for performance
/// tuning. Errors here are visible to the supervisor — they roll up into
/// `record_failure()` and trigger backoff so a broken config never starves
/// the rest of the pipeline.
async fn spawn_llama_server(
    binary: &std::path::Path,
    cfg: &crate::installer::llamacpp::LlmModelConfig,
) -> Result<Child> {
    if !binary.is_file() {
        return Err(anyhow!(
            "llama-server binary missing at {} — run the install wizard",
            binary.display()
        ));
    }
    let gguf = PathBuf::from(&cfg.gguf_path);
    if !gguf.is_file() {
        return Err(anyhow!(
            "GGUF file missing at {} — model was moved or never downloaded",
            gguf.display()
        ));
    }

    let log = open_log("llama-server.log")?;
    let log_err = log.try_clone()?;
    let args = cfg.to_args();

    tracing::info!(
        binary = %binary.display(),
        model = %gguf.display(),
        context = cfg.context_size,
        ngl = cfg.gpu_layers,
        "spawning llama-server :8733",
    );

    // On Windows CUDA, llama-server.exe needs cudart DLLs next to it. The
    // T2 installer extracts them into the same directory so a plain Command
    // launch works — Windows' DLL search starts from the exe's directory.
    let cwd = binary.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| std::path::PathBuf::from("."));

    let child = Command::new(binary)
        .args(&args)
        .current_dir(&cwd)
        .env("PATH", augmented_path())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .hide_console()
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
        .env("PATH", augmented_path())
        .env("XIANXIA_NODE_PORT", "8732")
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .hide_console()
        .spawn()?;
    Ok(child)
}

async fn spawn_comfyui() -> Result<Child> {
    let py = python_env::python_exe_resolved()?;
    if !py.exists() {
        return Err(anyhow!("python not installed: {}", py.display()));
    }
    let comfy_dir = paths::paths()?.data_dir.join("runtime").join("comfyui");
    let main_py = comfy_dir.join("main.py");
    if !main_py.exists() {
        return Err(anyhow!(
            "ComfyUI main.py missing at {}; run the installer wizard first",
            main_py.display()
        ));
    }
    let log = open_log("comfyui.log")?;
    let log_err = log.try_clone()?;

    tracing::info!(dir = %comfy_dir.display(), "spawning ComfyUI :8188");
    let child = Command::new(&py)
        .arg(&main_py)
        .arg("--port").arg("8188")
        .arg("--listen").arg("127.0.0.1")
        .arg("--disable-auto-launch")
        // Enable CORS so the browser-mode shim and our own UI can probe
        // /system_stats from the Vite origin (http://localhost:1420). In Tauri
        // webview there's no CORS gate, but we want dev parity.
        .arg("--enable-cors-header").arg("*")
        .current_dir(&comfy_dir)
        .env("PATH", augmented_path())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .hide_console()
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
    // Eager re-probe so the topbar dots flip green within one poll interval.
    Ok(sup.probe_snapshot().await)
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
