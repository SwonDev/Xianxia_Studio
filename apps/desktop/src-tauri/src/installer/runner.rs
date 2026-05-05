//! Install orchestrator. Walks the manifest in dependency order, executes each
//! component's action, and emits `install:progress` events to the frontend.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use tokio::sync::Mutex;

use super::manifest::{full_manifest, with_llm_for_tier, AssetKind, Component};
use super::paths;
use super::{InstallProgress, ProgressStatus};

#[derive(Default, Clone, Serialize)]
pub struct InstallReport {
    pub completed: Vec<String>,
    pub failed: Vec<String>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct InstallOptions {
    pub llm_hf_repo: String,
    pub llm_gguf_file: String,
    pub llm_label: String,
    pub llm_abliterated: bool,
    pub llm_size_bytes: u64,
    /// Source workspace path so we can resolve `apps/sidecar-py/...` etc. in dev.
    pub workspace_root: Option<String>,
}

#[tauri::command]
pub async fn run_install(app: AppHandle, options: InstallOptions) -> Result<InstallReport, String> {
    do_install(app, options).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_install_manifest(options: InstallOptions) -> Vec<Component> {
    let base = full_manifest();
    with_llm_for_tier(
        base,
        &options.llm_hf_repo,
        &options.llm_gguf_file,
        &options.llm_label,
        options.llm_abliterated,
        options.llm_size_bytes,
    )
}

async fn do_install(app: AppHandle, options: InstallOptions) -> Result<InstallReport> {
    let report = std::sync::Arc::new(Mutex::new(InstallReport::default()));
    let components = get_install_manifest(options.clone());
    let workspace = options.workspace_root.as_deref().map(Path::new);

    for component in &components {
        let res = install_one(&app, component, workspace).await;
        let mut r = report.lock().await;
        match res {
            Ok(()) => {
                emit(&app, &component.id, ProgressStatus::Done, 100.0, "Listo");
                r.completed.push(component.id.clone());
            }
            Err(e) => {
                emit(
                    &app,
                    &component.id,
                    ProgressStatus::Failed,
                    0.0,
                    &format!("Error: {}", e),
                );
                tracing::error!(component = %component.id, error = %e, "install step failed");
                r.failed.push(component.id.clone());
                if component.required {
                    let _ = app.emit("install:done", r.clone());
                    return Ok(r.clone());
                }
            }
        }
    }

    let final_report = report.lock().await.clone();
    let _ = app.emit("install:done", &final_report);
    Ok(final_report)
}

async fn install_one(app: &AppHandle, c: &Component, workspace: Option<&Path>) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Pending, 0.0, "Preparando…");

    // ─── Auto-detect: skip download if a compatible system tool is found ────
    if should_skip_via_autodetect(c) {
        emit(app, &c.id, ProgressStatus::Done, 100.0, "Detectado en el sistema, saltado");
        return Ok(());
    }

    match &c.kind {
        AssetKind::PythonEmbed
        | AssetKind::NodeEmbed
        | AssetKind::FfmpegBinary
        | AssetKind::OllamaInstaller => {
            install_archive_component(app, c).await
        }
        AssetKind::CopySidecar { source, dest } => {
            copy_sidecar(app, c, workspace, source, dest).await
        }
        AssetKind::PipInstall { requirements } => {
            pip_install(app, c, workspace, requirements).await
        }
        AssetKind::NpmInstall { workdir } => {
            npm_install(app, c, workdir).await
        }
        AssetKind::HyperFramesInstall => {
            hyperframes_install(app, c).await
        }
        AssetKind::BuildSidecarNode => {
            build_sidecar_node(app, c).await
        }
        AssetKind::HuggingfaceFile { repo, filename, target } => {
            hf_download(app, c, repo, Some(filename), target).await
        }
        AssetKind::HuggingfaceSnapshot { repo, target } => {
            hf_download(app, c, repo, None, target).await
        }
        AssetKind::OllamaCreate { gguf_relative_path, model_name, abliterated } => {
            ollama_create(app, c, gguf_relative_path, model_name, *abliterated).await
        }
        AssetKind::OllamaStart => {
            super::ollama::ensure_running().await
        }
        AssetKind::SmokeTest => {
            smoke_test(app, c).await
        }
    }
}

async fn install_archive_component(app: &AppHandle, c: &Component) -> Result<()> {
    let url = pick_url(c);
    let temp = paths::temp_dir()?.join(format!("{}.bin", c.id));

    emit(app, &c.id, ProgressStatus::Downloading, 0.0, "Descargando…");

    let cid = c.id.clone();
    let app_clone = app.clone();
    super::downloader::download(
        &url,
        &temp,
        c.sha256.as_deref(),
        Some(Box::new(move |done, total| {
            let _ = app_clone.emit(
                "install:progress",
                InstallProgress {
                    component: cid.clone(),
                    status: ProgressStatus::Downloading,
                    bytes_done: done,
                    bytes_total: total,
                    percent: if total > 0 { (done as f64 / total as f64) * 100.0 } else { 0.0 },
                    message: format!("{} / {}", human(done), human(total)),
                },
            );
        })),
    )
    .await?;

    emit(app, &c.id, ProgressStatus::Installing, 90.0, "Extrayendo…");

    match c.kind {
        AssetKind::PythonEmbed => {
            let target = paths::python_dir()?;
            std::fs::create_dir_all(&target)?;
            super::python_env::extract_targz(&temp, &target)?;
        }
        AssetKind::NodeEmbed => {
            let target = paths::node_dir()?;
            std::fs::create_dir_all(&target)?;
            #[cfg(target_os = "windows")]
            super::python_env::extract_zip(&temp, &target)?;
            #[cfg(not(target_os = "windows"))]
            extract_tar_xz_or_gz(&temp, &target)?;
        }
        AssetKind::FfmpegBinary => {
            let target = paths::ffmpeg_dir()?;
            std::fs::create_dir_all(&target)?;
            if super::python_env::extract_zip(&temp, &target).is_err() {
                extract_tar_xz_or_gz(&temp, &target)?;
            }
        }
        AssetKind::OllamaInstaller => {
            #[cfg(target_os = "windows")]
            {
                let status = std::process::Command::new(&temp).arg("/SILENT").status()?;
                if !status.success() {
                    return Err(anyhow!("ollama installer exit {}", status));
                }
            }
            #[cfg(target_os = "linux")]
            {
                let status = std::process::Command::new("sh").arg(&temp).status()?;
                if !status.success() {
                    return Err(anyhow!("ollama install.sh exit {}", status));
                }
            }
            #[cfg(target_os = "macos")]
            {
                let target = paths::runtime_dir()?.join("ollama");
                super::python_env::extract_zip(&temp, &target)?;
            }
        }
        _ => unreachable!(),
    }
    let _ = std::fs::remove_file(&temp);
    Ok(())
}

async fn copy_sidecar(
    app: &AppHandle,
    c: &Component,
    workspace: Option<&Path>,
    source: &str,
    dest: &str,
) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Installing, 50.0, "Copiando ficheros…");
    let src = resolve_workspace(workspace, &format!("apps/{}", source))
        .ok_or_else(|| anyhow!("source not found: apps/{}", source))?;
    let dst = paths::runtime_dir()?.join(dest);
    if dst.exists() {
        // best-effort cleanup
        let _ = std::fs::remove_dir_all(&dst);
    }
    copy_dir_recursive(&src, &dst)?;
    Ok(())
}

async fn pip_install(
    app: &AppHandle,
    c: &Component,
    workspace: Option<&Path>,
    requirements_rel: &str,
) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Installing, 10.0, "pip install (puede tardar)…");
    let py = super::python_env::python_exe()?;
    if !py.exists() {
        return Err(anyhow!("python no instalado: {}", py.display()));
    }
    super::python_env::ensure_pip(&py).await?;

    // Resolve requirements: prefer the copy in runtime/sidecar-py (if already
    // copied), fall back to apps/sidecar-py/... in the dev workspace.
    let runtime_req = paths::runtime_dir()?.join(requirements_rel);
    let req_path = if runtime_req.exists() {
        runtime_req
    } else if let Some(p) = resolve_workspace(workspace, &format!("apps/{}", requirements_rel)) {
        p
    } else {
        return Err(anyhow!("requirements file not found: {}", requirements_rel));
    };

    super::python_env::pip_install(&py, &req_path).await?;
    Ok(())
}

async fn npm_install(app: &AppHandle, c: &Component, workdir: &str) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Installing, 10.0, "npm install…");
    let node_bin = node_executable()?;
    let npm_cli = node_bin.parent().unwrap().join(npm_cli_relative());
    let cwd = paths::runtime_dir()?.join(workdir);
    if !cwd.exists() {
        return Err(anyhow!("workdir missing: {}", cwd.display()));
    }
    let status = Command::new(&node_bin)
        .arg(&npm_cli)
        .arg("install")
        .arg("--no-audit")
        .arg("--no-fund")
        .current_dir(&cwd)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .context("npm install failed to spawn")?;
    if !status.success() {
        return Err(anyhow!("npm install in {} failed", cwd.display()));
    }
    Ok(())
}

async fn hyperframes_install(app: &AppHandle, c: &Component) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Installing, 10.0, "Instalando HyperFrames…");
    let node_bin = node_executable()?;
    let npm_cli = node_bin.parent().unwrap().join(npm_cli_relative());
    let prefix = paths::runtime_dir()?.join("npm-global");
    std::fs::create_dir_all(&prefix)?;
    let status = Command::new(&node_bin)
        .arg(&npm_cli)
        .args(["install", "-g", "hyperframes", "--prefix"])
        .arg(&prefix)
        .args(["--no-audit", "--no-fund"])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .context("npm install -g hyperframes failed")?;
    if !status.success() {
        return Err(anyhow!("hyperframes install failed"));
    }
    Ok(())
}

async fn build_sidecar_node(app: &AppHandle, c: &Component) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Installing, 30.0, "Compilando TypeScript…");
    let node_bin = node_executable()?;
    let npm_cli = node_bin.parent().unwrap().join(npm_cli_relative());
    let cwd = paths::runtime_dir()?.join("sidecar-node");
    let status = Command::new(&node_bin)
        .arg(&npm_cli)
        .args(["run", "build"])
        .current_dir(&cwd)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await?;
    if !status.success() {
        return Err(anyhow!("sidecar-node build failed"));
    }
    Ok(())
}

async fn hf_download(
    app: &AppHandle,
    c: &Component,
    repo: &str,
    filename: Option<&str>,
    target_rel: &str,
) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Downloading, 5.0, "Esperando sidecar Python…");
    // The sidecar must be alive — start it on demand if not.
    crate::sidecars::ensure_python_sidecar().await?;

    let target = paths::paths()?.data_dir.join(target_rel);
    std::fs::create_dir_all(&target)?;

    emit(app, &c.id, ProgressStatus::Downloading, 10.0, "Descargando desde HuggingFace…");
    let mut body = serde_json::json!({
        "repo": repo,
        "target_dir": target.to_string_lossy(),
    });
    if let Some(f) = filename {
        body["filename"] = serde_json::Value::String(f.to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 60 * 6))
        .build()?;
    let resp = client
        .post("http://127.0.0.1:8731/install/hf-download")
        .json(&body)
        .send()
        .await?
        .error_for_status()
        .context("hf download failed")?;
    let _data: serde_json::Value = resp.json().await?;
    Ok(())
}

async fn ollama_create(
    app: &AppHandle,
    c: &Component,
    gguf_rel: &str,
    model_name: &str,
    abliterated: bool,
) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Installing, 30.0, "Creando modelo en Ollama…");
    super::ollama::ensure_running().await?;
    let gguf_abs = paths::paths()?.data_dir.join(gguf_rel);
    crate::sidecars::ensure_python_sidecar().await?;
    let client = reqwest::Client::new();
    client
        .post("http://127.0.0.1:8731/install/ollama-create")
        .json(&serde_json::json!({
            "model_name": model_name,
            "gguf_path": gguf_abs.to_string_lossy(),
            "abliterated": abliterated,
        }))
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn smoke_test(app: &AppHandle, c: &Component) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Verifying, 50.0, "Pingueando servicios…");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    // Ollama
    if !client
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
    {
        return Err(anyhow!("Ollama no responde en :11434"));
    }
    // Python sidecar
    if !client
        .get("http://127.0.0.1:8731/health")
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
    {
        return Err(anyhow!("Python sidecar no responde en :8731"));
    }
    // Node sidecar (if running — best effort, can start lazily on first render)
    let _ = client.get("http://127.0.0.1:8732/health").send().await;
    Ok(())
}

// ─── helpers ────────────────────────────────────────────────────────

fn should_skip_via_autodetect(c: &Component) -> bool {
    use super::detect;
    match c.kind {
        AssetKind::PythonEmbed => detect::detect_python().compatible,
        AssetKind::NodeEmbed => detect::detect_node().compatible,
        AssetKind::FfmpegBinary => detect::detect_ffmpeg().compatible,
        AssetKind::OllamaInstaller => detect::detect_ollama().installed,
        _ => false,
    }
}

fn pick_url(c: &Component) -> String {
    #[cfg(target_os = "macos")]
    if let Some(u) = &c.url_macos {
        return u.clone();
    }
    #[cfg(target_os = "linux")]
    if let Some(u) = &c.url_linux {
        return u.clone();
    }
    c.url.clone()
}

fn resolve_workspace(workspace: Option<&Path>, rel: &str) -> Option<PathBuf> {
    if let Some(ws) = workspace {
        let p = ws.join(rel);
        if p.exists() {
            return Some(strip_ext(p));
        }
    }
    // Try to discover the workspace from CARGO_MANIFEST_DIR (dev mode).
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let candidate = Path::new(manifest)
            .join("..")
            .join("..")
            .join("..")
            .join(rel);
        if candidate.exists() {
            return Some(strip_ext(candidate));
        }
    }
    // Try relative to current_exe
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(rel);
            if candidate.exists() {
                return Some(strip_ext(candidate));
            }
        }
    }
    None
}

fn strip_ext(p: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let name = entry.file_name();
        // skip noise: node_modules, __pycache__, dist, target, .venv
        let name_str = name.to_string_lossy();
        if matches!(
            name_str.as_ref(),
            "node_modules" | "__pycache__" | "dist" | "target" | ".venv" | ".pytest_cache" | ".ruff_cache"
        ) {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        if ty.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn extract_tar_xz_or_gz(archive: &Path, target: &Path) -> Result<()> {
    // Try gz first
    if super::python_env::extract_targz(archive, target).is_ok() {
        return Ok(());
    }
    // Fallback to system tar for xz (xz2 crate skipped to keep deps light)
    let status = std::process::Command::new("tar")
        .args(["-xf", archive.to_str().unwrap(), "-C", target.to_str().unwrap()])
        .status()?;
    if !status.success() {
        return Err(anyhow!("tar extraction failed for {}", archive.display()));
    }
    Ok(())
}

fn node_executable() -> Result<PathBuf> {
    let dir = paths::node_dir()?;
    #[cfg(target_os = "windows")]
    {
        // node-v22.12.0-win-x64/node.exe — folder name varies, glob it
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                let candidate = entry.path().join("node.exe");
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                let candidate = entry.path().join("bin").join("node");
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
    }
    // Fallback to PATH if portable not found
    which::which("node").map_err(|e| anyhow!("node not found: {}", e))
}

fn npm_cli_relative() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "node_modules\\npm\\bin\\npm-cli.js"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "../lib/node_modules/npm/bin/npm-cli.js"
    }
}

fn emit(app: &AppHandle, component: &str, status: ProgressStatus, percent: f64, msg: &str) {
    let _ = app.emit(
        "install:progress",
        InstallProgress {
            component: component.to_string(),
            status,
            bytes_done: 0,
            bytes_total: 0,
            percent,
            message: msg.to_string(),
        },
    );
}

fn human(b: u64) -> String {
    let f = b as f64;
    if f >= 1_073_741_824.0 {
        format!("{:.1} GB", f / 1_073_741_824.0)
    } else if f >= 1_048_576.0 {
        format!("{:.1} MB", f / 1_048_576.0)
    } else if f >= 1024.0 {
        format!("{:.1} KB", f / 1024.0)
    } else {
        format!("{} B", b)
    }
}
