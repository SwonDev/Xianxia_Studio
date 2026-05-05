use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::oauth;

#[derive(Debug, Serialize, Deserialize)]
pub struct CaptionTrack {
    pub language: String,
    pub name: String,
    pub srt_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UploadRequest {
    pub project_id: String,
    pub video_path: String,
    pub thumbnail_path: Option<String>,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub category_id: String,
    pub privacy_status: String,
    pub publish_at: Option<i64>,
    pub captions: Vec<CaptionTrack>,
    pub contains_synthetic_media: bool,
}

#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub video_id: String,
}

pub async fn upload(req: UploadRequest) -> Result<UploadResponse> {
    let mut creds = oauth::load_credentials()?
        .ok_or_else(|| anyhow::anyhow!("YouTube not authorized — run /settings to connect"))?;

    if creds.expires_at.unwrap_or(0) < chrono::Utc::now().timestamp() + 60 {
        oauth::refresh_access_token(&mut creds).await?;
        oauth::store_credentials(&creds)?;
    }
    let token = creds.access_token.as_deref().unwrap_or("");

    let client = reqwest::Client::new();

    // Step 1 — initiate resumable session
    let body = serde_json::json!({
        "snippet": {
            "title": req.title,
            "description": req.description,
            "tags": req.tags,
            "categoryId": req.category_id,
        },
        "status": {
            "privacyStatus": req.privacy_status,
            "publishAt": req.publish_at.map(|ts| chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0).map(|d| d.to_rfc3339())).flatten(),
            "selfDeclaredMadeForKids": false,
            "containsSyntheticMedia": req.contains_synthetic_media,
        },
    });
    let init = client
        .post("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status")
        .bearer_auth(token)
        .header("X-Upload-Content-Type", "video/*")
        .json(&body)
        .send()
        .await?;
    if !init.status().is_success() {
        return Err(anyhow::anyhow!("init upload failed: {}", init.text().await?));
    }
    let upload_url = init
        .headers()
        .get("location")
        .ok_or_else(|| anyhow::anyhow!("missing Location header"))?
        .to_str()?
        .to_string();

    // Step 2 — upload bytes (single PUT for files <100MB; chunked otherwise)
    let video_bytes = tokio::fs::read(&req.video_path)
        .await
        .with_context(|| format!("read {}", req.video_path))?;
    let resp = client
        .put(&upload_url)
        .body(video_bytes)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("upload PUT failed: {}", resp.text().await?));
    }
    let video_resource: serde_json::Value = resp.json().await?;
    let video_id = video_resource["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("no video id"))?
        .to_string();

    // Step 3 — thumbnail
    if let Some(thumb) = &req.thumbnail_path {
        let _ = upload_thumbnail(&client, token, &video_id, thumb).await;
    }

    // Step 4 — captions
    for cap in &req.captions {
        let _ = upload_caption(&client, token, &video_id, cap).await;
    }

    Ok(UploadResponse { video_id })
}

async fn upload_thumbnail(
    client: &reqwest::Client,
    token: &str,
    video_id: &str,
    path: &str,
) -> Result<()> {
    let bytes = tokio::fs::read(path).await?;
    let resp = client
        .post(format!(
            "https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId={}",
            video_id
        ))
        .bearer_auth(token)
        .header("Content-Type", "image/jpeg")
        .body(bytes)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("thumbnail upload: {}", resp.text().await?));
    }
    Ok(())
}

async fn upload_caption(
    client: &reqwest::Client,
    token: &str,
    video_id: &str,
    cap: &CaptionTrack,
) -> Result<()> {
    let srt = tokio::fs::read(&cap.srt_path).await?;
    // Captions API expects multipart; simpler to use the resumable variant.
    let metadata = serde_json::json!({
        "snippet": {
            "videoId": video_id,
            "language": cap.language,
            "name": cap.name,
            "isDraft": false,
        }
    });
    let init = client
        .post("https://www.googleapis.com/upload/youtube/v3/captions?uploadType=resumable&part=snippet")
        .bearer_auth(token)
        .header("X-Upload-Content-Type", "application/octet-stream")
        .json(&metadata)
        .send()
        .await?;
    let url = init
        .headers()
        .get("location")
        .ok_or_else(|| anyhow::anyhow!("captions: no location"))?
        .to_str()?
        .to_string();
    let resp = client.put(url).body(srt).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("caption upload: {}", resp.text().await?));
    }
    Ok(())
}

pub async fn publish_now(video_id: &str) -> Result<()> {
    let mut creds = oauth::load_credentials()?
        .ok_or_else(|| anyhow::anyhow!("not authorized"))?;
    if creds.expires_at.unwrap_or(0) < chrono::Utc::now().timestamp() + 60 {
        oauth::refresh_access_token(&mut creds).await?;
        oauth::store_credentials(&creds)?;
    }
    let token = creds.access_token.as_deref().unwrap_or("");
    let body = serde_json::json!({
        "id": video_id,
        "status": { "privacyStatus": "public" }
    });
    let resp = reqwest::Client::new()
        .put("https://www.googleapis.com/youtube/v3/videos?part=status")
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("publish failed: {}", resp.text().await?));
    }
    Ok(())
}

#[allow(dead_code)]
fn _suppress(p: &Path) -> &Path {
    p
}
