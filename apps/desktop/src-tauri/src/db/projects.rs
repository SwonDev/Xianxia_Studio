use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use ulid::Ulid;

use super::{now_unix, DbPool};

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct Project {
    pub id: String,
    pub title: String,
    pub topic: String,
    pub status: String,
    pub languages: String, // JSON array
    pub duration_seconds: Option<f64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewProject {
    pub title: String,
    pub topic: String,
    pub languages: Vec<String>,
}

pub async fn create(pool: &DbPool, new: NewProject) -> Result<Project> {
    let id = Ulid::new().to_string();
    let now = now_unix();
    let langs = serde_json::to_string(&new.languages)?;
    let project = Project {
        id: id.clone(),
        title: new.title.clone(),
        topic: new.topic.clone(),
        status: "draft".to_string(),
        languages: langs.clone(),
        duration_seconds: None,
        created_at: now,
        updated_at: now,
        error_message: None,
    };
    sqlx::query(
        "INSERT INTO projects (id, title, topic, status, languages, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&project.id)
    .bind(&project.title)
    .bind(&project.topic)
    .bind(&project.status)
    .bind(&project.languages)
    .bind(project.created_at)
    .bind(project.updated_at)
    .execute(pool)
    .await?;
    Ok(project)
}

pub async fn list(pool: &DbPool) -> Result<Vec<Project>> {
    let rows = sqlx::query_as::<_, Project>(
        "SELECT * FROM projects ORDER BY updated_at DESC LIMIT 200",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[allow(dead_code)] // public API — used by Library detail view (M8)
pub async fn get(pool: &DbPool, id: &str) -> Result<Option<Project>> {
    let row = sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn set_status(pool: &DbPool, id: &str, status: &str) -> Result<()> {
    sqlx::query("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(now_unix())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
