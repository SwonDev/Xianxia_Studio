//! Voice profile queries — exposes Qwen3-TTS preset catalog grouped by language.
use anyhow::Result;
use serde::Serialize;
use sqlx::FromRow;

use super::DbPool;

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct VoiceProfile {
    pub id: String,
    pub name: String,
    pub language: String,
    pub kind: String,
    pub reference_audio_path: Option<String>,
    pub embedding_path: Option<String>,
    pub description: Option<String>,
    pub is_default: i64,
}

/// All voice profiles, grouped semantically by language. Useful for the
/// generator UI to populate per-language voice dropdowns.
pub async fn list_all(pool: &DbPool) -> Result<Vec<VoiceProfile>> {
    let rows = sqlx::query_as::<_, VoiceProfile>(
        "SELECT id, name, language, kind, reference_audio_path, embedding_path, description, is_default
         FROM voice_profiles
         ORDER BY language ASC, is_default DESC, name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_for_language(pool: &DbPool, language: &str) -> Result<Vec<VoiceProfile>> {
    let rows = sqlx::query_as::<_, VoiceProfile>(
        "SELECT id, name, language, kind, reference_audio_path, embedding_path, description, is_default
         FROM voice_profiles
         WHERE language = ?
         ORDER BY is_default DESC, name ASC",
    )
    .bind(language)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
