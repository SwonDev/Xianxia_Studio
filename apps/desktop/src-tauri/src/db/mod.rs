use anyhow::Result;
use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::path::PathBuf;
use std::str::FromStr;

pub mod chapters;
pub mod projects;
pub mod scheduled;
pub mod settings;
pub mod voices;

pub type DbPool = Pool<Sqlite>;

pub async fn init_pool() -> Result<DbPool> {
    let path = db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    match try_open_pool(&path).await {
        Ok(pool) => {
            tracing::info!(path = %path.display(), "database ready");
            Ok(pool)
        }
        Err(err) => {
            // Auto-heal for the upgrade hazard the project hit between
            // v0.1.7 → v0.1.11: an earlier release shipped a modified
            // 0001_init.sql, every user that installed it has the
            // *modified* hash recorded in their _sqlx_migrations table.
            // When v0.1.11 reverts 0001 to its canonical hash, sqlx
            // refuses to migrate with "migration N was previously
            // applied but has been modified", forcing the app into the
            // memory-pool fallback and losing project persistence.
            //
            // Strategy: detect THAT specific error, archive the broken
            // DB to <path>.broken-<unixsec>, and re-create from scratch.
            // Users only lose project rows (the actual MP4 + assets on
            // disk are kept and re-surface via library_list_videos),
            // which is a small price compared to "library is empty
            // forever and projects don't persist".
            let msg = format!("{:#}", err);
            let is_migration_mismatch = msg.contains("previously applied")
                && msg.contains("has been modified");
            if !is_migration_mismatch {
                return Err(err);
            }
            tracing::warn!(
                error = %msg,
                "detected migration hash mismatch from a previous release; \
                 archiving the old DB and re-creating it",
            );
            archive_and_recreate_db(&path).await
        }
    }
}

async fn try_open_pool(path: &PathBuf) -> Result<DbPool> {
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
    Ok(pool)
}

/// Move the corrupted DB aside (so a curious user can still open it
/// with sqlite3 if they want) and create a fresh one. Best-effort: if
/// archiving fails we fall through to outright deletion so the user is
/// never stuck behind a permanently-broken DB.
async fn archive_and_recreate_db(path: &PathBuf) -> Result<DbPool> {
    let ts = chrono::Utc::now().timestamp();
    let archive = path.with_extension(format!("broken-{ts}.db"));
    // Move WAL + SHM siblings too — leaving them behind would corrupt
    // the new DB on its first commit.
    let wal = path.with_extension("db-wal");
    let shm = path.with_extension("db-shm");
    let _ = std::fs::rename(path, &archive);
    let _ = std::fs::remove_file(&wal);
    let _ = std::fs::remove_file(&shm);
    tracing::info!(
        archived = %archive.display(),
        "previous DB archived; opening a fresh one",
    );
    try_open_pool(path).await
}

/// Last-resort in-memory pool used by the setup hook when the on-disk DB
/// can't be opened (corrupt file, locked by another process, FS permissions).
/// The app still loads and the user can operate the services UI; project
/// CRUD reverts to volatile state until the next launch fixes the on-disk DB.
///
/// IMPORTANT: SQLite `:memory:` URIs give every connection its OWN database.
/// With `max_connections > 1`, migrations apply on the first connection and
/// the rest stay empty, surfacing as "no such table" errors mid-pipeline.
/// We use the `file::memory:?cache=shared` URI form so all connections share
/// the same in-memory database (kept alive by the pool's reference count).
pub async fn init_memory_pool() -> Result<DbPool> {
    let options = SqliteConnectOptions::from_str("sqlite:file::memory:?cache=shared")?
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
