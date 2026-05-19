//! `scheduled_uploads` access — the real backing for the Planificador
//! screen and the internal publish-flip cron (`scheduler::run_loop`).
//!
//! Until v0.4.0 the table + cron existed but NOTHING inserted rows, so the
//! whole scheduled-publish feature was dormant and the screen had to show a
//! placeholder. `record()` (called best-effort from pipeline Phase 9 after a
//! successful YouTube upload) is the missing producer; `list()` feeds the
//! screen with REAL rows; `cancel()` lets the user drop a pending publish.
use anyhow::Result;
use serde::Serialize;
use sqlx::FromRow;
use ulid::Ulid;

use super::{now_unix, DbPool};

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct ScheduledUpload {
    pub id: String,
    pub project_id: String,
    /// Joined from `projects.title` so the UI never shows a bare id.
    pub title: String,
    pub youtube_video_id: Option<String>,
    pub scheduled_at: i64,
    pub privacy_status: String,
    pub publish_at: Option<i64>,
    pub is_short: i64,
    pub status: String,
    pub last_attempt_at: Option<i64>,
    pub error_message: Option<String>,
}

pub struct NewScheduled {
    pub project_id: String,
    pub youtube_video_id: Option<String>,
    /// When the publish-flip is due. For immediate `public` uploads this is
    /// `now` and `status` is `published`; for `private` + `publish_at` it is
    /// `publish_at` and `status` is `uploaded` (the cron flips it later).
    pub scheduled_at: i64,
    pub privacy_status: String,
    pub publish_at: Option<i64>,
    pub is_short: bool,
    pub status: String,
}

pub async fn record(pool: &DbPool, new: NewScheduled) -> Result<()> {
    sqlx::query(
        "INSERT INTO scheduled_uploads
           (id, project_id, youtube_video_id, scheduled_at, privacy_status,
            publish_at, is_short, status, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(Ulid::new().to_string())
    .bind(&new.project_id)
    .bind(&new.youtube_video_id)
    .bind(new.scheduled_at)
    .bind(&new.privacy_status)
    .bind(new.publish_at)
    .bind(i64::from(new.is_short))
    .bind(&new.status)
    .bind(now_unix())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list(pool: &DbPool) -> Result<Vec<ScheduledUpload>> {
    let rows = sqlx::query_as::<_, ScheduledUpload>(
        "SELECT s.id, s.project_id, p.title AS title, s.youtube_video_id,
                s.scheduled_at, s.privacy_status, s.publish_at, s.is_short,
                s.status, s.last_attempt_at, s.error_message
           FROM scheduled_uploads s
           JOIN projects p ON p.id = s.project_id
          ORDER BY s.scheduled_at DESC
          LIMIT 200",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Drop a row the user no longer wants published. Safe on any status.
pub async fn cancel(pool: &DbPool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM scheduled_uploads WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
