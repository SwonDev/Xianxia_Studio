//! LLM model installation: download a Gemma 4 GGUF from HuggingFace via the
//! Python sidecar, then create the Ollama model from a Modelfile.
//!
//! The Python sidecar must be up; we delegate the heavy huggingface_hub
//! download to it (resumable, parallel via hf_transfer).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::paths;

const PY_SIDECAR: &str = "http://127.0.0.1:8731";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmInstallRequest {
    pub hf_repo: String,
    pub gguf_file: String,
    pub model_name: String,
    pub abliterated: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct LlmInstallResult {
    pub model_name: String,
    pub gguf_path: String,
    pub bytes: u64,
}

#[tauri::command]
pub async fn install_llm(app: AppHandle, req: LlmInstallRequest) -> Result<LlmInstallResult, String> {
    do_install(app, req).await.map_err(|e| e.to_string())
}

async fn do_install(app: AppHandle, req: LlmInstallRequest) -> Result<LlmInstallResult> {
    let target = paths::models_dir()?.join("llm");
    std::fs::create_dir_all(&target)?;

    let _ = app.emit(
        "install:progress",
        serde_json::json!({
            "component": "llm",
            "status": "downloading",
            "message": format!("Descargando {} desde {}", req.gguf_file, req.hf_repo),
            "percent": 0.0,
        }),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 60 * 4))
        .build()?;

    // Step 1 — delegate download to Python sidecar (huggingface_hub)
    let download: serde_json::Value = client
        .post(format!("{}/install/hf-download", PY_SIDECAR))
        .json(&serde_json::json!({
            "repo": req.hf_repo,
            "filename": req.gguf_file,
            "target_dir": target.to_string_lossy(),
        }))
        .send()
        .await
        .context("contacting python sidecar")?
        .error_for_status()
        .context("hf download failed")?
        .json()
        .await?;

    let gguf_path = download["path"].as_str().unwrap_or("").to_string();
    let bytes = download["bytes"].as_u64().unwrap_or(0);

    let _ = app.emit(
        "install:progress",
        serde_json::json!({
            "component": "llm",
            "status": "installing",
            "message": "Registrando en Ollama…",
            "percent": 90.0,
        }),
    );

    // Step 2 — create the Ollama model from a Modelfile (delegated to sidecar so
    // it can invoke `ollama create` with a properly formatted SYSTEM prompt).
    let _create: serde_json::Value = client
        .post(format!("{}/install/ollama-create", PY_SIDECAR))
        .json(&serde_json::json!({
            "model_name": req.model_name,
            "gguf_path": gguf_path,
            "abliterated": req.abliterated,
        }))
        .send()
        .await?
        .error_for_status()
        .context("ollama create failed")?
        .json()
        .await?;

    let _ = app.emit(
        "install:progress",
        serde_json::json!({
            "component": "llm",
            "status": "done",
            "message": format!("LLM listo: {}", req.model_name),
            "percent": 100.0,
        }),
    );

    Ok(LlmInstallResult {
        model_name: req.model_name,
        gguf_path,
        bytes,
    })
}
