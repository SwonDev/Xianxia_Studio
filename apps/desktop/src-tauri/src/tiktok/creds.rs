//! TikTok `sessionid` persistence — OS keyring, never plaintext.
//! Mirrors youtube::oauth's app-credentials pattern.
use anyhow::Result;
use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "studio.xianxia.app";
const SESSION_KEY: &str = "tiktok-session";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TikTokCreds {
    /// The `sessionid` cookie value the user copies from their logged-in
    /// tiktok.com browser session. Only the user can provide this.
    pub session_id: String,
}

pub fn load_session() -> Result<Option<TikTokCreds>> {
    let entry = Entry::new(SERVICE, SESSION_KEY)?;
    match entry.get_password() {
        Ok(blob) => Ok(Some(serde_json::from_str(&blob)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn store_session(creds: &TikTokCreds) -> Result<()> {
    let entry = Entry::new(SERVICE, SESSION_KEY)?;
    entry.set_password(&serde_json::to_string(creds)?)?;
    Ok(())
}

pub fn delete_session() -> Result<()> {
    let entry = Entry::new(SERVICE, SESSION_KEY)?;
    let _ = entry.delete_credential();
    Ok(())
}
