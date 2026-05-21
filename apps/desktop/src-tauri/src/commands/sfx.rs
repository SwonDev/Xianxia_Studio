//! SFX/Foley engine (v0.12.0) — Tauri proxy a los endpoints
//! `/sfx/generate` y `/sfx/plan_events` del sidecar Python.
//!
//! Backend implementado en v0.11.0 con Stable Audio 3 small-sfx via
//! ComfyUI Day-0. Estos commands son THIN PROXIES con:
//!   - Validación local del prompt (evita roundtrip si está vacío).
//!   - Gates duros antes del POST: `wake_llm` (para plan_events) +
//!     `ensure_comfyui_vram` (para generate; mismo patrón que clipmine
//!     v0.9.1 fix C1+A3).
//!   - Sin progress events todavía (v0.12.1+).

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

const PY_SIDECAR: &str = "http://127.0.0.1:8731";

/// VRAM mínima para Stable Audio 3 small-sfx + T5Gemma encoder
/// (~2 GB FP16). Pedimos 3 GB libres por margen.
const SFX_MIN_VRAM_GB: f64 = 3.0;

static SFX_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        // Generate de un clip 5-30 s: 10-60 s en RTX 4060 (8 steps);
        // 10 min cubre cold-start del modelo + workflow heavy.
        .timeout(Duration::from_secs(60 * 10))
        .connect_timeout(Duration::from_secs(5))
        .pool_idle_timeout(Duration::from_secs(60))
        .build()
        .expect("reqwest::Client::builder must build with valid defaults")
});

// ── Tipos espejo de routes/sfx.py ─────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct SfxGenerateRequest {
    pub prompt: String,
    /// 0.5 - 30.0 s.
    pub duration_seconds: f64,
    /// None → random.
    pub seed: Option<i64>,
    /// 4-50; default 8.
    pub steps: Option<i64>,
    /// 1.0-15.0; default 6.0.
    pub cfg: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SfxGenerateResponse {
    pub audio_path: String,
    pub duration_seconds: f64,
    pub prompt: String,
    pub seed_used: i64,
    pub generated_in_seconds: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SfxEvent {
    pub timestamp_seconds: f64,
    pub duration_seconds: f64,
    pub prompt: String,
    /// impact | ambient | foley | whoosh | natural | mystic
    pub category: String,
    pub volume_db: f64,
    pub rationale: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlanSfxEventsRequest {
    pub script_text: String,
    pub total_duration_seconds: f64,
    /// 2-30; default 8.
    pub target_event_count: Option<i64>,
    /// cinematic | hype | calm | epic | mystic
    pub style_hint: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlanSfxEventsResponse {
    pub events: Vec<SfxEvent>,
}

// ── Validación local ──────────────────────────────────────────────────

fn validate_generate(req: &SfxGenerateRequest) -> Result<(), String> {
    if req.prompt.trim().is_empty() {
        return Err("prompt SFX vacío".to_string());
    }
    if !(0.5..=30.0).contains(&req.duration_seconds) {
        return Err(format!(
            "duration_seconds fuera de rango (0.5-30.0): {}",
            req.duration_seconds
        ));
    }
    if let Some(s) = req.steps {
        if !(4..=50).contains(&s) {
            return Err(format!("steps fuera de rango (4-50): {s}"));
        }
    }
    if let Some(c) = req.cfg {
        if !(1.0..=15.0).contains(&c) {
            return Err(format!("cfg fuera de rango (1.0-15.0): {c}"));
        }
    }
    Ok(())
}

fn validate_plan(req: &PlanSfxEventsRequest) -> Result<(), String> {
    if req.script_text.trim().is_empty() {
        return Err("script_text vacío".to_string());
    }
    if req.total_duration_seconds <= 0.0 {
        return Err(format!(
            "total_duration_seconds debe ser > 0: {}",
            req.total_duration_seconds
        ));
    }
    if let Some(n) = req.target_event_count {
        if !(2..=30).contains(&n) {
            return Err(format!("target_event_count fuera de rango (2-30): {n}"));
        }
    }
    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────

#[tauri::command]
pub async fn sfx_generate(
    app: AppHandle,
    req: SfxGenerateRequest,
) -> Result<SfxGenerateResponse, String> {
    validate_generate(&req)?;

    // VRAM reclaim ANTES del POST. Si ComfyUI está cargado con Z-Image
    // (~6 GB), descarga hasta liberar 3 GB para Stable Audio 3.
    // Mismo patrón que `clip_mine_extract` (v0.9.1 fix A3).
    let _free_gb = crate::pipeline::ensure_comfyui_vram(
        &app,
        &SFX_CLIENT,
        SFX_MIN_VRAM_GB,
    )
    .await;

    let body = serde_json::json!({
        "prompt": req.prompt,
        "duration_seconds": req.duration_seconds,
        "seed": req.seed,
        "steps": req.steps.unwrap_or(8),
        "cfg": req.cfg.unwrap_or(6.0),
    });

    let resp = SFX_CLIENT
        .post(format!("{}/sfx/generate", PY_SIDECAR))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sfx.generate: petición falló: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "sfx.generate HTTP {}: {}",
            status,
            body.chars().take(400).collect::<String>()
        ));
    }
    resp.json::<SfxGenerateResponse>()
        .await
        .map_err(|e| format!("sfx.generate JSON inválido: {e}"))
}

#[tauri::command]
pub async fn sfx_plan_events(
    req: PlanSfxEventsRequest,
) -> Result<PlanSfxEventsResponse, String> {
    validate_plan(&req)?;

    // El planner usa LLM Gemma 4B — necesita wake_llm proactivo
    // (regla MEMORY.md bugfix_llamacpp_respawn). Mismo patrón que
    // clip_mine_extract v0.9.1 fix C1.
    crate::pipeline::wake_llm(&SFX_CLIENT).await;

    let body = serde_json::json!({
        "script_text": req.script_text,
        "total_duration_seconds": req.total_duration_seconds,
        "target_event_count": req.target_event_count.unwrap_or(8),
        "style_hint": req.style_hint.clone().unwrap_or_else(|| "cinematic".to_string()),
    });

    let resp = SFX_CLIENT
        .post(format!("{}/sfx/plan_events", PY_SIDECAR))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sfx.plan: petición falló: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "sfx.plan HTTP {}: {}",
            status,
            body.chars().take(400).collect::<String>()
        ));
    }
    resp.json::<PlanSfxEventsResponse>()
        .await
        .map_err(|e| format!("sfx.plan JSON inválido: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_empty_prompt_rejected() {
        let r = validate_generate(&SfxGenerateRequest {
            prompt: "  ".to_string(),
            duration_seconds: 5.0,
            seed: None,
            steps: None,
            cfg: None,
        });
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("vacío"));
    }

    #[test]
    fn generate_duration_out_of_range_rejected() {
        let r = validate_generate(&SfxGenerateRequest {
            prompt: "footstep on stone".to_string(),
            duration_seconds: 60.0,
            seed: None,
            steps: None,
            cfg: None,
        });
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("duration_seconds"));
    }

    #[test]
    fn generate_steps_out_of_range_rejected() {
        let r = validate_generate(&SfxGenerateRequest {
            prompt: "wind".to_string(),
            duration_seconds: 5.0,
            seed: None,
            steps: Some(200),
            cfg: None,
        });
        assert!(r.is_err());
    }

    #[test]
    fn generate_valid_passes() {
        let r = validate_generate(&SfxGenerateRequest {
            prompt: "ember crackle".to_string(),
            duration_seconds: 3.0,
            seed: Some(42),
            steps: Some(8),
            cfg: Some(6.0),
        });
        assert!(r.is_ok());
    }

    #[test]
    fn plan_empty_script_rejected() {
        let r = validate_plan(&PlanSfxEventsRequest {
            script_text: "".to_string(),
            total_duration_seconds: 300.0,
            target_event_count: None,
            style_hint: None,
        });
        assert!(r.is_err());
    }

    #[test]
    fn plan_zero_duration_rejected() {
        let r = validate_plan(&PlanSfxEventsRequest {
            script_text: "Once upon a time...".to_string(),
            total_duration_seconds: 0.0,
            target_event_count: None,
            style_hint: None,
        });
        assert!(r.is_err());
    }
}
