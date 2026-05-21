//! Originality Engine (v0.12.0) — Tauri proxy a los endpoints
//! `/originality/check_structural`, `/originality/hook_alternatives`
//! y `/originality/build_manifest` del sidecar Python.
//!
//! El sidecar es stateless: el cliente Tauri lee los scripts previos
//! de la DB SQLite y los pasa al `check_structural`. Los commands
//! aquí son THIN PROXIES, sin lógica de negocio.
//!
//! Por qué existe (recap v0.10.0):
//!   - YouTube ola terminaciones canales AI ene 2026 ("inauthentic
//!     content").
//!   - EU AI Act Article 50 enforcement 2 ago 2026.
//!   - Sin este gate, los usuarios pueden perder monetización tras
//!     2-3 vídeos publicados.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const PY_SIDECAR: &str = "http://127.0.0.1:8731";

/// Cliente compartido. Originality es rápido (Jaccard local + LLM
/// breve), 3 min de timeout cubre incluso `hook_alternatives` con
/// LLM cold-start.
static ORIGINALITY_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60 * 3))
        .connect_timeout(Duration::from_secs(5))
        .pool_idle_timeout(Duration::from_secs(60))
        .build()
        .expect("reqwest::Client::builder must build with valid defaults")
});

// ── Tipos espejo de routes/originality.py ─────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PreviousScript {
    pub project_id: String,
    pub title: String,
    pub script_text: String,
    pub chapters: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StructuralCheckRequest {
    pub project_id: String,
    pub script_text: String,
    pub chapters: Option<Vec<String>>,
    pub previous_scripts: Vec<PreviousScript>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StructuralWarning {
    pub code: String,
    pub detail: String,
    /// info | warning | blocking
    pub severity: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StructuralCheckResponse {
    pub score: f64,
    pub most_similar_project_id: Option<String>,
    pub warnings: Vec<StructuralWarning>,
    /// approved | pending | rejected
    pub recommended_status: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HookAlternativesRequest {
    pub topic: String,
    pub outline: Option<String>,
    pub primary_language: String,
    pub n_alternatives: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HookAlternative {
    /// question | number | contradiction | promise | story
    pub kind: String,
    pub text: String,
    pub rationale: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HookAlternativesResponse {
    pub alternatives: Vec<HookAlternative>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestSource {
    pub url: String,
    pub title: String,
    pub extracted_quote: String,
    /// Unix seconds; 0 → el sidecar pone now.
    pub retrieved_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BuildManifestRequest {
    pub project_id: String,
    pub topic: String,
    pub thesis_user: String,
    pub hook_chosen: String,
    pub sources: Vec<ManifestSource>,
    pub human_edits: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OriginalityManifest {
    pub schema_version: String,
    pub project_id: String,
    pub topic: String,
    pub thesis_user: String,
    pub hook_chosen: String,
    pub sources: Vec<serde_json::Value>,
    pub human_edits: Vec<String>,
    pub generated_at: i64,
    pub ai_disclosure: String,
}

// ── Validación local (evita roundtrip si está mal) ───────────────────

/// El sidecar exige `thesis_user ≥ 20 chars`. Validamos local para
/// dar feedback inmediato al usuario en la UI sin esperar al HTTP.
fn validate_manifest_input(req: &BuildManifestRequest) -> Result<(), String> {
    let thesis = req.thesis_user.trim();
    if thesis.chars().count() < 20 {
        return Err(
            "La tesis personal debe tener al menos 20 caracteres. \
             El motor de originalidad exige aportación humana real."
                .to_string(),
        );
    }
    if req.hook_chosen.trim().chars().count() < 10 {
        return Err("El hook elegido debe tener al menos 10 caracteres.".to_string());
    }
    if req.project_id.trim().is_empty() {
        return Err("project_id vacío".to_string());
    }
    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────

#[tauri::command]
pub async fn originality_check_structural(
    req: StructuralCheckRequest,
) -> Result<StructuralCheckResponse, String> {
    if req.script_text.trim().is_empty() {
        return Err("script_text vacío".to_string());
    }
    let resp = ORIGINALITY_CLIENT
        .post(format!("{}/originality/check_structural", PY_SIDECAR))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("originality.check: petición falló: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "originality.check HTTP {}: {}",
            status,
            body.chars().take(400).collect::<String>()
        ));
    }
    resp.json::<StructuralCheckResponse>()
        .await
        .map_err(|e| format!("originality.check JSON inválido: {e}"))
}

#[tauri::command]
pub async fn originality_hook_alternatives(
    req: HookAlternativesRequest,
) -> Result<HookAlternativesResponse, String> {
    if req.topic.trim().is_empty() {
        return Err("topic vacío".to_string());
    }
    // v0.10.0 dice 2-5 alternativas; clamp local.
    let n = req.n_alternatives.clamp(2, 5);
    let body = serde_json::json!({
        "topic": req.topic,
        "outline": req.outline,
        "primary_language": req.primary_language,
        "n_alternatives": n,
    });
    let resp = ORIGINALITY_CLIENT
        .post(format!("{}/originality/hook_alternatives", PY_SIDECAR))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("originality.hooks: petición falló: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "originality.hooks HTTP {}: {}",
            status,
            body.chars().take(400).collect::<String>()
        ));
    }
    resp.json::<HookAlternativesResponse>()
        .await
        .map_err(|e| format!("originality.hooks JSON inválido: {e}"))
}

#[tauri::command]
pub async fn originality_build_manifest(
    req: BuildManifestRequest,
) -> Result<OriginalityManifest, String> {
    validate_manifest_input(&req)?;
    let resp = ORIGINALITY_CLIENT
        .post(format!("{}/originality/build_manifest", PY_SIDECAR))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("originality.manifest: petición falló: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "originality.manifest HTTP {}: {}",
            status,
            body.chars().take(400).collect::<String>()
        ));
    }
    resp.json::<OriginalityManifest>()
        .await
        .map_err(|e| format!("originality.manifest JSON inválido: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_manifest_req() -> BuildManifestRequest {
        BuildManifestRequest {
            project_id: "proj_test_abc".to_string(),
            topic: "Caída del Imperio Romano".to_string(),
            thesis_user: "Mi ángulo sobre la caída es la pérdida de cohesión militar y económica simultánea.".to_string(),
            hook_chosen: "¿Y si Roma cayó por una crisis monetaria?".to_string(),
            sources: vec![],
            human_edits: vec![],
        }
    }

    #[test]
    fn manifest_thesis_too_short_rejected() {
        let mut req = base_manifest_req();
        req.thesis_user = "abc".to_string();
        let r = validate_manifest_input(&req);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("20 caracteres"));
    }

    #[test]
    fn manifest_hook_too_short_rejected() {
        let mut req = base_manifest_req();
        req.hook_chosen = "qué".to_string();
        let r = validate_manifest_input(&req);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("hook"));
    }

    #[test]
    fn manifest_empty_project_id_rejected() {
        let mut req = base_manifest_req();
        req.project_id = "   ".to_string();
        let r = validate_manifest_input(&req);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("project_id"));
    }

    #[test]
    fn manifest_valid_passes() {
        let req = base_manifest_req();
        assert!(validate_manifest_input(&req).is_ok());
    }
}
