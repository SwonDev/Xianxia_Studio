use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

use super::paths;
use crate::process_ext::HideConsole;

/// Python interpreter binary inside the embedded Python tree.
pub fn python_exe() -> Result<PathBuf> {
    let dir = paths::python_dir()?;
    #[cfg(target_os = "windows")]
    let exe = dir.join("python").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let exe = dir.join("python").join("bin").join("python3");
    Ok(exe)
}

/// Resolve a Python interpreter, preferring embedded → falling back to system.
/// Used by the supervisor and runner so the user's system Python (if compatible)
/// is reused instead of forcing the 30 MB embedded download.
pub fn python_exe_resolved() -> Result<PathBuf> {
    let embedded = python_exe()?;
    if embedded.exists() {
        return Ok(embedded);
    }
    if let Some(sys) = super::detect::resolved_python() {
        return Ok(sys);
    }
    Ok(embedded) // returns the path even if it doesn't exist (caller handles)
}

pub async fn ensure_pip(py: &Path) -> Result<()> {
    let status = Command::new(py)
        .args(["-m", "ensurepip", "--upgrade"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .hide_console()
        .status()
        .await
        .context("failed to invoke ensurepip")?;
    if !status.success() {
        return Err(anyhow::anyhow!("ensurepip failed"));
    }
    Ok(())
}

pub async fn pip_install(py: &Path, requirements: &Path) -> Result<()> {
    let status = Command::new(py)
        .args([
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--no-cache-dir",
            "-r",
            requirements.to_str().unwrap(),
        ])
        .hide_console()
        .status()
        .await
        .context("pip install failed to spawn")?;
    if !status.success() {
        return Err(anyhow::anyhow!("pip install -r {} failed", requirements.display()));
    }
    Ok(())
}

/// Extract a tarball (.tar.gz) into the target directory.
pub fn extract_targz(archive: &Path, target: &Path) -> Result<()> {
    use flate2::read::GzDecoder;
    use tar::Archive;
    let file = std::fs::File::open(archive)?;
    let dec = GzDecoder::new(file);
    let mut ar = Archive::new(dec);
    std::fs::create_dir_all(target)?;
    ar.unpack(target)?;
    Ok(())
}

/// Extract a ZIP archive into the target directory.
pub fn extract_zip(archive: &Path, target: &Path) -> Result<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    std::fs::create_dir_all(target)?;
    zip.extract(target)?;
    Ok(())
}
