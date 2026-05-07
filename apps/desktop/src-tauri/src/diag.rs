//! Structured JSONL logging + log rotation for the Rust supervisor.
//!
//! Emits every tracing event as a JSON line into
//! `<cache_dir>/logs/pipeline-rust.jsonl`. The format matches the schema
//! used by the Python sidecar (`xianxia_ai.logging_utils`) and Node
//! sidecar (Pino) so the `/diag/snapshot` endpoint can merge all four
//! streams into a single chronological view.
//!
//! Rotation: at startup, files older than `RETAIN_DAYS` (default 7) are
//! gzipped into `archive/` and the live file is removed. Files in
//! `archive/` older than `ARCHIVE_DAYS` (default 28) are deleted. Total
//! disk footprint stays under ~80 MB even on heavy testing weeks.

use anyhow::Result;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing_subscriber::fmt::writer::BoxMakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::installer::paths;

const RETAIN_DAYS: u64 = 7;
const ARCHIVE_DAYS: u64 = 28;

/// Initialise both a console layer (for dev) and a JSONL file layer (for
/// production observability). Idempotent.
pub fn init() -> Result<()> {
    let log_dir = match cache_log_dir() {
        Ok(p) => p,
        Err(_) => {
            // Fallback to console-only logging if we can't resolve the
            // cache dir (e.g. ProjectDirs not available in some sandboxes).
            tracing_subscriber::fmt()
                .with_env_filter(
                    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
                )
                .init();
            return Ok(());
        }
    };
    fs::create_dir_all(&log_dir)?;

    let jsonl_path = log_dir.join("pipeline-rust.jsonl");
    // Append mode so subsequent app launches add to the same file. Rotation
    // moves the file aside when stale.
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&jsonl_path)?;

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let json_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_current_span(true)
        .with_span_list(false)
        .with_target(true)
        .with_thread_ids(false)
        .with_writer(BoxMakeWriter::new(std::sync::Mutex::new(file)));

    let console_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_writer(std::io::stderr);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(json_layer)
        .with(console_layer)
        .init();

    tracing::info!(
        log_dir = %log_dir.display(),
        jsonl = %jsonl_path.display(),
        "rust JSONL logger initialised"
    );
    Ok(())
}

/// Returns `<cache_dir>/logs`. Uses ProjectDirs to match the path the
/// Python sidecar resolves.
pub fn cache_log_dir() -> Result<PathBuf> {
    let p = paths::paths()?;
    Ok(p.cache_dir.join("logs"))
}

/// Rotate stale log files into the archive and prune the archive itself.
/// Idempotent: safe to call from setup() on every launch.
pub fn rotate_logs() -> Result<usize> {
    let dir = cache_log_dir()?;
    if !dir.exists() {
        return Ok(0);
    }
    let archive = dir.join("archive");
    fs::create_dir_all(&archive)?;
    let now = SystemTime::now();
    let mut rotated = 0;

    for entry in fs::read_dir(&dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        // Skip files already gzipped and the archive dir itself
        if name.ends_with(".gz") || name == "archive" {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(now);
        let age_days = now
            .duration_since(mtime)
            .map(|d| d.as_secs() / 86400)
            .unwrap_or(0);
        if age_days <= RETAIN_DAYS {
            continue;
        }
        // Archive: gzip into archive/<name>.gz, then delete the original.
        let dest = archive.join(format!("{name}.gz"));
        if let Err(e) = gzip_file(&path, &dest) {
            tracing::warn!(?path, error = %e, "log gzip failed; leaving file intact");
            continue;
        }
        if let Err(e) = fs::remove_file(&path) {
            tracing::warn!(?path, error = %e, "log original delete failed");
            continue;
        }
        rotated += 1;
    }

    // Prune archive/ entries older than ARCHIVE_DAYS
    if archive.exists() {
        for entry in fs::read_dir(&archive)? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(now);
            let age_days = now
                .duration_since(mtime)
                .map(|d| d.as_secs() / 86400)
                .unwrap_or(0);
            if age_days > ARCHIVE_DAYS {
                let _ = fs::remove_file(&path);
            }
        }
    }

    if rotated > 0 {
        tracing::info!(rotated, "log rotation complete");
    }
    Ok(rotated)
}

fn gzip_file(src: &Path, dest: &Path) -> Result<()> {
    use std::io::{Read, Write};

    let mut input = fs::File::open(src)?;
    let mut data = Vec::new();
    input.read_to_end(&mut data)?;
    let out = fs::File::create(dest)?;
    let mut encoder = flate2::write::GzEncoder::new(out, flate2::Compression::default());
    encoder.write_all(&data)?;
    encoder.finish()?;
    Ok(())
}

/// Periodic VRAM snapshot writer. Spawned by the Tauri setup hook; it
/// captures the cross-process VRAM state every 30 s and appends a
/// JSONL line to `<cache_dir>/logs/vram.jsonl`. Lets us correlate
/// pipeline phase transitions with actual VRAM usage when diagnosing
/// races between unloads and loads.
pub async fn vram_monitor_loop() {
    use serde_json::json;
    use std::io::Write;
    use tokio::time::{sleep, Duration};

    let log_dir = match cache_log_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    if let Err(e) = fs::create_dir_all(&log_dir) {
        tracing::warn!(error = %e, "vram_monitor: cannot create log dir, exiting");
        return;
    }
    let path = log_dir.join("vram.jsonl");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    loop {
        sleep(Duration::from_secs(30)).await;
        let comfy = client
            .get("http://127.0.0.1:8188/system_stats")
            .send()
            .await
            .ok();
        let comfy_devices: Vec<serde_json::Value> = match comfy {
            Some(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
                Ok(j) => j
                    .get("devices")
                    .and_then(|d| d.as_array())
                    .cloned()
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            },
            _ => Vec::new(),
        };
        let comfy_summary: Vec<_> = comfy_devices
            .iter()
            .map(|d| {
                let total = d.get("vram_total").and_then(|v| v.as_u64()).unwrap_or(0);
                let free = d.get("vram_free").and_then(|v| v.as_u64()).unwrap_or(0);
                json!({
                    "name": d.get("name").and_then(|v| v.as_str()),
                    "vram_total_gb": (total as f64) / (1024.0_f64.powi(3)),
                    "vram_free_gb": (free as f64) / (1024.0_f64.powi(3)),
                })
            })
            .collect();

        let ollama = client
            .get("http://127.0.0.1:11434/api/ps")
            .send()
            .await
            .ok();
        let ollama_models: Vec<serde_json::Value> = match ollama {
            Some(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
                Ok(j) => j
                    .get("models")
                    .and_then(|m| m.as_array())
                    .cloned()
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            },
            _ => Vec::new(),
        };
        let ollama_summary: Vec<_> = ollama_models
            .iter()
            .map(|m| {
                let size = m.get("size_vram").and_then(|v| v.as_u64()).unwrap_or(0);
                json!({
                    "name": m.get("name").and_then(|v| v.as_str()),
                    "size_vram_gb": (size as f64) / (1024.0_f64.powi(3)),
                    "expires_at": m.get("expires_at"),
                })
            })
            .collect();

        let line = json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "level": "info",
            "source": "vram",
            "comfyui": comfy_summary,
            "ollama_running": ollama_summary,
        });
        // Append-only single line. We tolerate transient write errors
        // (file locked by the rotation step, antivirus etc).
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "{}", line);
        }
    }
}
