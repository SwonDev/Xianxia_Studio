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
use crate::process_ext::HideConsole;

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

/// Library selection priority by file stem.
/// 3 = burned-in subtitled output (`*.subs.mp4`) — what the user actually
///     wants to play.
/// 2 = canonical un-subbed `video.mp4`.
/// 1 = any other non-intermediate mp4/mov/mkv.
fn video_rank(stem: &str) -> u8 {
    let s = stem.to_lowercase();
    if s.ends_with(".subs") || s.contains(".subs") {
        3
    } else if s == "video" {
        2
    } else {
        1
    }
}

fn ffprobe_meta(mp4: &Path) -> (Option<f64>, Option<u32>, Option<u32>) {
    let out = Command::new("ffprobe")
        .hide_console()
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
        .hide_console()
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

    // Each project lives under `<projects>/<ULID>/...`. The pipeline writes
    // the final MP4 inside that ULID directory (`video-<hash>.mp4` for the
    // narrative pass, plus a `video.base.mp4` intermediate from HyperFrames
    // and sometimes a 0-byte `video.mp4` placeholder when postProcessCinematic
    // fails). We walk one level deep so the library actually surfaces those
    // renders — the previous flat read_dir scan only saw the project
    // directories themselves and produced an empty library forever.
    let top_entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for top in top_entries.flatten() {
        let project_path = top.path();
        let project_id = match project_path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        // Candidates: any mp4/mov/mkv inside this project dir (top level).
        // We deliberately do NOT recurse into nested HyperFrames composition
        // dirs (`<ULID>-narrative-proj/`) — those hold raw assets, not
        // playable outputs.
        let mut best: Option<(PathBuf, std::fs::Metadata)> = None;
        let inner = match std::fs::read_dir(&project_path) {
            Ok(it) => it,
            Err(_) => continue, // project_path may be a file (legacy) — skip
        };
        for entry in inner.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !matches!(ext.to_lowercase().as_str(), "mp4" | "mov" | "mkv") {
                continue;
            }
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            // Skip pipeline intermediates: HyperFrames base render, chunked
            // intermediates, and the 0-byte placeholder left when the
            // postProcessCinematic step fails. Filtering by suffix + size
            // is robust against the project layout changing later.
            if stem == "video.base"
                || stem.ends_with(".base")
                || stem.starts_with("chunk-")
                || stem.starts_with("concat-")
            {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() == 0 {
                // 0-byte file = aborted render — never surface it as a
                // playable video. The user already saw the bug; the file
                // stays on disk for diagnosis but the library hides it.
                continue;
            }
            let rank = video_rank(stem);
            let entry_mtime = meta.modified().ok();
            let take = match best.as_ref() {
                None => true,
                Some((prev_path, prev_meta)) => {
                    let prev_stem = prev_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    let prev_rank = video_rank(prev_stem);
                    if rank != prev_rank {
                        rank > prev_rank
                    } else {
                        entry_mtime
                            .zip(prev_meta.modified().ok())
                            .map(|(a, b)| a > b)
                            .unwrap_or(false)
                    }
                }
            };
            if take {
                best = Some((p.clone(), meta));
            }
        }

        let (path, meta) = match best {
            Some(b) => b,
            None => continue,
        };
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let (dur, w, h) = ffprobe_meta(&path);
        let poster = ensure_poster(&path);
        // Title falls back to the project_id (ULID); a future migration can
        // join with `projects.title` from the DB once that's persisting again.
        videos.push(LibraryVideo {
            project_id,
            title: path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("video")
                .to_string(),
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

/// Reveal a specific produced MP4 in the OS file explorer with the file
/// pre-selected. Used by the TikTok assisted-publish flow so the user can
/// drag the rendered Short straight into TikTok's web uploader. Same Rust
/// `std::process::Command` approach as `library_open_video_folder` (the
/// shell:open scope rejects raw Windows paths).
#[tauri::command]
pub async fn library_reveal_video(video_path: String) -> Result<(), String> {
    let p = std::path::Path::new(&video_path);
    if !p.exists() {
        return Err(format!("El archivo no existe: {video_path}"));
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{video_path}"))
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg("-R").arg(&video_path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        // No portable "select" — fall back to opening the containing folder.
        if let Some(dir) = p.parent() {
            let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn _unused() -> Result<()> { Err(anyhow!("unused")) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subs_mp4_outranks_canonical_video() {
        // Regression for the bug the user hit: library_list_videos was
        // returning `video-<hash>.mp4` (un-subbed, just bigger because of
        // codec settings) instead of `video-<hash>.subs.mp4` even though
        // the latter is the burned-in output that should be played.
        assert!(video_rank("video-abc.subs") > video_rank("video-abc"));
        assert!(video_rank("video-abc.subs") > video_rank("video"));
        assert_eq!(video_rank("video"), 2);
        assert_eq!(video_rank("video-abc"), 1);
        assert_eq!(video_rank("video-abc.subs"), 3);
    }

    #[test]
    fn subs_rank_is_case_insensitive() {
        assert_eq!(video_rank("Video.SUBS"), 3);
        assert_eq!(video_rank("VIDEO"), 2);
    }
}
