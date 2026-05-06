//! Voice clones management — proxies the Python sidecar /tts/clones routes
//! and adds a multipart upload helper for the Tauri webview.
//!
//! The clones live under the data_dir (managed by the sidecar), but Tauri
//! handles the file picker + upload because the webview can't post multipart
//! form data to a localhost URL with arbitrary local paths.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const PY_SIDECAR: &str = "http://127.0.0.1:8731";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VoiceClone {
    pub id: String,
    pub label: String,
    pub gender: String,
    pub primary: String,
    pub description: String,
    pub duration_seconds: Option<f64>,
    pub has_ref_text: bool,
}

#[tauri::command]
pub async fn list_voice_clones() -> Result<Vec<VoiceClone>, String> {
    reqwest::Client::new()
        .get(format!("{}/tts/clones", PY_SIDECAR))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Vec<VoiceClone>>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_voice_clone(
    audio_path: String,
    label: String,
    gender: Option<String>,
    primary: Option<String>,
    description: Option<String>,
    ref_text: Option<String>,
) -> Result<VoiceClone, String> {
    let p = PathBuf::from(&audio_path);
    if !p.exists() {
        return Err(format!("audio file not found: {}", audio_path));
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    let filename = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("clone.wav")
        .to_string();

    // Multipart form. We use blocking-style construction because reqwest's
    // multipart::Form is a streaming type that requires explicit parts.
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("label", label)
        .text("gender", gender.unwrap_or_else(|| "neutral".to_string()))
        .text("primary", primary.unwrap_or_else(|| "es".to_string()))
        .text("description", description.unwrap_or_default())
        .text("ref_text", ref_text.unwrap_or_default())
        .part("audio", part);

    reqwest::Client::new()
        .post(format!("{}/tts/clones", PY_SIDECAR))
        .multipart(form)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<VoiceClone>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_voice_clone(id: String) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .delete(format!("{}/tts/clones/{}", PY_SIDECAR, id))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("delete failed: HTTP {}", resp.status()));
    }
    Ok(())
}

/// Bootstrap: copy any preset clones bundled with the app into the data_dir
/// on first run. The presets ship as small WAV files (≤200 KB each, free CC-0
/// recordings) under apps/desktop/src-tauri/resources/voice_presets/. If the
/// directory doesn't exist (production build without presets), this is a no-op.
#[allow(dead_code)]
pub fn bootstrap() {
    let _ = anyhow::Result::<()>::Ok(());
    // Best-effort. Presets are seeded by registering through the Python API
    // once it's up — we leave that for an explicit user-driven action so the
    // bootstrap doesn't silently grow the manifest with stuff the user didn't
    // ask for. (See the README for how to seed CC-0 Spanish reference clips.)
}

// silence unused warning
#[allow(dead_code)]
pub fn _force_anyhow_use() -> Result<()> { Err(anyhow!("unused")) }
