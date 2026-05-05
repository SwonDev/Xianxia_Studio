//! Pipeline orchestration — coordinates the 10-phase production via the Python +
//! Node sidecars and persists state to SQLite.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::db::{self, projects::NewProject, DbPool};
use crate::installer::paths;

const PY_SIDECAR: &str = "http://127.0.0.1:8731";
const NODE_SIDECAR: &str = "http://127.0.0.1:8732";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GenerateRequest {
    pub topic: String,
    pub languages: Vec<String>,
    pub target_minutes: u32,
    pub experimental_llm: bool,
    pub llm_model: Option<String>,
    pub voice_speaker: Option<String>,
    pub use_musicgen: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct PhaseUpdate {
    pub project_id: String,
    pub phase: u8,
    pub status: String,
    pub progress: f64,
    pub message: String,
}

pub async fn start(
    app: AppHandle,
    pool: Arc<DbPool>,
    req: GenerateRequest,
) -> Result<String> {
    let project = db::projects::create(
        &pool,
        NewProject {
            title: format!("{}", req.topic),
            topic: req.topic.clone(),
            languages: req.languages.clone(),
        },
    )
    .await?;
    let project_id = project.id.clone();

    let app_clone = app.clone();
    let pool_clone = pool.clone();
    tokio::spawn(async move {
        let result = run(&app_clone, &pool_clone, &project_id, &req).await;
        match result {
            Ok(_) => {
                let _ = db::projects::set_status(&pool_clone, &project_id, "ready").await;
            }
            Err(e) => {
                tracing::error!(project = %project_id, error = %e, "pipeline failed");
                let _ = db::projects::set_status(&pool_clone, &project_id, "failed").await;
                let _ = app_clone.emit(
                    "pipeline:error",
                    serde_json::json!({ "project_id": project_id, "error": e.to_string() }),
                );
            }
        }
    });

    Ok(project.id)
}

async fn run(
    app: &AppHandle,
    pool: &DbPool,
    pid: &str,
    req: &GenerateRequest,
) -> Result<()> {
    db::projects::set_status(pool, pid, "generating").await?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 30))
        .build()?;

    let project_dir = paths::paths()?.data_dir.join("projects").join(pid);
    std::fs::create_dir_all(&project_dir)?;
    let out_dir = project_dir.to_string_lossy().to_string();

    // ─── Phase 1: Script ─────────────────────────────────────────────
    emit(app, pid, 1, "running", 0.0, "Generando guion…");
    let script_resp: serde_json::Value = client
        .post(format!("{}/script", PY_SIDECAR))
        .json(&serde_json::json!({
            "topic": req.topic,
            "target_minutes": req.target_minutes,
            "languages": req.languages,
            "model": req.llm_model.clone().unwrap_or_else(|| "xianxia-llm".to_string()),
            "experimental": req.experimental_llm,
        }))
        .send()
        .await
        .context("phase 1: script request failed")?
        .json()
        .await?;
    let narration = script_resp["narration"].as_str().unwrap_or("").to_string();
    let _full_script = script_resp["script"].as_str().unwrap_or("").to_string();
    let markers = script_resp["markers"].clone();
    persist_step(pool, pid, 1, "done", &script_resp).await?;
    emit(app, pid, 1, "done", 100.0, "Guion listo");

    // ─── Phase 2: Metadata ───────────────────────────────────────────
    emit(app, pid, 2, "running", 0.0, "Metadatos…");
    let meta: serde_json::Value = client
        .post(format!("{}/script/metadata", PY_SIDECAR))
        .json(&serde_json::json!({
            "script": _full_script,
            "languages": req.languages,
        }))
        .send()
        .await?
        .json()
        .await?;
    persist_step(pool, pid, 2, "done", &meta).await?;
    emit(app, pid, 2, "done", 100.0, "Metadatos listos");

    // ─── Phase 3: TTS ────────────────────────────────────────────────
    emit(app, pid, 3, "running", 0.0, "Sintetizando voz…");
    let tts: serde_json::Value = client
        .post(format!("{}/tts", PY_SIDECAR))
        .json(&serde_json::json!({
            "text": narration,
            "language": "English",
            "speaker": req.voice_speaker.clone().unwrap_or_else(|| "Vivian".to_string()),
            "out_dir": out_dir,
        }))
        .send()
        .await?
        .json()
        .await?;
    let narration_audio = tts["audio_path"].as_str().unwrap_or("").to_string();
    persist_step(pool, pid, 3, "done", &tts).await?;
    emit(app, pid, 3, "done", 100.0, "Voz lista");

    // ─── Phase 4: Images (one per IMAGE marker) ──────────────────────
    emit(app, pid, 4, "running", 0.0, "Generando imágenes…");
    let mut beats: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = markers.as_array() {
        let image_markers: Vec<&serde_json::Value> =
            arr.iter().filter(|m| m["kind"] == "image").collect();
        let total = image_markers.len().max(1);
        for (i, m) in image_markers.iter().enumerate() {
            let prompt = m["prompt"].as_str().unwrap_or("");
            let ts = m["timestamp_seconds"].as_f64().unwrap_or(0.0);
            let img: serde_json::Value = client
                .post(format!("{}/image", PY_SIDECAR))
                .json(&serde_json::json!({
                    "prompt": prompt,
                    "out_dir": out_dir,
                    "style_preset": true,
                }))
                .send()
                .await?
                .json()
                .await?;
            beats.push(serde_json::json!({
                "path": img["image_path"],
                "start": ts,
                "duration": 8.0,
            }));
            let pct = ((i + 1) as f64 / total as f64) * 100.0;
            emit(app, pid, 4, "running", pct, &format!("{}/{}", i + 1, total));
        }
    }
    persist_step(pool, pid, 4, "done", &serde_json::json!({"beats": beats})).await?;
    emit(app, pid, 4, "done", 100.0, "Imágenes listas");

    // ─── Phase 5: Music selector ─────────────────────────────────────
    emit(app, pid, 5, "running", 0.0, "Seleccionando música…");
    let music: serde_json::Value = client
        .post(format!("{}/music", PY_SIDECAR))
        .json(&serde_json::json!({
            "mood": "epic",
            "duration_seconds": script_resp["estimated_seconds"].as_f64().unwrap_or(900.0),
            "use_musicgen": req.use_musicgen,
        }))
        .send()
        .await?
        .json()
        .await?;
    persist_step(pool, pid, 5, "done", &music).await?;
    emit(app, pid, 5, "done", 100.0, "Música lista");

    // ─── Phase 6: Render via HyperFrames (Node sidecar) ──────────────
    emit(app, pid, 6, "running", 0.0, "Renderizando vídeo…");
    let video_out = format!("{}/video.mp4", out_dir);
    let render: serde_json::Value = client
        .post(format!("{}/render/narrative", NODE_SIDECAR))
        .json(&serde_json::json!({
            "project_id": pid,
            "title": req.topic,
            "images": beats,
            "narration_path": narration_audio,
            "music_path": music["audio_path"],
            "out_path": video_out,
        }))
        .send()
        .await?
        .json()
        .await?;
    persist_step(pool, pid, 6, "done", &render).await?;
    emit(app, pid, 6, "done", 100.0, "Vídeo renderizado");

    // ─── Phase 7: Thumbnail ──────────────────────────────────────────
    emit(app, pid, 7, "running", 0.0, "Generando thumbnail…");
    let bg: serde_json::Value = client
        .post(format!("{}/image", PY_SIDECAR))
        .json(&serde_json::json!({
            "prompt": format!("dramatic xianxia thumbnail, {}, hero pose, qi explosion", req.topic),
            "width": 1344,
            "height": 768,
            "out_dir": out_dir,
        }))
        .send()
        .await?
        .json()
        .await?;
    let thumb_out = format!("{}/thumbnail.jpg", out_dir);
    let _thumb: serde_json::Value = client
        .post(format!("{}/render/thumbnail", NODE_SIDECAR))
        .json(&serde_json::json!({
            "title_en": meta["title_en"],
            "title_zh": meta["title_zh"],
            "background_path": bg["image_path"],
            "out_path": thumb_out,
        }))
        .send()
        .await?
        .json()
        .await?;
    emit(app, pid, 7, "done", 100.0, "Thumbnail listo");

    // ─── Phase 8: Subtitles ──────────────────────────────────────────
    emit(app, pid, 8, "running", 0.0, "Transcribiendo subtítulos…");
    let _subs: serde_json::Value = client
        .post(format!("{}/transcribe", PY_SIDECAR))
        .json(&serde_json::json!({
            "audio_path": narration_audio,
            "language": "en",
            "out_dir": out_dir,
        }))
        .send()
        .await?
        .json()
        .await?;
    emit(app, pid, 8, "done", 100.0, "Subtítulos listos");

    // ─── Phase 9: YouTube upload (M5 wires this) ─────────────────────
    emit(app, pid, 9, "pending", 0.0, "Pendiente de upload (M5)");

    // ─── Phase 10: Schedule + Shorts (M6 wires this) ─────────────────
    emit(app, pid, 10, "pending", 0.0, "Pendiente de programación (M6)");

    Ok(())
}

async fn persist_step(
    pool: &DbPool,
    pid: &str,
    phase: u8,
    status: &str,
    output: &serde_json::Value,
) -> Result<()> {
    let id = ulid::Ulid::new().to_string();
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO pipeline_steps (id, project_id, phase, name, status, started_at, finished_at, progress, output_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 100, ?)
         ON CONFLICT(project_id, phase) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, output_json = excluded.output_json",
    )
    .bind(id)
    .bind(pid)
    .bind(phase as i64)
    .bind(format!("phase_{}", phase))
    .bind(status)
    .bind(now)
    .bind(now)
    .bind(serde_json::to_string(output)?)
    .execute(pool)
    .await?;
    Ok(())
}

fn emit(app: &AppHandle, pid: &str, phase: u8, status: &str, progress: f64, msg: &str) {
    let _ = app.emit(
        "pipeline:progress",
        PhaseUpdate {
            project_id: pid.to_string(),
            phase,
            status: status.to_string(),
            progress,
            message: msg.to_string(),
        },
    );
}
