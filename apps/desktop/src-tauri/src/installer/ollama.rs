// Ollama install helpers. The pull/modelfile flow is invoked by the
// installer wizard's LLM step; not all paths are exercised in every
// run (e.g. write_xianxia_modelfile only runs on first-time install).
#![allow(dead_code)]

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

use super::paths;
use crate::process_ext::HideConsole;

/// Returns the ollama binary path if installed, else None.
pub fn detect() -> Option<PathBuf> {
    which::which("ollama").ok()
}

pub async fn is_running() -> bool {
    reqwest::Client::new()
        .get("http://127.0.0.1:11434/api/tags")
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Start the ollama serve daemon if it isn't already responding.
pub async fn ensure_running() -> Result<()> {
    if is_running().await {
        return Ok(());
    }
    let bin = detect().ok_or_else(|| anyhow::anyhow!("ollama not found in PATH"))?;
    Command::new(&bin)
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .hide_console()
        .spawn()
        .context("failed to start ollama serve")?;
    // Poll for readiness
    for _ in 0..30 {
        if is_running().await {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err(anyhow::anyhow!("ollama did not start within 15s"))
}

/// `ollama pull <model_id>`
pub async fn pull(model_id: &str) -> Result<()> {
    let bin = detect().ok_or_else(|| anyhow::anyhow!("ollama not in PATH"))?;
    let status = Command::new(&bin)
        .args(["pull", model_id])
        .hide_console()
        .status()
        .await
        .context("ollama pull failed to spawn")?;
    if !status.success() {
        return Err(anyhow::anyhow!("ollama pull {} failed", model_id));
    }
    Ok(())
}

/// Create a custom model from a Modelfile (FROM ./<gguf>).
/// Used for `supergemma4-e4b-abliterated` and similar custom GGUFs.
pub async fn create_from_modelfile(model_name: &str, modelfile_path: &std::path::Path) -> Result<()> {
    let bin = detect().ok_or_else(|| anyhow::anyhow!("ollama not in PATH"))?;
    let status = Command::new(&bin)
        .args(["create", model_name, "-f", modelfile_path.to_str().unwrap()])
        .hide_console()
        .status()
        .await
        .context("ollama create failed to spawn")?;
    if !status.success() {
        return Err(anyhow::anyhow!("ollama create {} failed", model_name));
    }
    Ok(())
}

/// Generate the canonical Modelfile for the experimental abliterated model.
pub fn write_xianxia_modelfile(gguf_path: &std::path::Path) -> Result<PathBuf> {
    let dir = paths::ollama_modelfiles_dir()?;
    let path = dir.join("xianxia-experimental.Modelfile");
    let content = format!(
        "FROM {}\n\
         PARAMETER temperature 0.85\n\
         PARAMETER top_p 0.92\n\
         PARAMETER num_ctx 32768\n\
         SYSTEM \"\"\"Eres un narrador experto en xianxia, wuxia y mitologia china. \
         Tu estilo es epico, mistico y accesible para audiencia occidental. \
         Generas scripts cinematograficos con marcadores [IMAGE: ...] [MUSIC: ...]\"\"\"\n",
        gguf_path.to_string_lossy().replace('\\', "/"),
    );
    std::fs::write(&path, content)?;
    Ok(path)
}
