pub mod clipmine;
pub mod library;
pub mod music;
pub mod originality;
pub mod sfx;
pub mod voice_clones;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;

use crate::db::projects::{self, NewProject, Project};
use crate::db::scheduled::{self, ScheduledUpload};
use crate::db::voices::{self, VoiceProfile};
use crate::db::DbPool;
use crate::pipeline::{self, GenerateRequest};

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("欢迎, {}! Welcome to Xianxia Studio.", name)
}

#[derive(Serialize)]
pub struct AppVersion {
    pub version: String,
    pub tauri: String,
}

#[tauri::command]
pub fn get_app_version() -> AppVersion {
    AppVersion {
        version: env!("CARGO_PKG_VERSION").to_string(),
        tauri: tauri::VERSION.to_string(),
    }
}

/// v0.6.0 — LTX-2.3 hardware capability gate (None | Gguf | Full).
#[tauri::command]
pub fn ltx_capability() -> Result<crate::hardware::LtxCapability, String> {
    Ok(crate::hardware::ltx_video_capability())
}

/// v0.6.0 — Returns true if the LTX-2.3 model files for the current hardware
/// tier are ALL present on disk. False when capability is None or any key file
/// is missing. Thin wrapper that re-exports the private pipeline helper so the
/// UI can gate the "Motor de vídeo" control.
#[tauri::command]
pub fn ltx_models_installed() -> bool {
    crate::pipeline::ltx_models_installed()
}

/// v0.12.5 — autodetect SFX (Stable Audio 3 small-sfx + T5Gemma encoder).
/// True solo si AMBOS safetensors están en `ComfyUI/models/{checkpoints,text_encoders}/`.
/// Usado por el toggle UI en generator.tsx para mostrar:
///   - botón "Instalar SFX" si false (espejo del flujo LTX)
///   - switch on/off si true
#[tauri::command]
pub fn sfx_models_installed() -> bool {
    crate::pipeline::sfx_models_installed()
}

#[tauri::command]
pub async fn list_projects(pool: tauri::State<'_, Arc<DbPool>>) -> Result<Vec<Project>, String> {
    projects::list(&pool).await.map_err(|e| e.to_string())
}

/// Real backing for the Planificador screen — replaces the old UI
/// placeholder with actual `scheduled_uploads` rows (joined to project title).
#[tauri::command]
pub async fn list_scheduled(
    pool: tauri::State<'_, Arc<DbPool>>,
) -> Result<Vec<ScheduledUpload>, String> {
    scheduled::list(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_scheduled(
    pool: tauri::State<'_, Arc<DbPool>>,
    id: String,
) -> Result<(), String> {
    scheduled::cancel(&pool, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reset_project_progress(
    pool: tauri::State<'_, Arc<DbPool>>,
    project_id: String,
) -> Result<(), String> {
    let p = pool.inner().clone();
    crate::db::chapters::reset_project(&p, &project_id)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM pipeline_steps WHERE project_id = ?")
        .bind(&project_id)
        .execute(&*p)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateProjectArgs {
    pub title: String,
    pub topic: String,
    pub languages: Vec<String>,
}

#[tauri::command]
pub async fn create_project(
    pool: tauri::State<'_, Arc<DbPool>>,
    args: CreateProjectArgs,
) -> Result<Project, String> {
    projects::create(
        &pool,
        NewProject {
            title: args.title,
            topic: args.topic,
            languages: args.languages,
        },
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_generation(
    app: AppHandle,
    pool: tauri::State<'_, Arc<DbPool>>,
    args: GenerateRequest,
) -> Result<String, String> {
    pipeline::start(app, pool.inner().clone(), args)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_voices(
    pool: tauri::State<'_, Arc<DbPool>>,
    language: Option<String>,
) -> Result<Vec<VoiceProfile>, String> {
    match language {
        Some(l) => voices::list_for_language(&pool, &l).await.map_err(|e| e.to_string()),
        None => voices::list_all(&pool).await.map_err(|e| e.to_string()),
    }
}
