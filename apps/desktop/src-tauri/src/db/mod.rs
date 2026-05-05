use anyhow::Result;
use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::path::PathBuf;
use std::str::FromStr;

pub mod projects;
pub mod settings;

pub type DbPool = Pool<Sqlite>;

pub async fn init_pool() -> Result<DbPool> {
    let path = db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let url = format!("sqlite://{}", path.to_string_lossy().replace('\\', "/"));
    let options = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!(path = %path.display(), "database ready");
    Ok(pool)
}

pub fn db_path() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("studio", "xianxia", "XianxiaStudio")
        .ok_or_else(|| anyhow::anyhow!("cannot resolve project dirs"))?;
    Ok(dirs.data_dir().join("xianxia.db"))
}

pub fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}
