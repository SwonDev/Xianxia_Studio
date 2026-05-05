use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

pub type ProgressCb = Box<dyn Fn(u64, u64) + Send + Sync>;

/// Resumable download with optional SHA256 verification.
/// If a partial file exists at `dest`, attempts to resume via Range header.
pub async fn download(
    url: &str,
    dest: &Path,
    expected_sha256: Option<&str>,
    on_progress: Option<ProgressCb>,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 60))
        .build()?;

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    // Determine resume offset
    let existing_size = tokio::fs::metadata(dest).await.ok().map(|m| m.len()).unwrap_or(0);

    let mut request = client.get(url);
    if existing_size > 0 {
        request = request.header("Range", format!("bytes={}-", existing_size));
    }
    let response = request.send().await.context("download request failed")?;
    let status = response.status();
    let total = response
        .content_length()
        .map(|l| l + existing_size)
        .unwrap_or(0);

    if !status.is_success() && status.as_u16() != 206 {
        return Err(anyhow!("download failed: HTTP {}", status));
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(status.as_u16() == 206 && existing_size > 0)
        .truncate(status.as_u16() != 206 || existing_size == 0)
        .write(true)
        .open(dest)
        .await?;

    if status.as_u16() == 206 && existing_size > 0 {
        file.seek(std::io::SeekFrom::End(0)).await?;
    }

    let mut downloaded = existing_size;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if let Some(ref cb) = on_progress {
            cb(downloaded, total);
        }
    }
    file.flush().await?;
    drop(file);

    if let Some(expected) = expected_sha256 {
        verify_sha256(dest, expected).await?;
    }
    Ok(())
}

pub async fn verify_sha256(path: &Path, expected: &str) -> Result<()> {
    let bytes = tokio::fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(anyhow!(
            "checksum mismatch on {}: expected {}, got {}",
            path.display(),
            expected,
            actual
        ));
    }
    Ok(())
}
