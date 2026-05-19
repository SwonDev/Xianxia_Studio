//! Tauri commands for TikTok assisted-publish credential management.
//! Mirrors the youtube app-credentials command shape.
use serde::Serialize;

use super::creds::{self, TikTokCreds};

#[derive(Serialize)]
pub struct TikTokStatus {
    pub configured: bool,
}

#[tauri::command]
pub fn tiktok_status() -> Result<TikTokStatus, String> {
    let c = creds::load_session().map_err(|e| e.to_string())?;
    Ok(TikTokStatus { configured: c.is_some() })
}

#[tauri::command]
pub fn tiktok_set_session(session_id: String) -> Result<(), String> {
    let s = session_id.trim();
    if s.is_empty() {
        return Err("El sessionid no puede estar vacío".into());
    }
    creds::store_session(&TikTokCreds { session_id: s.to_string() }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tiktok_clear_session() -> Result<(), String> {
    creds::delete_session().map_err(|e| e.to_string())
}
