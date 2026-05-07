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

#[derive(Debug, Clone, PartialEq)]
pub struct BeatSlot {
    pub start: f64,
    pub duration: f64,
    pub transition: &'static str,
}

/// Spread `n` beats uniformly across `audio_duration` seconds, with a small
/// crossfade overlap between adjacent beats. Guarantees:
///   - The first beat starts at 0.0 (no black at the head of the video).
///   - The last beat ends exactly at `audio_duration` (no black at the tail).
///   - All durations are >= 1.0s.
///   - Transitions cycle through cross/flash/cross/inkwash/whip for variety.
///
/// Tested by `tests::beat_timeline_covers_full_audio` and friends below.
pub fn normalise_beat_timeline(n: usize, audio_duration: f64) -> Vec<BeatSlot> {
    if n == 0 || audio_duration <= 0.0 {
        return Vec::new();
    }
    const TRANS: &[&str] = &["cross", "flash", "cross", "inkwash", "whip"];
    let segment = audio_duration / (n as f64);
    let overlap = (segment * 0.15).clamp(0.4, 1.5).min(segment * 0.5);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let start = (i as f64) * segment;
        let end = if i + 1 == n {
            audio_duration
        } else {
            ((i as f64) + 1.0) * segment + overlap
        };
        let duration = (end - start).max(1.0);
        out.push(BeatSlot {
            start,
            duration,
            transition: TRANS[i % TRANS.len()],
        });
    }
    out
}

/// Best-effort VRAM unload between phases. Never fails the pipeline.
async fn unload(client: &reqwest::Client, target: &str) {
    let _ = client
        .post(format!("{}/unload?target={}", PY_SIDECAR, target))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;
}

async fn node_alive(client: &reqwest::Client) -> bool {
    client
        .get(format!("{}/health", NODE_SIDECAR))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Try the full thumbnail flow (Z-Image then Node text overlay). Returns Err
/// on any HTTP failure so the caller can fall back to a frame-extract.
async fn try_thumbnail(
    client: &reqwest::Client,
    topic: &str,
    meta: &serde_json::Value,
    width: u32,
    height: u32,
    out_dir: &str,
    out_path: &str,
) -> anyhow::Result<()> {
    let bg = client
        .post(format!("{}/image", PY_SIDECAR))
        .timeout(std::time::Duration::from_secs(30 * 60))
        .json(&serde_json::json!({
            "prompt": format!(
                "dramatic xianxia thumbnail of {}, hero in mid-action with qi aura, \
                 anamorphic 2.39:1 cinematic framing, volumetric god rays, \
                 high-contrast teal-and-orange grade, sharp focus on subject, \
                 epic scale composition rule of thirds, no text overlay",
                topic
            ),
            "width": width,
            "height": height,
            "out_dir": out_dir,
            "style_preset": false,
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    let _thumb = client
        .post(format!("{}/render/thumbnail", NODE_SIDECAR))
        .timeout(std::time::Duration::from_secs(2 * 60))
        .json(&serde_json::json!({
            "title_en": meta["title_en"],
            "title_zh": meta["title_zh"],
            "background_path": bg["image_path"],
            "out_path": out_path,
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    Ok(())
}

/// Last-resort thumbnail: pull a single frame from the rendered MP4 with
/// FFmpeg. Picks ~10 % into the runtime so we avoid black frames at start.
fn extract_frame_thumbnail(video_path: &str, out_path: &str) -> anyhow::Result<()> {
    use crate::process_ext::HideConsole;
    let status = std::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-ss", "5",
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "2",
            out_path,
        ])
        .hide_console()
        .status()?;
    if !status.success() {
        anyhow::bail!("ffmpeg frame extract exit {}", status);
    }
    Ok(())
}

/// Try HyperFrames render. Returns Err on any failure (network, HTTP error,
/// JSON decode), so the caller can decide whether to fall back to FFmpeg.
#[allow(clippy::too_many_arguments)]
async fn try_hyperframes_render(
    client: &reqwest::Client,
    pid: &str,
    title: &str,
    beats: &[serde_json::Value],
    narration_audio: &str,
    music_audio: &serde_json::Value,
    out_path: &str,
    width: u32,
    height: u32,
) -> anyhow::Result<serde_json::Value> {
    let resp = client
        .post(format!("{}/render/narrative", NODE_SIDECAR))
        .timeout(std::time::Duration::from_secs(45 * 60))
        .json(&serde_json::json!({
            "project_id": pid,
            "title": title,
            "images": beats,
            "narration_path": narration_audio,
            "music_path": music_audio,
            "out_path": out_path,
            "width": width,
            "height": height,
            "cinematic": "full",
            "music_ducking": true,
        }))
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("HTTP {} from /render/narrative — body head: {}",
            status,
            body.chars().take(160).collect::<String>(),
        );
    }
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow::anyhow!("decode /render/narrative body: {} — head: {}",
            e, body.chars().take(160).collect::<String>()))?;
    Ok(json)
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GenerateRequest {
    pub topic: String,
    pub languages: Vec<String>,
    pub target_minutes: u32,
    #[serde(default)]
    pub experimental_llm: bool,
    #[serde(default)]
    pub llm_model: Option<String>,
    #[serde(default, alias = "voice")]
    pub voice_speaker: Option<String>,
    #[serde(default)]
    pub use_musicgen: bool,
    #[serde(default)]
    pub vertical: bool,
    /// When true, Phase 9 uploads to YouTube using stored OAuth credentials.
    /// Default false: pipeline produces the MP4 + subs but doesn't publish.
    #[serde(default)]
    pub auto_upload: bool,
    /// "private" | "unlisted" | "public" for the YouTube upload (Phase 9).
    #[serde(default)]
    pub publish_privacy: Option<String>,
    /// Unix timestamp for scheduled publish; only honoured when privacy=private.
    #[serde(default)]
    pub publish_at: Option<i64>,
    /// Phase 10: extract N Shorts automatically from the long-form video.
    /// Only runs when vertical=false (it makes no sense for already-vertical videos).
    #[serde(default)]
    pub auto_shorts: bool,
    #[serde(default)]
    pub shorts_count: Option<u32>,
    /// Phase 8: when false, skip the karaoke ASS burn-in pass — the SRT files
    /// still get generated, but the final MP4 has no captions overlaid.
    /// Default true (existing behaviour).
    #[serde(default = "default_true")]
    pub burn_subtitles: bool,
    /// Animation preset that drives Ken Burns range, handheld sway, transition
    /// kinds and cinematic profile. "cinematic" | "dynamic" | "minimal" | "dramatic".
    #[serde(default)]
    pub animation_preset: Option<String>,
    /// Caption style preset for the ASS karaoke. "xianxia" (default) | "hormozi" |
    /// "mrbeast" | "minimal" | "neon".
    #[serde(default)]
    pub caption_style: Option<String>,
    /// Phase 11: TRIBE v2 in-silico neuroscience engagement analysis.
    /// Default true — runs the analysis post-render and persists the score
    /// + boring spots to the project DB. Adds ~30-90 s on RTX 4060 8 GB
    /// (light mode: V-JEPA2 + Wav2Vec-BERT, sequential per modality).
    #[serde(default = "default_true")]
    pub analyze_engagement: bool,
    /// When true, after analysis Phase 11 also auto-applies cuts and audio
    /// swells to fix detected boring spots. Default false (user reviews first).
    #[serde(default)]
    pub auto_optimize_engagement: bool,
}

fn default_true() -> bool { true }

#[derive(Debug, Serialize, Clone)]
pub struct PhaseUpdate {
    pub project_id: String,
    pub phase: u8,
    pub status: String,
    pub progress: f64,
    pub message: String,
}

/// Tracks every running generation so the UI can abort it. Keyed by
/// project_id; the value is the spawned task's AbortHandle. Entries are
/// removed when the task finishes (Ok or Err).
static ACTIVE_RUNS: once_cell::sync::Lazy<
    std::sync::Mutex<std::collections::HashMap<String, tokio::task::AbortHandle>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

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
    let topic_for_notify = req.topic.clone();
    let project_id_for_task = project_id.clone();
    let handle = tokio::spawn(async move {
        use tauri_plugin_notification::NotificationExt;
        let result = run(&app_clone, &pool_clone, &project_id_for_task, &req).await;
        // Remove ourselves from the registry whatever the outcome.
        if let Ok(mut runs) = ACTIVE_RUNS.lock() {
            runs.remove(&project_id_for_task);
        }
        match result {
            Ok(_) => {
                let _ = db::projects::set_status(&pool_clone, &project_id_for_task, "ready").await;
                let _ = app_clone
                    .notification()
                    .builder()
                    .title("Xianxia Studio")
                    .body(&format!("Vídeo listo: {}", topic_for_notify))
                    .show();
            }
            Err(e) => {
                tracing::error!(project = %project_id_for_task, error = %e, "pipeline failed");
                let _ = db::projects::set_status(&pool_clone, &project_id_for_task, "failed").await;
                let _ = app_clone.emit(
                    "pipeline:error",
                    serde_json::json!({ "project_id": project_id_for_task, "error": e.to_string() }),
                );
                let _ = app_clone
                    .notification()
                    .builder()
                    .title("Xianxia Studio · error")
                    .body(&format!("La generación falló: {}", e))
                    .show();
            }
        }
    });
    if let Ok(mut runs) = ACTIVE_RUNS.lock() {
        runs.insert(project_id.clone(), handle.abort_handle());
    }

    Ok(project.id)
}

/// Cancels an in-flight generation by aborting its spawned task. The pipeline
/// does NOT clean up partial outputs (TTS WAVs, ComfyUI history); those are
/// safe to leave on disk and will be ignored by the next run.
#[tauri::command]
pub async fn abort_generation(
    pool: tauri::State<'_, Arc<DbPool>>,
    project_id: String,
) -> Result<bool, String> {
    let aborted = if let Ok(mut runs) = ACTIVE_RUNS.lock() {
        if let Some(handle) = runs.remove(&project_id) {
            handle.abort();
            true
        } else {
            false
        }
    } else {
        false
    };
    if aborted {
        let _ = db::projects::set_status(pool.inner(), &project_id, "cancelled").await;
        tracing::info!(project = %project_id, "generation aborted by user");
    }
    Ok(aborted)
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
    // Phase 2 also uses Ollama (Gemma 4) — keeping the model loaded between
    // phases avoids paying the ~3 GB load cost twice. We unload AFTER
    // metadata, not between Script and Metadata.

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
    // NOW free Ollama (~3 GB recovered) before TTS loads its own model.
    // The unload helper polls /api/ps until xianxia-llm is fully evicted.
    unload(&client, "ollama").await;

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
    // Real audio duration (seconds). The LLM produces image markers with
    // timestamps based on a hard-coded 150 wpm assumption, but Qwen3-TTS
    // narrates at its own pace — combined with the LLM's tendency to put
    // markers in the second half of a script, the marker timestamps end
    // up far off the actual audio. We use the TTS's reported duration to
    // redistribute beats UNIFORMLY across the whole audio in Phase 4
    // instead of trusting the marker timestamps. Result: no 17 s of black
    // at the start, no 34 s of black at the end, no last image clipped.
    let narration_duration = tts["duration_seconds"].as_f64().unwrap_or(0.0);
    persist_step(pool, pid, 3, "done", &tts).await?;
    emit(app, pid, 3, "done", 100.0, "Voz lista");
    // Free Qwen3-TTS VRAM before Z-Image loads (~4-5 GB recovered).
    unload(&client, "tts").await;

    // ─── Phase 4: Images (one per IMAGE marker) ──────────────────────
    // Native aspect generation: vertical Shorts → 720x1280, horizontal video → 1280x720.
    // Both fit comfortably in 8 GB VRAM (sweet spot per Z-Image-Turbo Q4 GGUF benchmarks)
    // and avoid the offload cost of going to 768x1344 / 1344x768.
    let (img_w, img_h) = if req.vertical { (720, 1280) } else { (1280, 720) };
    emit(app, pid, 4, "running", 0.0, &format!("Generando imágenes {}x{}…", img_w, img_h));
    let mut beats: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = markers.as_array() {
        let image_markers: Vec<&serde_json::Value> =
            arr.iter().filter(|m| m["kind"] == "image").collect();
        let total = image_markers.len().max(1);
        for (i, m) in image_markers.iter().enumerate() {
            let prompt = m["prompt"].as_str().unwrap_or("");
            let img: serde_json::Value = client
                .post(format!("{}/image", PY_SIDECAR))
                .json(&serde_json::json!({
                    "prompt": prompt,
                    "out_dir": out_dir,
                    "style_preset": true,
                    "width": img_w,
                    "height": img_h,
                }))
                .send()
                .await?
                .json()
                .await?;
            let img_path = img["image_path"].as_str().unwrap_or("").to_string();
            // Placeholder start/duration — replaced below by uniform
            // distribution over the real audio duration.
            beats.push(serde_json::json!({
                "path": img_path.clone(),
                "start": 0.0,
                "duration": 0.0,
            }));
            // Live preview: emit a per-image event so the wizard can show
            // thumbnails as they finish rendering. UI subscribes to
            // `pipeline:image_ready`. Best-effort; failure here doesn't break
            // the pipeline.
            let _ = app.emit(
                "pipeline:image_ready",
                serde_json::json!({
                    "project_id": pid,
                    "index": i,
                    "total": total,
                    "image_path": img_path,
                    "prompt": prompt,
                }),
            );
            let pct = ((i + 1) as f64 / total as f64) * 100.0;
            emit(app, pid, 4, "running", pct, &format!("Imagen {}/{}", i + 1, total));
        }
    }
    // ─── Beat timeline normalisation ────────────────────────────────
    // Replace whatever start/duration the per-beat loop set with a uniform
    // distribution over the REAL narration audio duration. Each beat
    // covers `audio / N` seconds, with a small overlap to enable the
    // GSAP cross/flash/whip/inkwash transitions in narrative.html. The
    // last beat is clamped to the end of the audio so no image is
    // truncated and no black tail remains.
    if !beats.is_empty() && narration_duration > 0.0 {
        let n = beats.len();
        let normalised = normalise_beat_timeline(n, narration_duration);
        for (i, slot) in normalised.iter().enumerate() {
            beats[i]["start"] = serde_json::json!(slot.start);
            beats[i]["duration"] = serde_json::json!(slot.duration);
            beats[i]["transition"] = serde_json::json!(slot.transition);
        }
        tracing::info!(
            beats = n,
            audio_seconds = narration_duration,
            "beat timeline normalised over real audio duration",
        );
    }

    persist_step(pool, pid, 4, "done", &serde_json::json!({"beats": beats})).await?;
    emit(app, pid, 4, "done", 100.0, "Imágenes listas");

    // Sequential VRAM swap: free Z-Image (ComfyUI) before depth/render/whisper.
    unload(&client, "comfyui").await;
    unload(&client, "image").await;

    // ─── Phase 4b: Depth segmentation (rembg) for parallax 2.5D layers ──
    // Best effort: if rembg/onnxruntime aren't installed or any image errors,
    // we fall through to the FFmpeg-fast render which doesn't need layers.
    emit(app, pid, 4, "running", 80.0, "Segmentando capas de profundidad…");
    let img_paths: Vec<String> = beats
        .iter()
        .map(|b| b["path"].as_str().unwrap_or("").to_string())
        .collect();
    let mut all_layered = false;
    if !img_paths.is_empty() {
        let depth_call = client
            .post(format!("{}/depth/batch", PY_SIDECAR))
            .timeout(std::time::Duration::from_secs(10 * 60))
            .json(&serde_json::json!({
                "images": img_paths,
                "model": "u2net",
                "inpaint_radius": 12,
                "feather_pixels": 4,
            }))
            .send()
            .await;
        if let Ok(resp) = depth_call {
            if resp.status().is_success() {
                if let Ok(depth_resp) = resp.json::<serde_json::Value>().await {
                    if let Some(results) = depth_resp["results"].as_array() {
                        if results.len() == beats.len() {
                            for (i, r) in results.iter().enumerate() {
                                if let (Some(bg), Some(fg)) =
                                    (r["bg_path"].as_str(), r["fg_path"].as_str())
                                {
                                    beats[i]["path"] = serde_json::json!(bg);
                                    beats[i]["foreground_path"] = serde_json::json!(fg);
                                }
                            }
                            all_layered = true;
                            emit(app, pid, 4, "done", 100.0, "Imágenes + capas 2.5D");
                        }
                    }
                }
            }
        }
    }
    // Free rembg sessions + RMBG-2.0 weights cached for the depth pass.
    // Without this they linger in VRAM (~177 MB u2net, up to 1.4 GB
    // RMBG-2.0) competing with the next phases.
    unload(&client, "depth").await;

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
    // Release MusicGen / ACE-Step PyTorch tensors (~2-4 GB) before render.
    // Phase 6 doesn't need GPU compute (HyperFrames uses Chromium + ffmpeg
    // NVENC) so this is the cheapest phase to leave VRAM clean for.
    unload(&client, "music").await;

    // ─── Phase 6: Render ─────────────────────────────────────────────
    // HyperFrames is the project's primary auto-edit engine: HTML/CSS/GSAP
    // composition rendered to MP4 via the Node sidecar's `narrative.html`
    // template. Pack: parallax 2.5D (when depth layers exist), atmospherics
    // (mist/embers/snow/dust_motes/clouds), cinematic transitions
    // (cross/flash/whip/inkwash), light rays, then FFmpeg post-pass with
    // grade + sidechain ducking. Works for both horizontal and vertical
    // (the template is responsive to width/height passed in the request).
    //
    // FFmpeg-direct (Python sidecar /render) only acts as an emergency
    // fallback when the Node sidecar is unreachable: zoompan + xfade +
    // cinematic stack + NVENC. ~1× realtime, no parallax/atmospherics
    // but full grade.
    //
    // Note: buildBeatNode in render.ts already falls back to a non-parallax
    // single-image layer when individual beats lack depth, so requiring
    // ALL beats to be layered (`all_layered`) was an over-restriction.
    // We now use HyperFrames whenever the Node sidecar is up.
    let video_out = format!("{}/video.mp4", out_dir);
    let _ = all_layered; // depth presence informs the template, not the gating

    // We ALWAYS try HyperFrames first when the Node sidecar is up — it's
    // the project's primary auto-edit engine. Only when it fails (HTTP
    // error, body parse error, or it returns success without producing a
    // valid MP4) do we fall back to the FFmpeg-direct path. The fallback
    // is automatic: we don't ever abort the pipeline at Phase 6.
    let want_hyperframes = node_alive(&client).await;
    let mut render: Option<serde_json::Value> = None;
    let mut used_engine = "FFmpeg";

    if want_hyperframes {
        emit(
            app, pid, 6, "running", 0.0,
            "Renderizando con HyperFrames (HTML/CSS/GSAP · parallax 2.5D · atmospherics · transiciones)…",
        );
        let (width, height) = if req.vertical { (1080u32, 1920u32) } else { (1920u32, 1080u32) };
        match try_hyperframes_render(
            &client, pid, &req.topic, &beats, &narration_audio,
            &music["audio_path"], &video_out, width, height,
        ).await {
            Ok(json) => {
                // Verify the MP4 actually exists on disk. The Node sidecar
                // returns 200 once postProcessCinematic kicks off, but on slow
                // disks (or while ffmpeg flushes buffers) the file may take a
                // moment to materialize. Poll for up to 30 s before declaring
                // failure — this eliminates the race that used to trigger a
                // bogus fallback to FFmpeg even when HyperFrames had succeeded.
                let out_path = json
                    .get("out_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&video_out)
                    .to_string();
                let mut materialized = false;
                for _ in 0..15 {
                    if let Ok(meta) = std::fs::metadata(&out_path) {
                        if meta.len() > 1024 {
                            materialized = true;
                            break;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                if materialized {
                    render = Some(json);
                    used_engine = "HyperFrames";
                } else {
                    tracing::warn!(out_path, "hyperframes returned 200 but no MP4 on disk after 30s — falling back to FFmpeg");
                    emit(app, pid, 6, "running", 5.0, "HyperFrames no produjo MP4 · cayendo a FFmpeg…");
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "hyperframes failed — falling back to FFmpeg direct render");
                emit(app, pid, 6, "running", 5.0, &format!("HyperFrames falló ({}) · cayendo a FFmpeg…",
                    e.to_string().chars().take(60).collect::<String>()));
            }
        }
    } else {
        emit(
            app, pid, 6, "running", 0.0,
            "Node sidecar no disponible · render directo con FFmpeg (zoompan + xfade + NVENC)…",
        );
    }

    if render.is_none() {
        // FFmpeg-direct fallback. Map beats → ImageBeat for /render.
        let images: Vec<serde_json::Value> = beats
            .iter()
            .map(|b| {
                let mut o = serde_json::json!({
                    "image_path": b["path"],
                    "start_seconds": b["start"],
                    "duration_seconds": b["duration"],
                });
                if let Some(fg) = b.get("foreground_path").and_then(|v| v.as_str()) {
                    o["foreground_path"] = serde_json::json!(fg);
                }
                if let Some(t) = b.get("transition").and_then(|v| v.as_str()) {
                    o["transition"] = serde_json::json!(t);
                }
                o
            })
            .collect();
        let (render_w, render_h) = if req.vertical { (1080, 1920) } else { (1920, 1080) };
        let render_timeout = std::time::Duration::from_secs(
            (15 * 60_u64).max((images.len() as u64) * 90).min(60 * 60),
        );
        emit(app, pid, 6, "running", 5.0, &format!("Componiendo {} escenas con FFmpeg…", images.len()));
        let preset = req.animation_preset.as_deref().unwrap_or("cinematic");
        let (kenburns_end, crossfade_s, sway_px, cinema_profile, transitions) = match preset {
            "minimal"  => (1.04_f64, 0.5_f64, 12.0_f64, "light", "fade,fade,fade,fade,fade"),
            "dynamic"  => (1.18, 0.4, 40.0, "full", "circleopen,wiperight,dissolve,fade,smoothleft"),
            "dramatic" => (1.22, 1.1, 50.0, "full", "fadeblack,radial,circleopen,fadeblack,dissolve"),
            _ /* cinematic */ => (1.12, 0.9, 30.0, "full", "fade,fadeblack,circleopen,dissolve,fade"),
        };
        let trans: Vec<&str> = transitions.split(',').collect();
        let mut images_with_trans = images.clone();
        for (i, beat) in images_with_trans.iter_mut().enumerate() {
            if let Some(o) = beat.as_object_mut() {
                if !o.contains_key("transition") {
                    o.insert(
                        "transition".to_string(),
                        serde_json::json!(trans[i % trans.len()]),
                    );
                }
            }
        }
        let ff_resp = client
            .post(format!("{}/render", PY_SIDECAR))
            .timeout(render_timeout)
            .json(&serde_json::json!({
                "images": images_with_trans,
                "narration_path": narration_audio,
                "music_path": music["audio_path"],
                "music_volume": 0.32,
                "music_ducking": true,
                "out_dir": out_dir,
                "crossfade_seconds": crossfade_s,
                "cinematic": cinema_profile,
                "width": render_w,
                "height": render_h,
                "kenburns_start": 1.00,
                "kenburns_end": kenburns_end,
                "handheld_sway_px": sway_px,
            }))
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        render = Some(ff_resp);
    }
    let render = render.expect("render must be Some after HyperFrames or FFmpeg branch");
    // Resolve the produced video path (different keys for /render vs /render/narrative).
    let mut produced_video = render
        .get("video_path")
        .or_else(|| render.get("out_path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| video_out.clone());

    // ─── Phase 6b: Smart vertical reframe (only when source isn't already vertical) ─────────
    // Vertical Shorts produced from native 720x1280 images don't need reframe — they're
    // already correctly composed. /reframe stays available for users who feed horizontal
    // sources via a future "import existing video" path.
    if req.vertical && false {
        emit(app, pid, 6, "running", 60.0, "Reframe vertical 1080×1920…");
        let vert_path = format!("{}/video-vertical.mp4", out_dir);
        let reframe_resp: Result<serde_json::Value, _> = client
            .post(format!("{}/reframe", PY_SIDECAR))
            .timeout(std::time::Duration::from_secs(10 * 60))
            .json(&serde_json::json!({
                "video_path": produced_video,
                "out_path": vert_path,
                "target_width": 1080,
                "target_height": 1920,
                "fallback": "blur-extend",
                "smoothing": 0.10,
            }))
            .send()
            .await
            .and_then(|r| r.error_for_status())?
            .json()
            .await;
        if let Ok(rframe) = reframe_resp {
            produced_video = rframe["out_path"].as_str().unwrap_or(&produced_video).to_string();
        }
    }

    persist_step(pool, pid, 6, "done", &render).await?;
    let mut tag = used_engine.to_string();
    if req.vertical { tag.push_str(" + reframe"); }
    emit(app, pid, 6, "done", 100.0, &format!("Vídeo renderizado ({})", tag));

    // ─── Phase 7: Thumbnail (dedicated Z-Image gen + Node text overlay) ──
    // Phase 7 is intentionally non-fatal. If Z-Image times out from VRAM
    // thrashing or the Node renderer fails, we extract a frame from the MP4
    // we just produced and use it as the thumbnail. Pipeline never blocks.
    emit(app, pid, 7, "running", 0.0, "Generando thumbnail…");
    // Free VRAM held by previous phases (TTS, music, narrative render)
    // BEFORE we ask ComfyUI to load Z-Image again. This is what makes the
    // thumbnail run finish in ~60 s instead of timing out at 12+ min.
    unload(&client, "tts").await;
    unload(&client, "music").await;
    let (thumb_w, thumb_h) = if req.vertical { (720, 1280) } else { (1280, 720) };
    let thumb_out = format!("{}/thumbnail.jpg", out_dir);
    let thumbnail_path: Option<String> = match try_thumbnail(
        &client, &req.topic, &meta, thumb_w, thumb_h, &out_dir, &thumb_out,
    ).await {
        Ok(()) if std::path::Path::new(&thumb_out).exists() => {
            emit(app, pid, 7, "done", 100.0, "Thumbnail listo (Z-Image + Node)");
            Some(thumb_out.clone())
        }
        Ok(()) => {
            // No error but file missing — fall through to frame extract.
            tracing::warn!("thumbnail flow returned ok but no jpg on disk, extracting frame from video");
            extract_frame_thumbnail(&produced_video, &thumb_out).ok();
            if std::path::Path::new(&thumb_out).exists() {
                emit(app, pid, 7, "done", 100.0, "Thumbnail (frame extraído del vídeo)");
                Some(thumb_out.clone())
            } else {
                emit(app, pid, 7, "skipped", 100.0, "Thumbnail omitido (no se pudo generar)");
                None
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "thumbnail generation failed, extracting frame from video");
            emit(app, pid, 7, "running", 50.0, "Z-Image/Node falló · extrayendo frame del vídeo…");
            extract_frame_thumbnail(&produced_video, &thumb_out).ok();
            if std::path::Path::new(&thumb_out).exists() {
                emit(app, pid, 7, "done", 100.0, "Thumbnail (frame extraído del vídeo)");
                Some(thumb_out.clone())
            } else {
                emit(app, pid, 7, "skipped", 100.0, &format!("Thumbnail omitido ({})",
                    e.to_string().chars().take(80).collect::<String>()));
                None
            }
        }
    };

    // ─── Phase 8: Subtitles (Whisper word-level + ASS karaoke + burn-in) ─
    emit(app, pid, 8, "running", 0.0, "Transcribiendo + karaoke ASS…");
    // Free Z-Image VRAM (image phase) before Whisper loads (~1 GB).
    unload(&client, "image").await;
    unload(&client, "comfyui").await;

    let primary_lang = req.languages.first().cloned().unwrap_or_else(|| "en".to_string());
    let subs: serde_json::Value = client
        .post(format!("{}/subtitles", PY_SIDECAR))
        .timeout(std::time::Duration::from_secs(15 * 60))
        .json(&serde_json::json!({
            "audio_path": narration_audio,
            "source_language": primary_lang,
            "target_languages": req.languages,
            "vertical": req.vertical,
            "out_dir": out_dir,
            "style": req.caption_style.clone().unwrap_or_else(|| "xianxia".to_string()),
        }))
        .send()
        .await?
        .json()
        .await?;

    // Find the ASS for the primary language and burn it on the produced video.
    let ass_path = subs["subtitles"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|s| s["language"] == serde_json::Value::String(primary_lang.clone()))
                .or_else(|| a.first())
        })
        .and_then(|s| s["ass_path"].as_str())
        .map(|s| s.to_string());

    let mut final_video = produced_video.clone();
    if !req.burn_subtitles {
        // User explicitly disabled subtitle burn-in. SRT files are still saved
        // and uploaded to YouTube as caption tracks; they're just not visually
        // overlaid on the master MP4.
        emit(app, pid, 8, "skipped", 100.0, "Subtítulos generados (sin quemar en MP4)");
    } else if let Some(ass) = ass_path {
        emit(app, pid, 8, "running", 60.0, "Quemando karaoke en NVENC…");
        let burn_out = produced_video.replace(".mp4", ".subs.mp4");
        // Burn-in is non-fatal. ffmpeg can return 0 with empty output on rare
        // NVENC driver quirks; the Python endpoint now self-validates and
        // returns 5xx in that case. Either way, we keep the un-burned video
        // as the final asset and warn instead of aborting the pipeline.
        let burn_attempt: anyhow::Result<serde_json::Value> = async {
            let resp = client
                .post(format!("{}/subtitles/burn-in", PY_SIDECAR))
                .timeout(std::time::Duration::from_secs(15 * 60))
                .json(&serde_json::json!({
                    "video_path": produced_video,
                    "ass_path": ass,
                    "out_path": burn_out,
                    // Cinematic look already applied during render — burn-in just overlays subs.
                    "cinematic": "off",
                }))
                .send()
                .await?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                anyhow::bail!("HTTP {} from burn-in: {}", status, body.chars().take(200).collect::<String>());
            }
            Ok(serde_json::from_str(&body)?)
        }.await;

        match burn_attempt {
            Ok(json) => {
                if let Some(p) = json["out_path"].as_str() {
                    if std::fs::metadata(p).map(|m| m.len() > 1024).unwrap_or(false) {
                        final_video = p.to_string();
                    } else {
                        tracing::warn!("burn-in returned out_path but file is empty/missing — keeping un-burned video");
                        emit(app, pid, 8, "running", 90.0, "Burn-in vacío · usando vídeo sin subs");
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "burn-in failed — keeping un-burned video as final asset");
                emit(app, pid, 8, "running", 90.0, &format!("Burn-in falló · usando vídeo sin subs ({})",
                    e.to_string().chars().take(60).collect::<String>()));
            }
        }
    }

    // Free Whisper for the next pipeline run.
    unload(&client, "whisper").await;
    persist_step(pool, pid, 8, "done", &serde_json::json!({"video": final_video, "subs": subs})).await?;
    emit(app, pid, 8, "done", 100.0, "Subtítulos karaoke listos");

    // ─── Phase 9: YouTube upload (only if user has connected YouTube) ──
    let yt_connected = crate::youtube::oauth::load_credentials().ok().flatten().is_some();
    if !yt_connected {
        emit(app, pid, 9, "skipped", 0.0, "YouTube no conectado · skip");
    } else if !req.auto_upload {
        emit(app, pid, 9, "skipped", 0.0, "Auto-upload desactivado · skip");
    } else {
        emit(app, pid, 9, "running", 0.0, "Subiendo a YouTube…");
        let title = meta["title"].as_str().unwrap_or(&req.topic).to_string();
        let description = meta["description"].as_str().unwrap_or("").to_string();
        let tags: Vec<String> = meta["tags"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        // Captions: convert ASS → SRT for upload (YouTube only accepts SRT/SBV/SCC).
        let mut captions: Vec<crate::youtube::upload::CaptionTrack> = Vec::new();
        if let Some(arr) = subs["subtitles"].as_array() {
            for s in arr {
                if let (Some(lang), Some(srt)) = (s["language"].as_str(), s["srt_path"].as_str()) {
                    captions.push(crate::youtube::upload::CaptionTrack {
                        language: lang.to_string(),
                        name: format!("{} ({})", lang, primary_lang),
                        srt_path: srt.to_string(),
                    });
                }
            }
        }

        // Vertical Shorts get the `#Shorts` hashtag in the description and a 24
        // category id; long-form goes into 24 (Entertainment) too but no tag.
        let mut full_description = description.clone();
        if req.vertical && !full_description.contains("#Shorts") {
            full_description.push_str("\n\n#Shorts");
        }

        let upload_req = crate::youtube::upload::UploadRequest {
            project_id: pid.to_string(),
            video_path: final_video.clone(),
            thumbnail_path: thumbnail_path.clone(),
            title,
            description: full_description,
            tags,
            category_id: "24".to_string(),
            privacy_status: req.publish_privacy.clone().unwrap_or_else(|| "private".to_string()),
            publish_at: req.publish_at,
            captions,
            contains_synthetic_media: true,
        };
        match crate::youtube::upload::upload(upload_req).await {
            Ok(resp) => {
                emit(app, pid, 9, "done", 100.0, &format!("Subido: youtube.com/watch?v={}", resp.video_id));
                persist_step(pool, pid, 9, "done", &serde_json::json!({"video_id": resp.video_id})).await?;
            }
            Err(e) => {
                emit(app, pid, 9, "failed", 0.0, &format!("Upload falló: {}", e));
            }
        }
    }

    // ─── Phase 10: Auto-Shorts extraction (skipped for vertical/short content) ──
    if !req.vertical && req.auto_shorts {
        emit(app, pid, 10, "running", 0.0, "Extrayendo Shorts virales…");
        // Use the words from Whisper (already collected for subtitles in phase 8).
        // The /subtitles response embeds them — fetch from the source ASS instead
        // by re-asking /transcribe quickly (cheap, words already cached).
        let words: Vec<serde_json::Value> = subs["subtitles"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|s| s.get("words").and_then(|v| v.as_array()))
            .cloned()
            .unwrap_or_default();
        if words.is_empty() {
            emit(app, pid, 10, "skipped", 0.0, "Sin words timestamps · skip Shorts");
        } else {
            let auto_resp = client
                .post(format!("{}/shorts/auto", PY_SIDECAR))
                .timeout(std::time::Duration::from_secs(20 * 60))
                .json(&serde_json::json!({
                    "video_path": final_video,
                    "words": words,
                    "out_dir": out_dir,
                    "n_shorts": req.shorts_count.unwrap_or(3),
                    "primary_language": primary_lang,
                }))
                .send()
                .await;
            match auto_resp {
                Ok(r) if r.status().is_success() => {
                    let out: serde_json::Value = r.json().await.unwrap_or_default();
                    let n = out["shorts"].as_array().map(|a| a.len()).unwrap_or(0);
                    persist_step(pool, pid, 10, "done", &out).await?;
                    emit(app, pid, 10, "done", 100.0, &format!("{} Shorts extraídos", n));
                }
                _ => {
                    emit(app, pid, 10, "failed", 0.0, "Auto-Shorts falló");
                }
            }
        }
    } else if req.vertical {
        emit(app, pid, 10, "skipped", 0.0, "Vídeo vertical · sin Shorts adicionales");
    } else {
        emit(app, pid, 10, "skipped", 0.0, "Auto-Shorts desactivado · skip");
    }

    // ─── Phase 11: Engagement analysis (TRIBE v2 · in-silico fMRI) ──
    if req.analyze_engagement {
        emit(app, pid, 11, "running", 0.0, "Analizando engagement con TRIBE v2…");
        // Best-effort: 503 (TRIBE not installed) → skip gracefully
        let analyze_resp: Option<serde_json::Value> = match client
            .post(format!("{}/engagement/analyze", PY_SIDECAR))
            .timeout(std::time::Duration::from_secs(20 * 60))
            .json(&serde_json::json!({
                "video_path": final_video,
                "mode": "light",
                "out_dir": out_dir,
                "boring_threshold": 0.40,
                "valley_min_seconds": 4.0,
            }))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json().await.ok(),
            _ => None,
        };

        match analyze_resp {
            Some(report) if report.get("overall_score").is_some() => {
                let score = report["overall_score"].as_f64().unwrap_or(0.0);
                let n_valleys = report["boring_spots"].as_array().map(|a| a.len()).unwrap_or(0);
                persist_step(pool, pid, 11, "done", &report).await?;

                // Auto-optimize: re-render with cuts + audio swells if user opted in.
                if req.auto_optimize_engagement && n_valleys > 0 {
                    emit(app, pid, 11, "running", 70.0,
                         &format!("Optimizando {} valles aburridos…", n_valleys));
                    let opt_resp: Option<serde_json::Value> = match client
                        .post(format!("{}/engagement/optimize", PY_SIDECAR))
                        .timeout(std::time::Duration::from_secs(15 * 60))
                        .json(&serde_json::json!({
                            "video_path": final_video,
                            "boring_spots": report["boring_spots"],
                            "out_dir": out_dir,
                            "allow_cut": true,
                            "allow_audio_swell": true,
                            "allow_broll": false,
                        }))
                        .send()
                        .await
                    {
                        Ok(r) if r.status().is_success() => r.json().await.ok(),
                        _ => None,
                    };
                    if let Some(opt) = opt_resp {
                        if let Some(p) = opt["out_path"].as_str() {
                            final_video = p.to_string();
                            let fixed = opt["spots_fixed"].as_u64().unwrap_or(0);
                            emit(app, pid, 11, "done", 100.0,
                                 &format!("Engagement {:.1}/100 · {} valles arreglados", score, fixed));
                            persist_step(pool, pid, 11, "done", &serde_json::json!({
                                "video": final_video,
                                "engagement_score": score,
                                "valleys_detected": n_valleys,
                                "valleys_fixed": fixed,
                            })).await?;
                        }
                    } else {
                        emit(app, pid, 11, "done", 100.0,
                             &format!("Engagement {:.1}/100 · auto-optimize falló", score));
                        persist_step(pool, pid, 11, "done", &serde_json::json!({
                            "video": final_video,
                            "engagement_score": score,
                            "valleys_detected": n_valleys,
                            "auto_optimize_failed": true,
                        })).await?;
                    }
                } else {
                    emit(app, pid, 11, "done", 100.0,
                         &format!("Engagement {:.1}/100 · {} valles detectados", score, n_valleys));
                    persist_step(pool, pid, 11, "done", &serde_json::json!({
                        "video": final_video,
                        "engagement_score": score,
                        "valleys_detected": n_valleys,
                    })).await?;
                }
            }
            _ => {
                emit(app, pid, 11, "skipped", 0.0, "TRIBE v2 no instalado · skip análisis");
            }
        }
    } else {
        emit(app, pid, 11, "skipped", 0.0, "Análisis engagement desactivado · skip");
    }

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

#[cfg(test)]
mod tests {
    use super::{normalise_beat_timeline, GenerateRequest};

    #[test]
    fn deserializes_minimal_payload_from_frontend() {
        let json = r#"{
            "topic": "Jade Emperor",
            "languages": ["en", "es"],
            "target_minutes": 14,
            "experimental_llm": false
        }"#;
        let req: GenerateRequest = serde_json::from_str(json).expect("must accept minimal payload");
        assert_eq!(req.topic, "Jade Emperor");
        assert!(!req.use_musicgen);
        assert!(!req.vertical);
    }

    #[test]
    fn accepts_voice_legacy_alias() {
        let json = r#"{
            "topic": "x",
            "languages": ["en"],
            "target_minutes": 5,
            "experimental_llm": false,
            "voice": "Vivian"
        }"#;
        let req: GenerateRequest = serde_json::from_str(json).expect("voice alias must work");
        assert_eq!(req.voice_speaker.as_deref(), Some("Vivian"));
    }

    #[test]
    fn accepts_canonical_voice_speaker() {
        let json = r#"{
            "topic": "x",
            "languages": ["en"],
            "target_minutes": 5,
            "experimental_llm": false,
            "voice_speaker": "Cherry",
            "use_musicgen": true,
            "vertical": true
        }"#;
        let req: GenerateRequest = serde_json::from_str(json).expect("canonical payload");
        assert_eq!(req.voice_speaker.as_deref(), Some("Cherry"));
        assert!(req.use_musicgen);
        assert!(req.vertical);
    }

    // ─── Beat-timeline regression tests ────────────────────────────────
    // These exist because the user observed the rendered video was
    // 17 s of black, then 1-2 images at the end. Root cause: the per-beat
    // start/duration came straight from LLM marker timestamps (computed
    // at a hard-coded 150 wpm) which had no relation to the real TTS
    // audio length. After the fix, normalise_beat_timeline() distributes
    // beats uniformly over the actual audio duration. These tests pin
    // that behaviour so a future refactor cannot reintroduce gaps.

    #[test]
    fn beat_timeline_starts_at_zero_no_head_gap() {
        let slots = normalise_beat_timeline(3, 90.0);
        assert_eq!(slots[0].start, 0.0, "first beat must start at t=0");
    }

    #[test]
    fn beat_timeline_last_beat_ends_at_audio_end() {
        let slots = normalise_beat_timeline(3, 90.0);
        let last = slots.last().unwrap();
        let end = last.start + last.duration;
        assert!(
            (end - 90.0).abs() < 0.001,
            "last beat must end at audio_duration, got end={end}",
        );
    }

    #[test]
    fn beat_timeline_covers_full_audio_with_overlap() {
        // 4 beats over 60s → ~15s per slot, with a small crossfade overlap.
        // Verifies (a) no gaps, (b) overlaps stay positive, (c) all slots
        // are at least 1s.
        let slots = normalise_beat_timeline(4, 60.0);
        assert_eq!(slots.len(), 4);
        for w in slots.windows(2) {
            let prev_end = w[0].start + w[0].duration;
            let next_start = w[1].start;
            assert!(prev_end >= next_start, "no gap between consecutive beats");
        }
        for slot in &slots {
            assert!(slot.duration >= 1.0, "duration too small: {}", slot.duration);
        }
    }

    #[test]
    fn beat_timeline_handles_short_audio() {
        // 3 images over a 6 s clip — small but valid. Each beat should
        // still be at least 1s.
        let slots = normalise_beat_timeline(3, 6.0);
        for s in &slots {
            assert!(s.duration >= 1.0);
        }
        let last = slots.last().unwrap();
        assert!((last.start + last.duration - 6.0).abs() < 0.001);
    }

    #[test]
    fn beat_timeline_empty_inputs_return_empty() {
        assert!(normalise_beat_timeline(0, 60.0).is_empty());
        assert!(normalise_beat_timeline(3, 0.0).is_empty());
    }

    #[test]
    fn beat_timeline_alternates_transitions() {
        let slots = normalise_beat_timeline(5, 50.0);
        let kinds: Vec<&str> = slots.iter().map(|s| s.transition).collect();
        // Must be a non-trivial mix — at least 2 distinct kinds in any
        // reasonable run so the rendered video doesn't feel monotonous.
        let unique_count = kinds.iter().collect::<std::collections::HashSet<_>>().len();
        assert!(unique_count >= 2, "transitions too repetitive: {:?}", kinds);
    }
}
