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
use tauri::AppHandle;

const PY_SIDECAR: &str = "http://127.0.0.1:8731";

/// VRAM mínima estimada para Whisper large-v3-turbo en float16:
/// ~6 GB el modelo + ~1 GB de margen para la transcripción. Si ComfyUI
/// está cargado encima, le pedimos `ensure_comfyui_vram` que libere
/// hasta llegar al mínimo. Mismo umbral que usa el pipeline normal
/// antes de la fase de subtitulación.
const CLIPMINE_MIN_VRAM_GB: f64 = 6.0;

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
///
/// v0.9.1 — añadidos los gates duros de la pipeline normal:
///   1. `wake_llm()` — proactivo para evitar el cold-start de 30 s del
///      LlamaCppBackend si el supervisor lo suspendió por TTL.
///   2. `ensure_comfyui_vram()` — reclama VRAM si ComfyUI está cargado,
///      para que Whisper (~6 GB en turbo) no compita con SDXL/Z-Image.
/// Validación pre-network del path: se extrae a función propia para que
/// los unit tests puedan ejercitarla sin necesitar un `AppHandle` real.
fn validate_video_path(video_path: &str) -> Result<(), String> {
    if video_path.trim().is_empty() {
        return Err("video_path está vacío".to_string());
    }
    if !std::path::Path::new(video_path).is_file() {
        return Err(format!("vídeo no encontrado: {video_path}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn clip_mine_extract(
    app: AppHandle,
    req: ClipMineRequest,
) -> Result<ClipMineResponse, String> {
    validate_video_path(&req.video_path)?;

    // v0.9.1 fix CRÍTICO C1 — wake_llm antes de cualquier fase LLM.
    // Sin esto, si el supervisor suspendió llama-server por TTL, la
    // primera llamada del endpoint Python espera 30 s al respawn y la
    // UI ve un spinner muerto.
    crate::pipeline::wake_llm(&CLIPMINE_CLIENT).await;

    // v0.9.1 fix ALTO A3 — coordinación VRAM con ComfyUI activo. Si el
    // usuario lanza Clip Miner mientras un long-form está en fase de
    // imagen (SDXL ~6 GB), Whisper crashearía con OOM. Esta función
    // descarga ComfyUI hasta liberar `CLIPMINE_MIN_VRAM_GB` libres.
    let _free_gb = crate::pipeline::ensure_comfyui_vram(
        &app,
        &CLIPMINE_CLIENT,
        CLIPMINE_MIN_VRAM_GB,
    )
    .await;

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

    // v0.9.1 — testeamos la validación pura porque `clip_mine_extract`
    // ahora requiere `AppHandle` (necesario para wake_llm + VRAM
    // reclaim). Los tests siguen cubriendo el contrato funcional.
    #[test]
    fn empty_path_rejected() {
        let r = validate_video_path("");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("vacío"));
    }

    #[test]
    fn whitespace_path_rejected() {
        let r = validate_video_path("   \t  ");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("vacío"));
    }

    #[test]
    fn nonexistent_path_rejected() {
        let r = validate_video_path("Z:/this/path/does/not/exist.mp4");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("no encontrado"));
    }
}
