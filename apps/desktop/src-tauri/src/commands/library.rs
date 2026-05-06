//! Library: list finished videos + extract poster thumbnails on demand.
//!
//! Videos live under `<data_dir>/projects/`. For each MP4 we generate (lazily)
//! a poster JPG at 10 % of the video duration, stored next to the MP4 with the
//! same stem + `.poster.jpg`. The Tauri webview serves these via the asset
//! protocol (convertFileSrc).

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::installer::paths;

#[derive(Debug, Serialize, Clone)]
pub struct LibraryVideo {
    pub project_id: String,
    pub title: String,
    pub video_path: String,
    pub poster_path: Option<String>,
    pub size_bytes: u64,
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub modified_at: i64,
}

fn projects_dir() -> Result<PathBuf> {
    let p = paths::paths()?.data_dir.join("projects");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

fn ffprobe_meta(mp4: &Path) -> (Option<f64>, Option<u32>, Option<u32>) {
    let out = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height:format=duration",
            "-of", "default=nw=1:nk=1",
            mp4.to_string_lossy().as_ref(),
        ])
        .output();
    if let Ok(o) = out {
        let s = String::from_utf8_lossy(&o.stdout);
        let mut lines = s.lines().filter(|l| !l.trim().is_empty());
        let w = lines.next().and_then(|x| x.trim().parse::<u32>().ok());
        let h = lines.next().and_then(|x| x.trim().parse::<u32>().ok());
        let dur = lines.next().and_then(|x| x.trim().parse::<f64>().ok());
        return (dur, w, h);
    }
    (None, None, None)
}

fn ensure_poster(mp4: &Path) -> Option<PathBuf> {
    let stem = mp4.file_stem()?.to_string_lossy().to_string();
    let poster = mp4.with_file_name(format!("{}.poster.jpg", stem));
    if poster.exists() {
        return Some(poster);
    }
    // Probe duration first to seek at 10%.
    let (dur, _, _) = ffprobe_meta(mp4);
    let seek = dur.map(|d| d * 0.10).unwrap_or(2.0);

    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-ss", &format!("{:.3}", seek),
            "-i", mp4.to_string_lossy().as_ref(),
            "-frames:v", "1",
            "-vf", "scale=640:-2",
            "-q:v", "3",
            poster.to_string_lossy().as_ref(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if matches!(status, Ok(s) if s.success()) && poster.exists() {
        Some(poster)
    } else {
        None
    }
}

#[tauri::command]
pub async fn library_list_videos() -> Result<Vec<LibraryVideo>, String> {
    let dir = projects_dir().map_err(|e| e.to_string())?;
    let mut videos: Vec<LibraryVideo> = Vec::new();

    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext.to_lowercase().as_str(), "mp4" | "mov" | "mkv") {
            continue;
        }
        // Skip per-chunk intermediates produced by the chunked render pipeline.
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if stem.starts_with("chunk-") || stem.starts_with("concat-") {
            continue;
        }

        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let (dur, w, h) = ffprobe_meta(&path);
        let poster = ensure_poster(&path);

        videos.push(LibraryVideo {
            project_id: stem.to_string(),
            title: stem.to_string(),
            video_path: path.to_string_lossy().to_string(),
            poster_path: poster.map(|p| p.to_string_lossy().to_string()),
            size_bytes: meta.len(),
            duration_seconds: dur,
            width: w,
            height: h,
            modified_at,
        });
    }

    videos.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(videos)
}

#[tauri::command]
pub async fn library_delete_video(video_path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&video_path);
    let dir = projects_dir().map_err(|e| e.to_string())?;
    // Path-traversal guard.
    let canonical_target = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    let canonical_dir = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    if !canonical_target.starts_with(&canonical_dir) {
        return Err(format!(
            "refusing to delete file outside library: {}",
            video_path
        ));
    }
    std::fs::remove_file(&canonical_target).map_err(|e| e.to_string())?;
    // Also drop the poster if it exists.
    if let Some(stem) = canonical_target.file_stem().and_then(|s| s.to_str()) {
        let poster = canonical_target.with_file_name(format!("{}.poster.jpg", stem));
        let _ = std::fs::remove_file(&poster);
    }
    Ok(())
}

#[tauri::command]
pub async fn library_open_video_folder() -> Result<String, String> {
    let dir = projects_dir().map_err(|e| e.to_string())?;
    // Open the OS file explorer directly from Rust — bypasses the shell:open
    // permission scope (which only allows http(s)/mailto/tel URLs by default
    // and rejects raw Windows paths with a regex validation error).
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&dir).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    }
    Ok(dir.to_string_lossy().to_string())
}

#[allow(dead_code)]
fn _unused() -> Result<()> { Err(anyhow!("unused")) }
