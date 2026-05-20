//! Internal cron — checks every 60s for due `scheduled_uploads` rows and triggers
//! the YouTube `videos.update` (private → public) flip.
//!
//! v0.7.12 — exponential backoff + max attempts. The original loop retried
//! every 60 s indefinitely; a YouTube `videos.update` call costs 50 units of
//! the 1 000 free-tier daily quota, so a single broken row (e.g. revoked
//! OAuth token or 404 video) would saturate the quota in ~20 retries and
//! lock legitimate uploads out for the day. New behaviour:
//!   • Each failure increments `attempt_count`.
//!   • The next retry only fires once `now - last_attempt_at >= 60 * 2^attempt`
//!     seconds (1, 2, 4, 8, 16 min between attempts).
//!   • After `MAX_ATTEMPTS` (5) consecutive failures, the row moves to
//!     `status='failed'` and stops being picked. The user must retry
//!     explicitly from the Planificador UI.
use crate::db::DbPool;
use std::sync::Arc;

const MAX_ATTEMPTS: i64 = 5;

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
    // v0.7.12 — fetch attempt_count + last_attempt_at so we can apply
    // exponential backoff client-side. We still filter by scheduled_at
    // in SQL so rows scheduled for the future aren't even considered.
    let due: Vec<(String, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, youtube_video_id, attempt_count, last_attempt_at
           FROM scheduled_uploads
          WHERE status = 'uploaded' AND scheduled_at <= ?",
    )
    .bind(now)
    .fetch_all(pool)
    .await?;
    for (sched_id, video_id, attempt_count, last_attempt_at) in due {
        // Exponential backoff: 60 * 2^attempt_count seconds between
        // attempts. attempt_count=0 → 60 s, =1 → 120 s, =2 → 240 s,
        // =3 → 480 s, =4 → 960 s. After attempt 5 the row is failed.
        if let Some(last) = last_attempt_at {
            let backoff_seconds = 60_i64.saturating_mul(1_i64 << attempt_count.min(10));
            if now - last < backoff_seconds {
                continue;
            }
        }
        tracing::info!(
            sched = %sched_id, video = %video_id, attempt = attempt_count,
            "publish flip due"
        );
        match crate::youtube::publish_now(&video_id).await {
            Ok(()) => {
                sqlx::query("UPDATE scheduled_uploads SET status = 'published' WHERE id = ?")
                    .bind(&sched_id)
                    .execute(pool)
                    .await?;
                tracing::info!(sched = %sched_id, video = %video_id, "publish flip OK");
            }
            Err(e) => {
                // v0.7.12 — bump attempt_count + record error. If we hit
                // MAX_ATTEMPTS, set status='failed' so process_due stops
                // picking this row. The user has to retry manually from
                // the Planificador UI — which is the correct UX for a
                // genuinely-stuck row (expired token, deleted video,
                // etc.) instead of silently burning quota forever.
                let new_attempts = attempt_count + 1;
                let new_status: &str = if new_attempts >= MAX_ATTEMPTS {
                    tracing::error!(
                        sched = %sched_id, video = %video_id,
                        attempts = new_attempts, error = %e,
                        "publish flip failed permanently — moving to status=failed (quota guard)"
                    );
                    "failed"
                } else {
                    tracing::warn!(
                        sched = %sched_id, video = %video_id,
                        attempts = new_attempts, error = %e,
                        "publish flip failed; will retry with exponential backoff"
                    );
                    "uploaded"
                };
                sqlx::query(
                    "UPDATE scheduled_uploads
                        SET error_message = ?,
                            last_attempt_at = ?,
                            attempt_count = ?,
                            status = ?
                      WHERE id = ?",
                )
                .bind(format!("{}", e))
                .bind(chrono::Utc::now().timestamp())
                .bind(new_attempts)
                .bind(new_status)
                .bind(&sched_id)
                .execute(pool)
                .await
                .ok();
            }
        }
    }
    Ok(())
}
