//! YouTube Data API v3 — OAuth loopback + resumable upload + captions.
//!
//! Reference:
//!   https://developers.google.com/youtube/v3/docs/videos/insert
//!   https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
//!
//! Tokens are persisted via the OS keyring (`keyring` crate), never plaintext.

pub mod commands;
pub mod oauth;
pub mod upload;

#[allow(unused_imports)]
pub use upload::{publish_now, upload, CaptionTrack, UploadRequest, UploadResponse};
