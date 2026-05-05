use anyhow::Result;

use super::{now_unix, DbPool};

pub async fn get(pool: &DbPool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(v,)| v))
}

pub async fn set(pool: &DbPool, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value)
    .bind(now_unix())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_bool(pool: &DbPool, key: &str, default: bool) -> Result<bool> {
    Ok(get(pool, key).await?.map(|v| v == "true").unwrap_or(default))
}

pub async fn set_bool(pool: &DbPool, key: &str, value: bool) -> Result<()> {
    set(pool, key, if value { "true" } else { "false" }).await
}
