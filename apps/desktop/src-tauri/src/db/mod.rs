use anyhow::Result;
use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::path::PathBuf;
use std::str::FromStr;

pub mod projects;
pub mod settings;
pub mod voices;

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

/// Last-resort in-memory pool used by the setup hook when the on-disk DB
/// can't be opened (corrupt file, locked by another process, FS permissions).
/// The app still loads and the user can operate the services UI; project
/// CRUD reverts to volatile state until the next launch fixes the on-disk DB.
pub async fn init_memory_pool() -> Result<DbPool> {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")?
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::warn!("running with in-memory SQLite fallback (data not persisted)");
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
