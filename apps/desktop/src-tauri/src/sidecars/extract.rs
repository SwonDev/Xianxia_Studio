//! First-run extraction of bundled sidecars.
//!
//! The Tauri installer ships `sidecar-py/` and `sidecar-node/` as resources at
//! `<install-dir>/resources/sidecars/`. On first launch (or when the bundle's
//! version changes), we copy them into `<data_dir>/runtime/sidecar-{py,node}/`
//! so the supervisor can spawn them like any user-installed runtime.
//!
//! A small `.bundle-version` marker inside each runtime dir lets us detect
//! when the user has updated the app and we need to refresh the source.

use anyhow::{anyhow, Context, Result};
use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::installer::paths;

const BUNDLE_VERSION: &str = env!("CARGO_PKG_VERSION");
const MARKER: &str = ".bundle-version";

/// Copies bundled sidecars into the runtime dir. Idempotent.
///
/// - Returns Ok even when no resources are present (dev mode → resolved via
///   workspace_root() instead).
/// - Re-extracts when the version marker mismatches the current app version.
pub fn extract_bundled_sidecars(app: &AppHandle) -> Result<()> {
    let resource_root = match app.path().resource_dir() {
        Ok(p) => p.join("sidecars"),
        Err(_) => return Ok(()),
    };
    if !resource_root.exists() {
        tracing::debug!(?resource_root, "no bundled sidecars found (dev mode?)");
        return Ok(());
    }

    let runtime = paths::runtime_dir().context("runtime dir")?;
    for name in &["sidecar-py", "sidecar-node"] {
        let src = resource_root.join(name);
        if !src.exists() {
            tracing::warn!(?src, "expected bundled sidecar missing");
            continue;
        }
        let dst = runtime.join(name);
        if needs_refresh(&dst)? {
            tracing::info!(name, ?src, ?dst, "extracting bundled sidecar");
            if dst.exists() {
                std::fs::remove_dir_all(&dst).ok();
            }
            copy_dir(&src, &dst)?;
            std::fs::write(dst.join(MARKER), BUNDLE_VERSION)
                .context("write bundle-version marker")?;
        } else {
            tracing::debug!(name, "bundled sidecar already up to date");
        }
    }
    Ok(())
}

fn needs_refresh(dst: &Path) -> Result<bool> {
    if !dst.exists() {
        return Ok(true);
    }
    let marker = dst.join(MARKER);
    if !marker.exists() {
        return Ok(true);
    }
    let installed = std::fs::read_to_string(&marker).unwrap_or_default();
    Ok(installed.trim() != BUNDLE_VERSION)
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst).with_context(|| format!("mkdir {}", dst.display()))?;
    for entry in std::fs::read_dir(src).with_context(|| format!("read_dir {}", src.display()))? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to)
                .with_context(|| format!("copy {} -> {}", from.display(), to.display()))?;
        } else if ft.is_symlink() {
            // Resolve symlinks (pnpm-style) by copying target instead of the link
            let real = std::fs::canonicalize(&from)?;
            if real.is_dir() {
                copy_dir(&real, &to)?;
            } else {
                std::fs::copy(&real, &to)?;
            }
        } else {
            return Err(anyhow!("unsupported file type at {}", from.display()));
        }
    }
    Ok(())
}
