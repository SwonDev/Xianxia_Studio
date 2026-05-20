//! OAuth2 loopback flow for YouTube Data API v3.
//!
//! Credentials lifecycle:
//!   - The user pastes their Google client_id + client_secret in Settings.
//!   - We persist them in the OS keyring under (SERVICE, "youtube-app").
//!   - At sign-in we spawn a local TCP server on a random port, build the
//!     consent URL, the UI opens it in the system browser, the user authorizes,
//!     Google redirects to `http://127.0.0.1:<port>/?code=...`, we exchange the
//!     code for tokens, and store the tokens under (SERVICE, "youtube-tokens").

use anyhow::{Context, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SERVICE: &str = "studio.xianxia.app";
const TOKENS_KEY: &str = "youtube-tokens";
const APP_KEY: &str = "youtube-app";

const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppCredentials {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OAuthCredentials {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    pub access_token: Option<String>,
    pub expires_at: Option<i64>,
}

// ─── App credentials (client_id / client_secret) ────────────────────
pub fn load_app_credentials() -> Result<Option<AppCredentials>> {
    let entry = Entry::new(SERVICE, APP_KEY)?;
    match entry.get_password() {
        Ok(blob) => Ok(Some(serde_json::from_str(&blob)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn store_app_credentials(creds: &AppCredentials) -> Result<()> {
    let entry = Entry::new(SERVICE, APP_KEY)?;
    entry.set_password(&serde_json::to_string(creds)?)?;
    Ok(())
}

pub fn delete_app_credentials() -> Result<()> {
    let entry = Entry::new(SERVICE, APP_KEY)?;
    let _ = entry.delete_credential();
    Ok(())
}

// ─── User tokens (refresh + access) ──────────────────────────────────
pub fn load_credentials() -> Result<Option<OAuthCredentials>> {
    let entry = Entry::new(SERVICE, TOKENS_KEY)?;
    match entry.get_password() {
        Ok(blob) => Ok(Some(serde_json::from_str(&blob)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn store_credentials(creds: &OAuthCredentials) -> Result<()> {
    let entry = Entry::new(SERVICE, TOKENS_KEY)?;
    entry.set_password(&serde_json::to_string(creds)?)?;
    Ok(())
}

pub fn delete_credentials() -> Result<()> {
    let entry = Entry::new(SERVICE, TOKENS_KEY)?;
    let _ = entry.delete_credential();
    Ok(())
}

// ─── Loopback flow ───────────────────────────────────────────────────
pub async fn start_loopback() -> Result<(String, TcpListener, u16)> {
    let app_creds = load_app_credentials()?
        .ok_or_else(|| anyhow::anyhow!("Configura primero el client_id y client_secret de Google en Ajustes"))?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let consent_url = build_consent_url(&app_creds.client_id, port);
    Ok((consent_url, listener, port))
}

fn build_consent_url(client_id: &str, port: u16) -> String {
    let scope = SCOPES.join(" ");
    format!(
        "https://accounts.google.com/o/oauth2/v2/auth?\
         client_id={cid}&\
         redirect_uri=http://127.0.0.1:{port}/&\
         response_type=code&\
         access_type=offline&\
         prompt=consent&\
         scope={scope}",
        cid = encode_pct(client_id),
        port = port,
        scope = encode_pct(&scope),
    )
}

pub async fn wait_for_code(listener: TcpListener, _port: u16) -> Result<String> {
    let (mut stream, _) = listener.accept().await?;
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let code = parse_code(&req).context("OAuth redirect missing code")?;

    let body = "<!doctype html><meta charset=utf-8><title>Xianxia Studio</title>\
                <body style='background:#0a0a0f;color:#e8e8f0;font-family:system-ui;text-align:center;padding-top:30vh'>\
                <h1 style='color:#c9a84c;font-family:Georgia;font-size:96px'>\u{4ed9}</h1>\
                <p>Cuenta vinculada. Puedes cerrar esta pesta\u{f1}a.</p>".as_bytes();
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await?;
    Ok(code)
}

fn parse_code(req: &str) -> Option<String> {
    let first_line = req.lines().next()?;
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let url = parts[1];
    let q = url.split('?').nth(1)?;
    for kv in q.split('&') {
        let mut it = kv.splitn(2, '=');
        if it.next() == Some("code") {
            return it.next().map(|s| s.to_string());
        }
    }
    None
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

pub async fn exchange_code(code: &str, port: u16) -> Result<OAuthCredentials> {
    let app = load_app_credentials()?
        .ok_or_else(|| anyhow::anyhow!("OAuth app credentials missing"))?;
    let res = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", &app.client_id),
            ("client_secret", &app.client_secret),
            ("redirect_uri", &format!("http://127.0.0.1:{}/", port)),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await?;
    if !res.status().is_success() {
        // v0.7.17 — PII leak fix. Antes incluíamos `res.text().await?` en
        // el error, y Google a veces ecoa el `code` o parámetros como
        // `client_id` en el body de error. Ese mensaje fluye al
        // `tracing::error!` del comando Tauri y termina en logs/, que
        // cualquiera con acceso local puede leer. Sólo serializamos el
        // status HTTP — suficiente para diagnosticar (4xx vs 5xx) sin
        // exponer credenciales ni códigos de un solo uso.
        let status = res.status();
        return Err(anyhow::anyhow!("token exchange failed: HTTP {}", status));
    }
    let token: TokenResponse = res.json().await?;
    Ok(OAuthCredentials {
        client_id: app.client_id,
        client_secret: app.client_secret,
        refresh_token: token.refresh_token.unwrap_or_default(),
        access_token: Some(token.access_token),
        expires_at: Some(chrono::Utc::now().timestamp() + token.expires_in),
    })
}

pub async fn refresh_access_token(creds: &mut OAuthCredentials) -> Result<()> {
    let res = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", &creds.client_id),
            ("client_secret", &creds.client_secret),
            ("refresh_token", &creds.refresh_token),
            ("grant_type", &"refresh_token".to_string()),
        ])
        .send()
        .await?;
    if !res.status().is_success() {
        // v0.7.17 — mismo PII leak fix que en exchange_code: el body de
        // error de Google puede ecoar el refresh_token. Sólo el status.
        let status = res.status();
        return Err(anyhow::anyhow!("refresh failed: HTTP {}", status));
    }
    let token: TokenResponse = res.json().await?;
    creds.access_token = Some(token.access_token);
    creds.expires_at = Some(chrono::Utc::now().timestamp() + token.expires_in);
    if let Some(rt) = token.refresh_token {
        creds.refresh_token = rt;
    }
    Ok(())
}

fn encode_pct(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}
