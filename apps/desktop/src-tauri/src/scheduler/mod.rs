//! Internal cron — checks every 60s for due `scheduled_uploads` rows and triggers
//! the YouTube `videos.update` (private → public) flip.
use crate::db::DbPool;
use std::sync::Arc;

pub async fn run_loop(pool: Arc<DbPool>) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        tick.tick().await;
        if let Err(e) = process_due(&pool).await {
            tracing::warn!(error = %e, "scheduler tick failed");
        }
    }
}

async fn process_due(pool: &DbPool) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp();
    let due: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, youtube_video_id FROM scheduled_uploads
         WHERE status = 'uploaded' AND scheduled_at <= ?",
    )
    .bind(now)
    .fetch_all(pool)
    .await?;
    for (sched_id, video_id) in due {
        tracing::info!(sched = %sched_id, video = %video_id, "publish flip due");
        // crate::youtube::publish_now(&video_id).await?;  // wired in M5
        sqlx::query("UPDATE scheduled_uploads SET status = 'published' WHERE id = ?")
            .bind(&sched_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}
