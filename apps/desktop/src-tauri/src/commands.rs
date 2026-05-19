pub mod library;
pub mod music;
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
