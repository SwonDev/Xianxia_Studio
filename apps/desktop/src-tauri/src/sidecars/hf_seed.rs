//! HuggingFace cache seeder.
//!
//! Avoids re-downloading models when the user already has them in the standard
//! `~/.cache/huggingface/hub/` location (because they ran another Python ML app
//! before, or because they manually pulled with `huggingface-cli`).
//!
//! Strategy: at sidecar boot, scan the user's HF cache for any of our known
//! repos. For each match, hardlink (or copy as fallback) the contents into the
//! Tauri data_dir HF cache (`<data_dir>/hf-cache/hub/`). HuggingFace looks at
//! its own local cache first via standard layout; once seeded, subsequent
//! `from_pretrained` calls find the model with zero re-downloads.
//!
//! Hardlinks save disk space (no duplication on the same volume). On a
//! different volume we fall back to file copy.

use std::path::{Path, PathBuf};

const KNOWN_REPOS: &[&str] = &[
    "Systran/faster-whisper-large-v3",
    "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "Tongyi-MAI/Z-Image-Turbo",
    "Comfy-Org/z_image_turbo",
    "unsloth/Z-Image-Turbo-GGUF",
    "briaai/RMBG-2.0",
];

fn user_hf_hub() -> Option<PathBuf> {
    // Respect HF_HUB_CACHE / HF_HOME if user has them, else default.
    if let Ok(p) = std::env::var("HF_HUB_CACHE") {
        return Some(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("HF_HOME") {
        return Some(PathBuf::from(p).join("hub"));
    }
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    } else {
        std::env::var("HOME").ok().map(PathBuf::from)
    }?;
    Some(home.join(".cache").join("huggingface").join("hub"))
}

fn repo_to_dir(repo: &str) -> String {
    // HF cache layout: hub/models--<org>--<name>/
    format!("models--{}", repo.replace('/', "--"))
}

/// Walk a directory and hardlink (or copy) every file into the matching
/// position under `dst_root`. Existing files at the destination are left
/// untouched (idempotent).
fn link_tree(src: &Path, dst: &Path) -> std::io::Result<usize> {
    let mut linked = 0usize;
    if !src.exists() {
        return Ok(0);
    }
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let name = entry.file_name();
        let dst_path = dst.join(&name);
        if src_path.is_dir() {
            linked += link_tree(&src_path, &dst_path)?;
        } else if !dst_path.exists() {
            // Try hardlink first (zero copy), fall back to copy.
            if std::fs::hard_link(&src_path, &dst_path).is_err() {
                std::fs::copy(&src_path, &dst_path)?;
            }
            linked += 1;
        }
    }
    Ok(linked)
}

/// Bootstrap step run before the Python sidecar spawns. Idempotent.
pub fn seed_from_user_cache(target_hf_home: &Path) {
    let user_hub = match user_hf_hub() {
        Some(p) if p.exists() => p,
        _ => {
            tracing::debug!("no user HF cache to seed from");
            return;
        }
    };
    let target_hub = target_hf_home.join("hub");
    if let Err(e) = std::fs::create_dir_all(&target_hub) {
        tracing::warn!(error=%e, "could not create target hf hub dir");
        return;
    }

    let mut total = 0usize;
    for repo in KNOWN_REPOS {
        let repo_dir = repo_to_dir(repo);
        let src = user_hub.join(&repo_dir);
        if !src.exists() {
            continue;
        }
        let dst = target_hub.join(&repo_dir);
        match link_tree(&src, &dst) {
            Ok(n) if n > 0 => {
                tracing::info!(repo, files = n, "seeded HF model from user cache");
                total += n;
            }
            Ok(_) => {} // nothing new — already seeded
            Err(e) => tracing::warn!(repo, error=%e, "seed failed"),
        }
    }
    if total > 0 {
        tracing::info!(total, "HF cache seeding complete — no re-downloads needed");
    }
}
