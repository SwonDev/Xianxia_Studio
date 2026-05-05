//! Tauri command handlers for the YouTube auth + upload flow.

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use super::oauth::{self, AppCredentials};
use super::upload::{self, UploadRequest, UploadResponse};

#[derive(Serialize)]
pub struct AppCredentialsStatus {
    pub configured: bool,
    pub client_id_preview: Option<String>,
}

#[tauri::command]
pub fn youtube_app_status() -> Result<AppCredentialsStatus, String> {
    let app = oauth::load_app_credentials().map_err(|e| e.to_string())?;
    let preview = app.as_ref().map(|c| {
        let len = c.client_id.len();
        if len <= 12 {
            c.client_id.clone()
        } else {
            format!("{}…{}", &c.client_id[..8], &c.client_id[len - 4..])
        }
    });
    Ok(AppCredentialsStatus {
        configured: app.is_some(),
        client_id_preview: preview,
    })
}

#[tauri::command]
pub fn youtube_set_app_credentials(client_id: String, client_secret: String) -> Result<(), String> {
    let creds = AppCredentials { client_id, client_secret };
    oauth::store_app_credentials(&creds).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn youtube_clear_app_credentials() -> Result<(), String> {
    let _ = oauth::delete_credentials();
    oauth::delete_app_credentials().map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct YouTubeStatus {
    pub connected: bool,
    pub expires_at: Option<i64>,
}

#[tauri::command]
pub fn youtube_status() -> Result<YouTubeStatus, String> {
    let creds = oauth::load_credentials().map_err(|e| e.to_string())?;
    Ok(YouTubeStatus {
        connected: creds.is_some(),
        expires_at: creds.and_then(|c| c.expires_at),
    })
}

#[tauri::command]
pub async fn youtube_disconnect() -> Result<(), String> {
    oauth::delete_credentials().map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct OAuthStartResponse {
    pub url: String,
}

/// Begin OAuth: spawn a loopback server, return the consent URL for the UI to
/// open in the system browser, and asynchronously wait for the redirect with
/// the auth code. On success, store credentials and emit `youtube:connected`.
#[tauri::command]
pub async fn youtube_oauth_start(app: tauri::AppHandle) -> Result<OAuthStartResponse, String> {
    let (url, listener, port) = oauth::start_loopback().await.map_err(|e| e.to_string())?;

    let app_clone = app.clone();
    tokio::spawn(async move {
        match oauth::wait_for_code(listener, port).await {
            Ok(code) => match oauth::exchange_code(&code, port).await {
                Ok(creds) => {
                    if let Err(e) = oauth::store_credentials(&creds) {
                        let _ = app_clone.emit("youtube:error", e.to_string());
                    } else {
                        let _ = app_clone.emit("youtube:connected", ());
                    }
                }
                Err(e) => {
                    let _ = app_clone.emit("youtube:error", e.to_string());
                }
            },
            Err(e) => {
                let _ = app_clone.emit("youtube:error", e.to_string());
            }
        }
    });

    Ok(OAuthStartResponse { url })
}

#[derive(Deserialize)]
pub struct UploadCommand {
    pub req: UploadRequest,
}

#[tauri::command]
pub async fn youtube_upload(args: UploadCommand) -> Result<UploadResponse, String> {
    upload::upload(args.req).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn youtube_publish_now(video_id: String) -> Result<(), String> {
    upload::publish_now(&video_id).await.map_err(|e| e.to_string())
}
