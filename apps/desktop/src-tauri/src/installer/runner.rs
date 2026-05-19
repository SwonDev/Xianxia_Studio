//! Install orchestrator. Walks the manifest in dependency order, executes each
//! component's action, and emits `install:progress` events to the frontend.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;
use tokio::sync::Mutex;

use super::manifest::{full_manifest, with_llm_for_tier, AssetKind, Component};
use super::paths;
use super::{InstallProgress, ProgressStatus};
use crate::process_ext::HideConsole;

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

/// Install ONE component by id (for "Optional features" cards in Settings).
/// Pulls the component definition out of the full manifest, runs `install_one`,
/// emits standard `install:progress` events, and returns success/failure.
///
/// After a successful install we ALSO bounce the Python sidecar via the
/// supervisor so the new package is picked up without a manual restart.
#[tauri::command]
pub async fn install_optional_component(
    app: AppHandle,
    component_id: String,
) -> Result<bool, String> {
    do_install_optional(app, component_id)
        .await
        .map_err(|e| e.to_string())
}

async fn do_install_optional(app: AppHandle, component_id: String) -> Result<bool> {
    let manifest = full_manifest();
    let component = manifest
        .iter()
        .find(|c| c.id == component_id)
        .cloned()
        .ok_or_else(|| anyhow!("component not found: {}", component_id))?;

    let workspace = workspace_root_for_install();
    let res = install_one(&app, &component, workspace.as_deref()).await;
    match res {
        Ok(()) => {
            emit(&app, &component.id, ProgressStatus::Done, 100.0, "Listo");
            // Restart Python sidecar so the new pip package is importable.
            // The supervisor's health loop will respawn it within ~3 s.
            if let Some(sup) = app.try_state::<std::sync::Arc<crate::sidecars::Supervisor>>() {
                sup.respawn_python().await;
            }
            Ok(true)
        }
        Err(e) => {
            emit(
                &app,
                &component.id,
                ProgressStatus::Failed,
                0.0,
                &format!("Error: {}", e),
            );
            Err(e)
        }
    }
}

/// Best-effort workspace discovery for in-app component installs (without
/// the wizard's `InstallOptions` passing it explicitly).
fn workspace_root_for_install() -> Option<std::path::PathBuf> {
    if let Ok(cargo_root) = std::env::var("CARGO_MANIFEST_DIR") {
        let p = std::path::PathBuf::from(cargo_root);
        // src-tauri → up 2 levels to repo root
        if let Some(repo) = p.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            if repo.join("apps").exists() {
                return Some(repo.to_path_buf());
            }
        }
    }
    None
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
        AssetKind::GitClone { repo_url, target } => {
            git_clone(app, c, repo_url, target).await
        }
        AssetKind::HuggingfaceFileTo { repo, filename, target_path } => {
            hf_file_to(app, c, repo, filename, target_path).await
        }
        AssetKind::DepthFlowVenv => {
            depthflow_venv_install(app, c).await
        }
        AssetKind::AceStepVenv => {
            acestep_venv_install(app, c).await
        }
        AssetKind::Ltx23VideoInstall => {
            // v0.6.0 Task 3: component declared; runner logic implemented in Task 4.
            // This arm prevents a non-exhaustive match error at compile time.
            // The component is opt-in and tier-gated; it should never reach
            // this branch until the full runner implementation lands.
            Err(anyhow!("ltx23-video runner not yet implemented (Task 4)"))
        }
    }
}

/// v0.1.38 — provisions an isolated Python venv at
/// `runtime/depthflow-venv/` and installs DepthFlow inside it.
///
/// Why a venv (and not the main runtime python):
/// DepthFlow's `pip install depthflow` upgrades torch / transformers /
/// pillow / numpy in ways that conflict with the main sidecar's deps
/// (qwen-tts, audiocraft, rembg). Tested and verified during
/// v0.1.38 development: a single shared install breaks TTS + music +
/// rembg silently. Isolation keeps each tool happy.
///
/// Auto-detection downstream: `/depthflow/health` returns
/// `venv_python_exists=false` when this component hasn't run, so the
/// pipeline gracefully falls back to single-image + Ken Burns. The user
/// can install this component later from the wizard at any time.
async fn depthflow_venv_install(app: &AppHandle, c: &Component) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Installing, 5.0, "Creando venv aislado para DepthFlow…");

    let main_py = super::python_env::python_exe()?;
    if !main_py.exists() {
        return Err(anyhow!("python embebido no instalado: {}", main_py.display()));
    }
    super::python_env::ensure_pip(&main_py).await?;

    let venv_dir = paths::runtime_dir()?.join("depthflow-venv");
    let venv_py = if cfg!(windows) {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    };

    // Skip the heavy work if a previous run already produced a working venv.
    if venv_py.exists() {
        // Quick sanity probe: can we import depthflow? If yes, we're done.
        let probe = std::process::Command::new(&venv_py)
            .args(["-c", "import depthflow"])
            .output();
        if let Ok(out) = probe {
            if out.status.success() {
                emit(app, &c.id, ProgressStatus::Done, 100.0, "DepthFlow ya instalado, saltado");
                return Ok(());
            }
        }
        tracing::warn!(
            venv = %venv_dir.display(),
            "DepthFlow venv exists but `import depthflow` failed — reinstalling",
        );
    }

    // ── Step 1: create the venv (or repair it). ────────────────────────
    if !venv_py.exists() {
        emit(app, &c.id, ProgressStatus::Installing, 10.0, "python -m venv …");
        let venv_out = std::process::Command::new(&main_py)
            .args(["-m", "venv", venv_dir.to_str().unwrap_or("")])
            .output()
            .map_err(|e| anyhow!("falló crear venv: {}", e))?;
        if !venv_out.status.success() {
            let tail = String::from_utf8_lossy(&venv_out.stderr);
            return Err(anyhow!("python -m venv falló: {}", tail));
        }
        if !venv_py.exists() {
            return Err(anyhow!("venv creado pero python no encontrado en {}", venv_py.display()));
        }
    }

    // ── Step 2: ensure pip is recent in the venv. ──────────────────────
    emit(app, &c.id, ProgressStatus::Installing, 20.0, "Actualizando pip del venv…");
    let _ = std::process::Command::new(&venv_py)
        .args(["-m", "pip", "install", "--upgrade", "--quiet", "pip", "wheel", "setuptools"])
        .output();

    // ── Step 3: install torch CUDA 12.1 BEFORE depthflow so depthflow's
    //   own auto-installer doesn't pick a CPU wheel or a CUDA wheel that
    //   doesn't match our embedded driver tier. We pin to torch 2.5.1
    //   which is the same version the main runtime uses — sharing the
    //   exact build avoids surprising VRAM allocator differences when
    //   DepthFlow loads its Depth-Anything-V2 model alongside ComfyUI's
    //   Z-Image model on the same GPU.
    emit(app, &c.id, ProgressStatus::Installing, 35.0, "Instalando PyTorch CUDA 12.1 (~2.5 GB)…");
    let torch_out = std::process::Command::new(&venv_py)
        .args([
            "-m", "pip", "install", "--quiet",
            "torch==2.5.1",
            "torchvision==0.20.1",
            "torchaudio==2.5.1",
            "--index-url", "https://download.pytorch.org/whl/cu121",
        ])
        .output()
        .map_err(|e| anyhow!("torch install falló: {}", e))?;
    if !torch_out.status.success() {
        let tail = String::from_utf8_lossy(&torch_out.stderr);
        return Err(anyhow!("torch install: {}", tail));
    }

    // ── Step 4: install DepthFlow. depthflow itself + shaderflow +
    //   broken-source + a moderngl context get pulled in. License: AGPL-3.0
    //   (the user is informed at component-add time via the manifest's
    //   label).
    emit(app, &c.id, ProgressStatus::Installing, 75.0, "Instalando DepthFlow…");
    let df_out = std::process::Command::new(&venv_py)
        .args(["-m", "pip", "install", "--quiet", "depthflow"])
        .output()
        .map_err(|e| anyhow!("depthflow install falló: {}", e))?;
    if !df_out.status.success() {
        let tail = String::from_utf8_lossy(&df_out.stderr);
        return Err(anyhow!("depthflow install: {}", tail));
    }

    // ── Step 5: smoke-test the import. ─────────────────────────────────
    emit(app, &c.id, ProgressStatus::Installing, 95.0, "Verificando instalación…");
    let probe = std::process::Command::new(&venv_py)
        .args(["-c", "from depthflow.scene import DepthScene; print('OK')"])
        .output()
        .map_err(|e| anyhow!("smoke probe falló: {}", e))?;
    if !probe.status.success() {
        let tail = String::from_utf8_lossy(&probe.stderr);
        return Err(anyhow!("DepthScene import falló: {}", tail));
    }

    emit(app, &c.id, ProgressStatus::Done, 100.0, "DepthFlow listo");
    Ok(())
}

/// v0.2.8 — provisions ACE-Step v1.5 in an isolated venv at
/// `runtime/acestep-venv/` + the repo at `runtime/acestep-repo/`.
///
/// Why isolated (same rationale as DepthFlow): ACE-Step-1.5 @ v0.1.7
/// hard-pins `torch==2.7.1+cu128` + a local-editable `nano-vllm` +
/// flash-attn / transformers>=4.51 which would shred the main sidecar's
/// torch 2.5.1+cu121 stack. The music phase auto-detects this venv and
/// falls back MusicGen → library when absent, so skipping this component
/// keeps the app fully functional — it just uses the lighter generator.
///
/// Steps mirror `depthflow_venv_install`: create venv → modern pip →
/// torch cu128 → git clone repo @ tag → editable installs → smoke test.
/// flash-attn is intentionally NOT installed (the runner passes
/// `use_flash_attention=False`); it's optional and its Windows build is
/// fragile, so we skip it to keep the install robust.
async fn acestep_venv_install(app: &AppHandle, c: &Component) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Installing, 3.0, "Creando venv aislado para ACE-Step v1.5…");

    let main_py = super::python_env::python_exe()?;
    if !main_py.exists() {
        return Err(anyhow!("python embebido no instalado: {}", main_py.display()));
    }
    super::python_env::ensure_pip(&main_py).await?;

    let rt = paths::runtime_dir()?;
    let venv_dir = rt.join("acestep-venv");
    let repo_dir = rt.join("acestep-repo");
    let venv_py = if cfg!(windows) {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    };

    // Skip if a previous run already produced a working venv + repo.
    if venv_py.exists() && repo_dir.join("acestep").is_dir() {
        let probe = std::process::Command::new(&venv_py)
            .args(["-c", "import acestep, sys; sys.exit(0)"])
            .current_dir(&repo_dir)
            .output();
        if let Ok(out) = probe {
            if out.status.success() {
                emit(app, &c.id, ProgressStatus::Done, 100.0, "ACE-Step ya instalado, saltado");
                return Ok(());
            }
        }
        tracing::warn!("ACE-Step venv exists but import failed — reinstalling");
    }

    // ── Step 1: create the venv. ───────────────────────────────────────
    if !venv_py.exists() {
        emit(app, &c.id, ProgressStatus::Installing, 8.0, "python -m venv …");
        let venv_out = std::process::Command::new(&main_py)
            .args(["-m", "venv", venv_dir.to_str().unwrap_or("")])
            .output()
            .map_err(|e| anyhow!("falló crear venv: {}", e))?;
        if !venv_out.status.success() {
            return Err(anyhow!(
                "python -m venv falló: {}",
                String::from_utf8_lossy(&venv_out.stderr)
            ));
        }
        if !venv_py.exists() {
            return Err(anyhow!("venv creado pero python no encontrado"));
        }
    }

    // ── Step 2: modern pip. ────────────────────────────────────────────
    emit(app, &c.id, ProgressStatus::Installing, 14.0, "Actualizando pip del venv…");
    let _ = std::process::Command::new(&venv_py)
        .args(["-m", "pip", "install", "--upgrade", "--quiet", "pip", "wheel", "setuptools"])
        .output();

    // ── Step 3: torch 2.7.1 + CUDA 12.8 (the exact pin ACE-Step-1.5
    //   v0.1.7 requires; lives in its OWN venv so it never touches the
    //   main runtime's torch 2.5.1+cu121).
    emit(app, &c.id, ProgressStatus::Installing, 30.0, "Instalando PyTorch 2.7.1 CUDA 12.8 (~3 GB)…");
    let torch_out = std::process::Command::new(&venv_py)
        .args([
            "-m", "pip", "install", "--quiet",
            "torch==2.7.1", "torchaudio==2.7.1",
            "--index-url", "https://download.pytorch.org/whl/cu128",
        ])
        .output()
        .map_err(|e| anyhow!("torch install falló: {}", e))?;
    if !torch_out.status.success() {
        return Err(anyhow!(
            "torch cu128 install: {}",
            String::from_utf8_lossy(&torch_out.stderr)
        ));
    }

    // ── Step 4: clone ACE-Step-1.5 at the pinned tag. ──────────────────
    emit(app, &c.id, ProgressStatus::Installing, 55.0, "Clonando ACE-Step-1.5 @ v0.1.7…");
    if repo_dir.exists() {
        let _ = std::fs::remove_dir_all(&repo_dir);
    }
    let clone_out = std::process::Command::new("git")
        .args([
            "clone", "--depth", "1", "--branch", "v0.1.7",
            "https://github.com/ace-step/ACE-Step-1.5.git",
            repo_dir.to_str().unwrap_or(""),
        ])
        .output()
        .map_err(|e| anyhow!("git no disponible / clone falló: {}", e))?;
    if !clone_out.status.success() {
        return Err(anyhow!(
            "git clone ACE-Step-1.5: {}",
            String::from_utf8_lossy(&clone_out.stderr)
        ));
    }

    // ── Step 5: install the repo + nano-vllm (local editable). We do
    //   NOT use `uv sync` (would need uv + re-resolve the cu128 index
    //   we already satisfied); plain editable installs are deterministic
    //   and keep our torch pin. `--no-deps` on the repo so pip can't
    //   move the torch we just placed; then its runtime deps explicitly.
    emit(app, &c.id, ProgressStatus::Installing, 70.0, "Instalando nano-vllm + ACE-Step…");
    let nano = repo_dir.join("acestep").join("third_parts").join("nano-vllm");
    if nano.is_dir() {
        let nano_out = std::process::Command::new(&venv_py)
            .args(["-m", "pip", "install", "--quiet", "-e", nano.to_str().unwrap_or("")])
            .output()
            .map_err(|e| anyhow!("nano-vllm install falló: {}", e))?;
        if !nano_out.status.success() {
            return Err(anyhow!(
                "nano-vllm install: {}",
                String::from_utf8_lossy(&nano_out.stderr)
            ));
        }
    }
    // Repo runtime deps (requirements.txt) WITHOUT torch (already pinned).
    let req_txt = repo_dir.join("requirements.txt");
    if req_txt.is_file() {
        emit(app, &c.id, ProgressStatus::Installing, 80.0, "Instalando dependencias ACE-Step…");
        let _ = std::process::Command::new(&venv_py)
            .args([
                "-m", "pip", "install", "--quiet",
                "-r", req_txt.to_str().unwrap_or(""),
            ])
            .current_dir(&repo_dir)
            .output();
    }
    // The package itself (editable, no-deps so torch stays put).
    emit(app, &c.id, ProgressStatus::Installing, 90.0, "Instalando paquete ACE-Step (editable)…");
    let pkg_out = std::process::Command::new(&venv_py)
        .args(["-m", "pip", "install", "--quiet", "--no-deps", "-e", "."])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| anyhow!("acestep -e . install falló: {}", e))?;
    if !pkg_out.status.success() {
        return Err(anyhow!(
            "acestep editable install: {}",
            String::from_utf8_lossy(&pkg_out.stderr)
        ));
    }

    // ── Step 6: smoke-test the import. ─────────────────────────────────
    emit(app, &c.id, ProgressStatus::Installing, 96.0, "Verificando instalación…");
    let probe = std::process::Command::new(&venv_py)
        .args(["-c", "from acestep.handler import AceStepHandler; print('OK')"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| anyhow!("smoke probe falló: {}", e))?;
    if !probe.status.success() {
        return Err(anyhow!(
            "AceStepHandler import falló: {}",
            String::from_utf8_lossy(&probe.stderr)
        ));
    }

    emit(app, &c.id, ProgressStatus::Done, 100.0, "ACE-Step v1.5 listo (checkpoint se baja en el primer uso)");
    Ok(())
}

async fn git_clone(app: &AppHandle, c: &Component, repo_url: &str, target: &str) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Installing, 10.0, "Cloning…");
    let dest = paths::runtime_dir()?.join(target);
    if dest.join(".git").exists() {
        emit(app, &c.id, ProgressStatus::Done, 100.0, "Already cloned, skipping");
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let git = which::which("git").map_err(|_| anyhow!("git not found in PATH"))?;
    let status = tokio::process::Command::new(git)
        .args(["clone", "--depth", "1", repo_url])
        .arg(&dest)
        .hide_console()
        .status()
        .await
        .context("git clone failed to spawn")?;
    if !status.success() {
        return Err(anyhow!("git clone {} failed (exit {})", repo_url, status));
    }
    Ok(())
}

async fn hf_file_to(
    app: &AppHandle,
    c: &Component,
    repo: &str,
    filename: &str,
    target_rel: &str,
) -> Result<()> {
    emit(app, &c.id, ProgressStatus::Downloading, 5.0, "Esperando sidecar Python…");
    let target_full = paths::runtime_dir()?.join(target_rel);
    if target_full.exists() {
        let sz = std::fs::metadata(&target_full).map(|m| m.len()).unwrap_or(0);
        if sz > 1024 * 1024 {
            emit(app, &c.id, ProgressStatus::Done, 100.0, "Ya descargado");
            return Ok(());
        }
    }
    if let Some(parent) = target_full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::sidecars::ensure_python_sidecar().await?;

    // Stage download into hf-cache, then move into the precise path
    let stage_dir = paths::paths()?.data_dir.join("hf-cache").join("comfy-staging");
    std::fs::create_dir_all(&stage_dir)?;

    emit(app, &c.id, ProgressStatus::Downloading, 10.0, "Descargando desde HuggingFace…");
    let body = serde_json::json!({
        "repo": repo,
        "filename": filename,
        "target_dir": stage_dir.to_string_lossy(),
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 60 * 4))
        .build()?;
    let resp: serde_json::Value = client
        .post("http://127.0.0.1:8731/install/hf-download")
        .json(&body)
        .send()
        .await?
        .error_for_status()
        .context("hf download failed")?
        .json()
        .await?;
    let downloaded = resp["path"].as_str().unwrap_or_default();
    if downloaded.is_empty() {
        return Err(anyhow!("hf-download returned no path"));
    }

    emit(app, &c.id, ProgressStatus::Installing, 90.0, "Moviendo a ComfyUI…");
    std::fs::create_dir_all(target_full.parent().unwrap())?;
    // Use copy (not rename) so cross-volume placement works
    std::fs::copy(downloaded, &target_full)?;
    Ok(())
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
                let status = std::process::Command::new(&temp).arg("/SILENT").hide_console().status()?;
                if !status.success() {
                    return Err(anyhow!("ollama installer exit {}", status));
                }
            }
            #[cfg(target_os = "linux")]
            {
                let status = std::process::Command::new("sh").arg(&temp).hide_console().status()?;
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
        .hide_console()
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
        .hide_console()
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
        .hide_console()
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
    use super::paths;

    match &c.kind {
        AssetKind::PythonEmbed => detect::detect_python().compatible,
        AssetKind::NodeEmbed => detect::detect_node().compatible,
        AssetKind::FfmpegBinary => detect::detect_ffmpeg().compatible,
        AssetKind::OllamaInstaller => detect::detect_ollama().installed,
        AssetKind::GitClone { target, .. } => {
            // Skip if the directory already has a .git folder (already cloned)
            paths::runtime_dir()
                .map(|p| p.join(target).join(".git").exists())
                .unwrap_or(false)
        }
        AssetKind::HuggingfaceFileTo { target_path, .. } => {
            // Skip if the file already exists with reasonable size
            paths::runtime_dir()
                .map(|p| {
                    let f = p.join(target_path);
                    std::fs::metadata(&f)
                        .map(|m| m.len() > 1024 * 1024)
                        .unwrap_or(false)
                })
                .unwrap_or(false)
        }
        AssetKind::HuggingfaceFile { target, filename, .. } => {
            paths::paths()
                .map(|p| p.data_dir.join(target).join(filename).exists())
                .unwrap_or(false)
        }
        AssetKind::HuggingfaceSnapshot { target, .. } => {
            paths::paths()
                .map(|p| p.data_dir.join(target).exists())
                .unwrap_or(false)
        }
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
        .hide_console()
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
