//! TikTok — assisted publish (honest, opt-in).
//!
//! There is no friction-free public upload API for individual TikTok
//! creators, and the community "sessionid cookie" method is ToS-violating,
//! anti-bot-gated and breaks constantly — implementing a fake auto-uploader
//! against guessed endpoints would be dishonest and against this project's
//! "verify upstream, never fabricate endpoints" rule.
//!
//! So TikTok integration is **assisted publish**: the user stores their
//! TikTok `sessionid` (kept for a future official Content-Posting-API path),
//! and from the Library a button opens TikTok's uploader for the produced
//! vertical Short. Real, useful, honest — no bot, no fabricated API, no mock.
pub mod commands;
pub mod creds;
