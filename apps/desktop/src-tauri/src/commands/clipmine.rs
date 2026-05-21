//! Clip Miner (v0.9.0) — proxy Tauri al endpoint `/clipmine/extract` del
//! sidecar Python.
//!
//! Permite a la UI (route `/clip-mine`) extraer N candidatos a Shorts
//! virales desde un MP4 largo subido por el usuario, sin tener que
//! abrir un socket HTTP directo al sidecar (eso queda como detalle de
//! implementación del backend, mejor encapsulado tras Tauri command).
//!
//! El comando hace el trabajo pesado en el sidecar Python:
//!   1. ffmpeg audio extract
//!   2. faster-whisper large-v3-turbo word-level transcribe
//!   3. Gemma 4B candidate detection
//!   4. PySceneDetect snap
//!   5. validación + dedupe overlap
//!
//! Render del candidato elegido va por el comando ya existente
//! `shorts_from_video` (es el pipeline standalone v0.1.22 sin cambios).

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const PY_SIDECAR: &str = "http://127.0.0.1:8731";

/// v0.7.15 pattern — cliente compartido con timeout generoso. La
/// extracción puede tardar varios minutos (Whisper transcribe + LLM
/// candidate detection); 20 min cubre vídeos de 1-2 horas.
static CLIPMINE_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60 * 20))
        .connect_timeout(Duration::from_secs(5))
        .pool_idle_timeout(Duration::from_secs(60))
        .build()
        .expect("reqwest::Client::builder must build with valid defaults")
});

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClipCandidate {
    pub start: f64,
    pub end: f64,
    pub duration: f64,
    pub score: f64,
    pub label: String,
    pub hook_text: String,
    pub summary: String,
    pub snapped_to_scene_cut: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClipMineResponse {
    pub candidates: Vec<ClipCandidate>,
    pub transcript_language: String,
    pub total_duration: f64,
    pub scene_cuts_detected: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipMineRequest {
    pub video_path: String,
    /// 1-15. Default 5.
    pub n_candidates: Option<i64>,
    /// Default 45.0 s.
    pub target_duration: Option<f64>,
    /// Default 25.0 s.
    pub min_duration: Option<f64>,
    /// Default 60.0 s.
    pub max_duration: Option<f64>,
    /// ISO 639-1 (es/en/pt/zh/...). Auto-detect si None.
    pub primary_language: Option<String>,
}

/// Extrae N candidatos virales desde un MP4 largo.
///
/// Sin opcional render: la UI muestra los candidatos, el usuario elige
/// y luego invoca el flujo `shorts_from_video` clásico (que ya cubre
/// reframe, captions Hormozi, hook, CTA, virality score).
#[tauri::command]
pub async fn clip_mine_extract(req: ClipMineRequest) -> Result<ClipMineResponse, String> {
    // Validación local — evita el round-trip si el path está claramente mal.
    if req.video_path.trim().is_empty() {
        return Err("video_path está vacío".to_string());
    }
    if !std::path::Path::new(&req.video_path).is_file() {
        return Err(format!("vídeo no encontrado: {}", req.video_path));
    }

    let body = serde_json::json!({
        "video_path": req.video_path,
        "n_candidates": req.n_candidates.unwrap_or(5),
        "target_duration": req.target_duration.unwrap_or(45.0),
        "min_duration": req.min_duration.unwrap_or(25.0),
        "max_duration": req.max_duration.unwrap_or(60.0),
        "primary_language": req.primary_language,
    });

    let resp = CLIPMINE_CLIENT
        .post(format!("{}/clipmine/extract", PY_SIDECAR))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("clipmine: petición al sidecar falló: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        // v0.7.17 pattern — solo el texto del status, NO ecoa el body
        // del error (los endpoints internos no exponen PII pero el
        // patrón se mantiene por consistencia).
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!(
            "clipmine extract HTTP {}: {}",
            status,
            detail.chars().take(400).collect::<String>()
        ));
    }

    resp.json::<ClipMineResponse>()
        .await
        .map_err(|e| format!("clipmine: respuesta JSON inválida: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_path_rejected() {
        let req = ClipMineRequest {
            video_path: "".to_string(),
            n_candidates: None,
            target_duration: None,
            min_duration: None,
            max_duration: None,
            primary_language: None,
        };
        let r = futures::executor::block_on(clip_mine_extract(req));
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("vacío"));
    }

    #[test]
    fn nonexistent_path_rejected() {
        let req = ClipMineRequest {
            video_path: "Z:/this/path/does/not/exist.mp4".to_string(),
            n_candidates: Some(3),
            target_duration: None,
            min_duration: None,
            max_duration: None,
            primary_language: None,
        };
        let r = futures::executor::block_on(clip_mine_extract(req));
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("no encontrado"));
    }
}
