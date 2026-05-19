//! `script_outline` + `chapter_state` access — long-form resumable
//! chapter generation. Mirrors db/scheduled.rs (sqlx::query, FromRow).
//! SQL identifiers verified by hand against migrations/0003_chapters_resume.sql.
use anyhow::Result;
use serde::Serialize;
use sqlx::FromRow;
use ulid::Ulid;

use super::{now_unix, DbPool};

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct ChapterRow {
    pub id: String,
    pub project_id: String,
    pub chapter_index: i64,
    pub title: String,
    pub status: String,
    pub narration_path: Option<String>,
    pub summary_text: Option<String>,
    pub words: Option<i64>,
    pub error_message: Option<String>,
}

pub struct NewChapter {
    pub project_id: String,
    pub chapter_index: i64,
    pub title: String,
    pub status: String,
    pub narration_path: Option<String>,
    pub summary_text: Option<String>,
    pub words: Option<i64>,
    pub error_message: Option<String>,
}

pub async fn save_outline(pool: &DbPool, project_id: &str, outline_json: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO script_outline (project_id, outline_json, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
            outline_json = excluded.outline_json",
    )
    .bind(project_id)
    .bind(outline_json)
    .bind(now_unix())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_outline(pool: &DbPool, project_id: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT outline_json FROM script_outline WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.0))
}

pub async fn upsert_chapter(pool: &DbPool, c: &NewChapter) -> Result<()> {
    sqlx::query(
        "INSERT INTO chapter_state
           (id, project_id, chapter_index, title, status, narration_path,
            summary_text, words, error_message, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, chapter_index) DO UPDATE SET
            title          = excluded.title,
            status         = excluded.status,
            narration_path = excluded.narration_path,
            summary_text   = excluded.summary_text,
            words          = excluded.words,
            error_message  = excluded.error_message,
            updated_at     = excluded.updated_at",
    )
        // ULID is used only on INSERT; SQLite ignores it on conflict
        // (id is not in the DO UPDATE SET clause).
    .bind(Ulid::new().to_string())
    .bind(&c.project_id)
    .bind(c.chapter_index)
    .bind(&c.title)
    .bind(&c.status)
    .bind(&c.narration_path)
    .bind(&c.summary_text)
    .bind(c.words)
    .bind(&c.error_message)
    .bind(now_unix())
    .execute(pool)
    .await?;
    Ok(())
}

// `updated_at` is write-only from Rust for now (no consumer yet); not
// selected into ChapterRow until a caller needs it (YAGNI).
pub async fn list_chapters(pool: &DbPool, project_id: &str) -> Result<Vec<ChapterRow>> {
    let rows = sqlx::query_as::<_, ChapterRow>(
        "SELECT id, project_id, chapter_index, title, status, narration_path,
                summary_text, words, error_message
           FROM chapter_state
          WHERE project_id = ?
          ORDER BY chapter_index ASC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Wipe outline + chapters for a project ("regenerar desde cero").
pub async fn reset_project(pool: &DbPool, project_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM chapter_state WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM script_outline WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn outline_roundtrip_and_chapter_upsert() {
        let pool = crate::db::init_memory_pool().await.unwrap();
        sqlx::query("INSERT INTO projects (id,title,topic,status,languages,created_at,updated_at) VALUES ('p1','T','t','queued','es',0,0)")
            .execute(&pool).await.unwrap();

        save_outline(&pool, "p1", r#"{"chapters":[]}"#).await.unwrap();
        assert_eq!(get_outline(&pool, "p1").await.unwrap().as_deref(), Some(r#"{"chapters":[]}"#));

        // ON CONFLICT update path: new JSON replaces, created_at preserved.
        let created0: (i64,) = sqlx::query_as("SELECT created_at FROM script_outline WHERE project_id='p1'")
            .fetch_one(&pool).await.unwrap();
        save_outline(&pool, "p1", r#"{"chapters":[{"index":1}]}"#).await.unwrap();
        assert_eq!(get_outline(&pool, "p1").await.unwrap().as_deref(), Some(r#"{"chapters":[{"index":1}]}"#));
        let created1: (i64,) = sqlx::query_as("SELECT created_at FROM script_outline WHERE project_id='p1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(created0.0, created1.0, "created_at must survive an outline update");

        upsert_chapter(&pool, &NewChapter {
            project_id: "p1".into(), chapter_index: 0, title: "Uno".into(),
            status: "done".into(), narration_path: Some("/c0.txt".into()),
            summary_text: Some("s".into()), words: Some(120), error_message: None,
        }).await.unwrap();
        upsert_chapter(&pool, &NewChapter {
            project_id: "p1".into(), chapter_index: 0, title: "Uno".into(),
            status: "failed".into(), narration_path: None,
            summary_text: None, words: None, error_message: Some("boom".into()),
        }).await.unwrap();

        let rows = list_chapters(&pool, "p1").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "failed");

        reset_project(&pool, "p1").await.unwrap();
        assert!(get_outline(&pool, "p1").await.unwrap().is_none());
        assert!(list_chapters(&pool, "p1").await.unwrap().is_empty());
    }
}
