use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;

use crate::db::projects::{self, NewProject, Project};
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
