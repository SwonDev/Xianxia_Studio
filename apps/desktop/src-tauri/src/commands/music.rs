//! Music library management commands.
//!
//! All tracks live under `<data_dir>/assets/music/` (Tauri ProjectDirs). On
//! first boot, if the directory is empty we seed it from the workspace's
//! `assets/music` (the bundled "Cultivation" pack), then the user can manage
//! it from Settings: list, add (file picker), remove, open folder.

use anyhow::Result;
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::installer::paths;

const SUPPORTED_EXTENSIONS: &[&str] = &["mp3", "m4a", "wav", "ogg", "flac"];

#[derive(Debug, Serialize, Clone)]
pub struct MusicTrack {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MusicLibrary {
    pub dir: String,
    pub tracks: Vec<MusicTrack>,
    pub total_bytes: u64,
}

fn music_dir() -> Result<PathBuf> {
    let p = paths::paths()?.data_dir.join("assets").join("music");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

fn workspace_music_dir() -> Option<PathBuf> {
    let manifest = option_env!("CARGO_MANIFEST_DIR")?;
    let p = Path::new(manifest)
        .join("..")
        .join("..")
        .join("..")
        .join("assets")
        .join("music");
    p.canonicalize().ok().or_else(|| Some(p))
}

/// Seed the user's music dir from the workspace bundle on first run.
/// Idempotent — only copies tracks the destination doesn't already have.
fn seed_from_workspace_if_empty() -> Result<()> {
    let dest = music_dir()?;
    let entries: Vec<_> = std::fs::read_dir(&dest)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| SUPPORTED_EXTENSIONS.contains(&s.to_lowercase().as_str()))
                .unwrap_or(false)
        })
        .collect();
    if !entries.is_empty() {
        return Ok(());
    }
    let Some(src) = workspace_music_dir() else {
        return Ok(());
    };
    if !src.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&src)?.filter_map(|e| e.ok()) {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase());
        if !ext
            .as_deref()
            .map(|s| SUPPORTED_EXTENSIONS.contains(&s))
            .unwrap_or(false)
        {
            continue;
        }
        let to = dest.join(p.file_name().unwrap());
        if !to.exists() {
            let _ = std::fs::copy(&p, &to);
        }
    }
    Ok(())
}

/// Run on app boot to make sure the music dir exists and is seeded.
pub fn bootstrap() {
    if let Err(e) = seed_from_workspace_if_empty() {
        tracing::warn!(error = %e, "music library bootstrap failed");
    }
}

#[tauri::command]
pub fn music_list_tracks() -> Result<MusicLibrary, String> {
    let dir = music_dir().map_err(|e| e.to_string())?;
    let mut tracks = Vec::new();
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase());
        if !ext
            .as_deref()
            .map(|s| SUPPORTED_EXTENSIONS.contains(&s))
            .unwrap_or(false)
        {
            continue;
        }
        let meta = match std::fs::metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        total += meta.len();
        tracks.push(MusicTrack {
            name: p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("?")
                .to_string(),
            path: p.to_string_lossy().to_string(),
            size_bytes: meta.len(),
            duration_seconds: None, // ffprobe could fill this — kept lightweight for now
        });
    }
    tracks.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(MusicLibrary {
        dir: dir.to_string_lossy().to_string(),
        tracks,
        total_bytes: total,
    })
}

#[tauri::command]
pub fn music_add_tracks(paths: Vec<String>) -> Result<usize, String> {
    let dest_dir = music_dir().map_err(|e| e.to_string())?;
    let mut added = 0usize;
    for src_str in paths {
        let src = PathBuf::from(&src_str);
        if !src.exists() || !src.is_file() {
            continue;
        }
        let ext = src
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase());
        if !ext
            .as_deref()
            .map(|s| SUPPORTED_EXTENSIONS.contains(&s))
            .unwrap_or(false)
        {
            continue;
        }
        let name = src
            .file_name()
            .ok_or_else(|| "invalid filename".to_string())?;
        let to = dest_dir.join(name);
        // Don't overwrite — append a suffix if the name collides
        let final_path = if to.exists() {
            let stem = src
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("track");
            let ext_str = ext.as_deref().unwrap_or("mp3");
            let mut i = 1;
            loop {
                let candidate = dest_dir.join(format!("{} ({}).{}", stem, i, ext_str));
                if !candidate.exists() {
                    break candidate;
                }
                i += 1;
            }
        } else {
            to
        };
        if std::fs::copy(&src, &final_path).is_ok() {
            added += 1;
        }
    }
    Ok(added)
}

#[tauri::command]
pub fn music_remove_track(name: String) -> Result<(), String> {
    let dir = music_dir().map_err(|e| e.to_string())?;
    // Only allow removing files inside the music dir (no path traversal).
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("invalid track name".into());
    }
    let target = dir.join(&name);
    if !target.exists() {
        return Err(format!("track not found: {}", name));
    }
    std::fs::remove_file(&target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn music_open_folder() -> Result<(), String> {
    let dir = music_dir().map_err(|e| e.to_string())?;
    let dir_str = dir.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(&dir_str).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&dir_str).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&dir_str).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn music_get_dir() -> Result<String, String> {
    let d = music_dir().map_err(|e| e.to_string())?;
    Ok(d.to_string_lossy().to_string())
}
