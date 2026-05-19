//! Pipeline orchestration — coordinates the 10-phase production via the Python +
//! Node sidecars and persists state to SQLite.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{self, projects::NewProject, DbPool};
use crate::installer::paths;

const PY_SIDECAR: &str = "http://127.0.0.1:8731";
const NODE_SIDECAR: &str = "http://127.0.0.1:8732";
/// v0.2.0+ — llama-server (OpenAI-compatible) hosted by the supervisor.
/// Used by `wake_llm()` to head-start the respawn before the next
/// LLM-bearing phase issues its request via the Python sidecar.
const LLAMACPP_SIDECAR: &str = "http://127.0.0.1:8733";
/// ComfyUI inference server (managed by the supervisor). We hit
/// `/system_stats` directly to read real device VRAM during the
/// VRAM-gate / hard-reclaim choreography (v0.2.6).
const COMFY_SIDECAR: &str = "http://127.0.0.1:8188";

/// v0.2.6 — minimum free VRAM (GB) required to attempt the Z-Image
/// thumbnail cold reload. Below this the ComfyUI sampler enters Windows
/// CUDA-Sysmem-fallback thrash (≈958 s/step instead of ≈7 s/step — a
/// real 30-min hang we hit on RTX 4060 8 GB). We extract a video frame
/// instead. The cold reload needs text-encoder (~2.6 GB) + Lumina2
/// (~4.9 GB) with partial offload → 5.5 GB is the safe floor.
const THUMB_MIN_VRAM_GB: f64 = 5.5;

/// v0.2.6 — minimum free VRAM (GB) before loading Whisper for the
/// subtitles phase. llama-server (~3 GB, woken for translation) +
/// faster-whisper-large-v3 (~3 GB) must co-exist; 4 GB free after the
/// ComfyUI reclaim leaves margin for both.
const WHISPER_MIN_VRAM_GB: f64 = 4.0;

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
///   - Transitions cycle through cross/flash/cross/whip for variety.
///   - `inkwash` (circle-iris) was REMOVED in v0.1.23. The user reported
///     it was "extremadamente horrible" when the destination beat
///     showed the same composition as the previous one — the circle
///     opens onto an unchanged frame, looking like a broken cut.
///     Cross-fade is now the dominant transition (3 of 4 slots) with
///     flash + whip for accent.
///
/// Tested by `tests::beat_timeline_covers_full_audio` and friends below.
pub fn normalise_beat_timeline(n: usize, audio_duration: f64) -> Vec<BeatSlot> {
    if n == 0 || audio_duration <= 0.0 {
        return Vec::new();
    }
    const TRANS: &[&str] = &["cross", "flash", "cross", "whip"];
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
///
/// Targets are runtime-family names: "llm" (the active LLM backend —
/// llama.cpp by default in v0.2.0+, Ollama only if the user opted in
/// from Settings), "tts", "image", "comfyui", "depth", "music",
/// "whisper". The Python sidecar's `/unload` route dispatches each
/// target to the right tear-down so this caller stays agnostic.
async fn unload(client: &reqwest::Client, target: &str) {
    let _ = client
        .post(format!("{}/unload?target={}", PY_SIDECAR, target))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;
}

/// Like `unload` but parses the `vram_free_gb` field the Python `/unload`
/// route reports after it finishes evicting + polling. Returns `None`
/// when the call fails or the field is absent. Never panics.
async fn unload_get_vram(client: &reqwest::Client, target: &str) -> Option<f64> {
    let resp = client
        .post(format!("{}/unload?target={}", PY_SIDECAR, target))
        .timeout(std::time::Duration::from_secs(45))
        .send()
        .await
        .ok()?;
    let v: serde_json::Value = resp.json().await.ok()?;
    v.get("vram_free_gb").and_then(|x| x.as_f64())
}

/// Read ComfyUI's real device free-VRAM (GB) from `/system_stats`.
/// ComfyUI reports per-device `vram_free` in bytes. Best-effort.
async fn comfyui_vram_free_gb(client: &reqwest::Client) -> Option<f64> {
    let resp = client
        .get(format!("{}/system_stats", COMFY_SIDECAR))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    let v: serde_json::Value = resp.json().await.ok()?;
    let dev = v.get("devices")?.as_array()?.first()?;
    let free = dev.get("vram_free")?.as_f64()?;
    Some(free / 1_073_741_824.0)
}

/// v0.2.6 — guarantee ComfyUI has at least `min_gb` free VRAM before a
/// GPU-heavy phase that depends on it (thumbnail Z-Image cold reload,
/// or the Whisper load that follows the subtitles `/free`).
///
/// Strategy, escalating:
///   1. Graceful: `POST /unload?target=comfyui` (the Python route already
///      issues ComfyUI `/free` and polls up to 30 s) and read the
///      resulting `vram_free_gb`.
///   2. If still short, the ComfyUI worker is almost certainly stuck on a
///      hung prompt (the Sysmem-fallback thrash failure mode) and `/free`
///      can't help. Ask the supervisor to **kill + respawn ComfyUI**: a
///      fresh process holds zero models, returning the card to ~full
///      free. Wait (cold start ≈30 s) until it binds and reports stats.
///
/// Returns the best-known free VRAM (GB); `0.0` if it could never be
/// read. Never fails the pipeline — callers decide what to do with a
/// low number (skip Z-Image, proceed anyway, etc.).
async fn ensure_comfyui_vram(app: &AppHandle, client: &reqwest::Client, min_gb: f64) -> f64 {
    let mut free = unload_get_vram(client, "comfyui").await.unwrap_or(0.0);
    if free >= min_gb {
        return free;
    }
    if let Some(sup) = app.try_state::<Arc<crate::sidecars::Supervisor>>() {
        tracing::warn!(
            free_gb = free,
            target_gb = min_gb,
            "ComfyUI VRAM below target after /free — hard respawn (likely hung worker)"
        );
        sup.respawn_comfyui().await;
        // Cold start: ComfyUI binds :8188 in ~10-30 s; weights are lazy
        // so a fresh process reports near-full free immediately once up.
        for _ in 0..45 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if let Some(f) = comfyui_vram_free_gb(client).await {
                free = f;
                if f >= min_gb {
                    tracing::info!(free_gb = f, "ComfyUI respawned — VRAM reclaimed");
                    break;
                }
            }
        }
    }
    free
}

/// v0.2.2 — Symmetric counterpart to `unload_llm`. Removes the
/// `.llamacpp_suspended` sentinel so the supervisor's health loop
/// respawns llama-server on its next tick (≤3 s), then blocks until
/// `:8733/health` answers so the next LLM request lands on a warm
/// server instead of a "Connection refused".
///
/// Call BEFORE any pipeline phase whose Python endpoint may invoke an
/// LLM directly or transitively (music style hints, subtitle
/// translation, shorts caption generation). The previous behaviour
/// (`LlamaCppBackend.chat()` clearing the flag itself) only fired
/// when the call site reached that backend — so a `/music` endpoint
/// that takes the library path without ever touching the LLM left the
/// flag stuck, blocking every later LLM-bearing phase until the
/// supervisor TTL kicked in. This helper closes that hole proactively.
///
/// Best-effort: never fails the pipeline. Worst case the LLM call
/// later sees a still-cold server and retries via the backend's own
/// 30 s health probe.
async fn wake_llm(client: &reqwest::Client) {
    if let Ok(p) = paths::paths() {
        let flag = p.data_dir.join(".llamacpp_suspended");
        if flag.is_file() {
            let _ = std::fs::remove_file(&flag);
        }
    }
    // Give the supervisor up to ~10 s to spawn llama-server. The health
    // loop sleeps 3 s between ticks so 3-4 polls cover the worst case.
    // We DON'T fail if it doesn't come back — the Python `LlamaCppBackend`
    // has its own 30 s health probe inside `chat()` which is the
    // authoritative wait. This is just a head-start.
    for _ in 0..20 {
        let ok = client
            .get(format!("{}/health", LLAMACPP_SIDECAR))
            .timeout(std::time::Duration::from_millis(500))
            .send()
            .await
            .map(|r| {
                let s = r.status().as_u16();
                s == 200 || s == 503
            })
            .unwrap_or(false);
        if ok { return; }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
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
    setting_tag: Option<&str>,
    width: u32,
    height: u32,
    out_dir: &str,
    out_path: &str,
) -> anyhow::Result<()> {
    // v0.1.37: build a VIRAL thumbnail prompt that prioritizes click-through.
    // - Anchor with the LLM-generated setting_tag when present (era + culture
    //   + palette specific to this topic).
    // - Use viral-thumbnail composition language: extreme close-up,
    //   high-contrast, dramatic facial expression, punchy saturated
    //   colours, hook-element in foreground.
    // - Leave the bottom 1/3 visually "quieter" so the title overlay
    //   from thumbnail.html lands on a readable area.
    let setting_prefix = setting_tag.unwrap_or("").trim();
    let prompt_topic = if !setting_prefix.is_empty() {
        format!("{}. {}", setting_prefix, topic)
    } else {
        topic.to_string()
    };
    let prompt = format!(
        "VIRAL YOUTUBE THUMBNAIL: {prompt_topic}. Extreme dramatic close-up \
         hero shot, intense emotional expression on the central subject, \
         iconic element of the topic in the foreground, high-contrast \
         saturated colours, rim lighting, deep shadows on the lower third \
         (so title text overlays cleanly), epic atmosphere, photorealistic, \
         ultra-detailed, sharp focus on subject, shallow depth of field, \
         clickbait-grade composition, period-correct iconography faithful \
         to the topic, no text overlay, no logos, no watermarks",
        prompt_topic = prompt_topic
    );
    let bg = client
        .post(format!("{}/image", PY_SIDECAR))
        // v0.2.6 — was 30 min. A single 1280×720 Z-Image thumbnail is
        // ~20-40 s warm, ~90 s cold. If it isn't done in 4 min the
        // ComfyUI sampler is thrashing (Sysmem fallback) and will never
        // finish — fail fast so the caller extracts a video frame
        // instead of burning 30 min on a doomed prompt.
        .timeout(std::time::Duration::from_secs(4 * 60))
        .json(&serde_json::json!({
            "prompt": prompt,
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
    // v0.1.37: pass the full set of new viral fields. The Node renderer
    // builds the punchy "first word in gold + rest in white" headline;
    // we pass meta.title_en as the headline and a topic-derived badge.
    let badge = setting_prefix
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_uppercase();
    // v0.1.38: derive a SHORT tagline subtitle from the setting_tag instead
    // of repeating the topic (which doubles as the big title). E.g.
    // "Ancient Egyptian setting (sand-gold, …)" → "ANCIENT EGYPTIAN ·
    // REAL HISTORY". When setting_tag is missing we fall back to a
    // generic tagline so the thumbnail never shows duplicate copy.
    let core_setting = setting_prefix
        .splitn(2, |c: char| c == '(' || c == '[')
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches(|c: char| ".,;: ".contains(c))
        .to_string();
    let core_setting = {
        let lower = core_setting.to_lowercase();
        let trimmed = ["setting", "era", "period", "world", "universe", "atmosphere"]
            .iter()
            .fold(lower, |acc, suffix| {
                if acc.ends_with(suffix) {
                    acc[..acc.len() - suffix.len()].trim().to_string()
                } else { acc }
            });
        trimmed.trim_end_matches(|c: char| ".,;: ".contains(c)).to_string()
    };
    let subtitle_text = if core_setting.is_empty() {
        "REAL HISTORY".to_string()
    } else {
        format!("{} · REAL HISTORY", core_setting.to_uppercase())
    };
    let _thumb = client
        .post(format!("{}/render/thumbnail", NODE_SIDECAR))
        .timeout(std::time::Duration::from_secs(2 * 60))
        .json(&serde_json::json!({
            "title_en": meta["title_en"],
            "title_zh": meta["title_zh"],
            "subtitle": subtitle_text,
            "badge": badge,
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
    intro_eyebrow: &str,
) -> anyhow::Result<serde_json::Value> {
    let resp = client
        .post(format!("{}/render/narrative", NODE_SIDECAR))
        .timeout(std::time::Duration::from_secs(45 * 60))
        .json(&serde_json::json!({
            "project_id": pid,
            "title": title,
            // v0.1.38 — eyebrow line on the intro card. Derived from the
            // setting_tag so it reads "ANCIENT EGYPTIAN · HISTORIA REAL"
            // instead of the generic "DOCUMENTAL" fallback.
            "intro_eyebrow": intro_eyebrow,
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
    /// Single IETF tag of the audio TTS language. When absent we fall
    /// back to `languages[0]` so older callers keep working.
    #[serde(default)]
    pub audio_language: Option<String>,
    /// Multi IETF tags — every entry produces its own SRT + ASS in the
    /// subtitles phase. The audio_language entry is the one burned
    /// into the rendered MP4. When absent we fall back to `languages`.
    #[serde(default)]
    pub subtitle_languages: Option<Vec<String>>,
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
    // Project rule: wake llama-server before any LLM-bearing phase so the
    // supervisor respawns it before the first request arrives. Phase 1 is
    // always an LLM phase (both legacy and long-form paths), so wake_llm
    // unconditionally here (same pattern as phases 7 and 8+sub-phases).
    wake_llm(&client).await;
    emit(app, pid, 1, "running", 0.0, "Generando guion…");

    let llm_model = req.llm_model.clone().unwrap_or_else(|| "xianxia-llm".to_string());
    // Primary language tag: used by /script/outline and /script/chapter
    // (which take a single `language` string, unlike legacy /script which
    // takes `languages: list`).
    let lang_tag = req.languages.first().map(|s| s.as_str()).unwrap_or("en");

    let script_resp: serde_json::Value = if req.target_minutes >= 7 {
        // ── Long-form branch: outline + per-chapter loop + resume ────────
        // Step 1: get outline (reuse persisted if resuming)
        let outline_json: String = match db::chapters::get_outline(pool, pid).await.ok().flatten() {
            Some(j) => {
                tracing::info!(project = %pid, "long-form: reusing persisted outline (resume)");
                j
            }
            None => {
                emit(app, pid, 1, "running", 5.0, "Generando esquema de capítulos…");
                let outline_resp: serde_json::Value = client
                    .post(format!("{}/script/outline", PY_SIDECAR))
                    .timeout(std::time::Duration::from_secs(15 * 60))
                    .json(&serde_json::json!({
                        "topic": req.topic,
                        "target_minutes": req.target_minutes,
                        "language": lang_tag,
                        "model": llm_model,
                        "context_facts": "",
                    }))
                    .send()
                    .await
                    .context("phase 1 long-form: /script/outline request failed")?
                    .json::<serde_json::Value>()
                    .await
                    .context("phase 1 long-form: /script/outline JSON decode failed")?;
                // Persist the raw `chapters` array as a JSON string so a
                // resume run can skip this call entirely.
                let j = serde_json::to_string(
                    outline_resp.get("chapters").unwrap_or(&serde_json::json!([])),
                )
                .unwrap_or_else(|_| "[]".to_string());
                if let Err(e) = db::chapters::save_outline(pool, pid, &j).await {
                    tracing::warn!(error = %e, "long-form: could not persist outline (best-effort)");
                }
                j
            }
        };

        // Parse chapters array. On failure fall back to the legacy single-call.
        let chapters_arr: Vec<serde_json::Value> = serde_json::from_str::<serde_json::Value>(&outline_json)
            .ok()
            .and_then(|v| match v {
                serde_json::Value::Array(a) => Some(a),
                _ => None,
            })
            .unwrap_or_default();

        if chapters_arr.is_empty() {
            tracing::warn!(
                project = %pid,
                "long-form: outline empty or unparseable — falling back to legacy /script"
            );
            // ── Graceful degradation: single-call legacy path ───────────
            client
                .post(format!("{}/script", PY_SIDECAR))
                .timeout(std::time::Duration::from_secs(30 * 60))
                .json(&serde_json::json!({
                    "topic": req.topic,
                    "target_minutes": req.target_minutes,
                    "languages": req.languages,
                    "model": llm_model,
                    "experimental": req.experimental_llm,
                }))
                .send()
                .await
                .context("phase 1 long-form fallback: /script request failed")?
                .json::<serde_json::Value>()
                .await
                .context("phase 1 long-form fallback: /script JSON decode failed")?
        } else {
            // Step 2: per-chapter loop with resume
            let total = chapters_arr.len();
            let done_rows = db::chapters::list_chapters(pool, pid).await.unwrap_or_default();
            let mut running_summary = String::new();
            let mut chapter_texts: Vec<String> = Vec::with_capacity(total);

            // ETA tracking — only counts freshly-generated chapters (not resumed ones).
            let mut fresh_start: Option<std::time::Instant> = None;
            let mut fresh_done: usize = 0;

            for (idx_zero, chapter_val) in chapters_arr.iter().enumerate() {
                let idx = (idx_zero + 1) as i64; // 1-based
                let chapter_title = chapter_val
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // Resume: if this chapter is already done and its file exists, reuse it.
                let resume_row = done_rows
                    .iter()
                    .find(|r| r.chapter_index == idx && r.status == "done");
                if let Some(row) = resume_row {
                    if let Some(ref path) = row.narration_path {
                        if std::path::Path::new(path).exists() {
                            let text = std::fs::read_to_string(path).unwrap_or_default();
                            if !text.is_empty() {
                                tracing::info!(
                                    project = %pid,
                                    chapter = idx,
                                    "long-form: resuming — reusing persisted chapter text"
                                );
                                if let Some(ref s) = row.summary_text {
                                    running_summary = s.clone();
                                }
                                chapter_texts.push(text);
                                emit(
                                    app, pid, 1, "running",
                                    (idx as f64 / total as f64) * 90.0,
                                    &format!("Capítulo {idx}/{total} (resumido)"),
                                );
                                emit_chapter(
                                    app, pid, idx, total as i64, &chapter_title, "done",
                                    row.words.unwrap_or(0), None,
                                );
                                continue;
                            }
                        }
                    }
                }

                emit(
                    app, pid, 1, "running",
                    5.0 + (idx as f64 / total as f64) * 85.0,
                    &format!("Escribiendo capítulo {idx}/{total}…"),
                );
                emit_chapter(app, pid, idx, total as i64, &chapter_title, "writing", 0, None);

                // ETA: start the clock just before the first fresh HTTP call so
                // elapsed after chapter-1 completes reflects real generation time
                // (not ~0 as it would if set after the response arrives).
                if fresh_start.is_none() {
                    fresh_start = Some(std::time::Instant::now());
                }

                let is_final = idx_zero + 1 == total;
                let chapter_resp: serde_json::Value = client
                    .post(format!("{}/script/chapter", PY_SIDECAR))
                    .timeout(std::time::Duration::from_secs(15 * 60))
                    .json(&serde_json::json!({
                        "topic": req.topic,
                        "language": lang_tag,
                        "outline": chapters_arr,
                        "chapter_index": idx,
                        "running_summary": running_summary,
                        "is_final": is_final,
                        "model": llm_model,
                    }))
                    .send()
                    .await
                    .with_context(|| format!("phase 1 long-form: /script/chapter {idx} request failed"))?
                    .json::<serde_json::Value>()
                    .await
                    .with_context(|| format!("phase 1 long-form: /script/chapter {idx} JSON decode failed"))?;

                let text = chapter_resp["text"].as_str().unwrap_or("").to_string();
                let new_summary = chapter_resp["running_summary"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let words = chapter_resp["words"].as_i64().unwrap_or(0);

                // Write chapter text to disk next to the project.
                let chapter_path = project_dir.join(format!("chapter-{:02}.txt", idx));
                let _ = std::fs::write(&chapter_path, &text);

                running_summary = new_summary.clone();

                // Persist chapter state (best-effort; never fails the pipeline).
                // Clone title before moving it into NewChapter so emit_chapter can use it.
                let chapter_title_clone = chapter_title.clone();
                if let Err(e) = db::chapters::upsert_chapter(
                    pool,
                    &db::chapters::NewChapter {
                        project_id: pid.to_string(),
                        chapter_index: idx,
                        title: chapter_title,
                        status: "done".to_string(),
                        narration_path: Some(chapter_path.to_string_lossy().to_string()),
                        summary_text: Some(new_summary),
                        words: Some(words),
                        error_message: None,
                    },
                )
                .await
                {
                    tracing::warn!(
                        error = %e,
                        chapter = idx,
                        "long-form: could not persist chapter state (best-effort)"
                    );
                }
                // ETA: count completed fresh chapters for average calculation.
                fresh_done += 1;
                let eta_seconds: Option<i64> = if let Some(t0) = fresh_start {
                    let remaining = total.saturating_sub(idx_zero + 1);
                    if remaining > 0 {
                        let elapsed_secs = t0.elapsed().as_secs_f64();
                        let avg = elapsed_secs / fresh_done as f64;
                        Some((avg * remaining as f64).round() as i64)
                    } else {
                        Some(0)
                    }
                } else {
                    None
                };
                emit_chapter(app, pid, idx, total as i64, &chapter_title_clone, "done", words, eta_seconds);

                chapter_texts.push(text);
            }

            // Assemble the full script from chapter parts.
            let assembled_script = chapter_texts.join("\n\n");

            // POST to /script/postprocess — runs the identical Python post-processing
            // (setting_tag inference, image-prompt grounding, auto-marker injection,
            // diversify) and returns the SAME ScriptResponse shape as /script.
            // wake_llm was already called at the top of phase 1 (line ~600) and
            // covers this call too — postprocess runs in the same LLM session.
            client
                .post(format!("{}/script/postprocess", PY_SIDECAR))
                .timeout(std::time::Duration::from_secs(15 * 60))
                .json(&serde_json::json!({
                    "script": assembled_script,
                    "topic": req.topic,
                    "languages": req.languages,
                    "target_minutes": req.target_minutes,
                    "model": req.llm_model.clone().unwrap_or_else(|| "xianxia-llm".into()),
                }))
                .send()
                .await
                .context("phase 1 long-form: /script/postprocess request failed")?
                .json::<serde_json::Value>()
                .await
                .context("phase 1 long-form: /script/postprocess JSON decode failed")?
        }
    } else {
        // ── Legacy path (< 7 min): single /script call, byte-identical ──
        client
            .post(format!("{}/script", PY_SIDECAR))
            .timeout(std::time::Duration::from_secs(30 * 60))
            .json(&serde_json::json!({
                "topic": req.topic,
                "target_minutes": req.target_minutes,
                "languages": req.languages,
                "model": llm_model,
                "experimental": req.experimental_llm,
            }))
            .send()
            .await
            .context("phase 1: script request failed")?
            .json::<serde_json::Value>()
            .await
            .context("phase 1: script JSON decode failed")?
    };

    let narration = script_resp["narration"].as_str().unwrap_or("").to_string();
    let _full_script = script_resp["script"].as_str().unwrap_or("").to_string();
    let markers = script_resp["markers"].clone();
    persist_step(pool, pid, 1, "done", &script_resp).await?;
    // Persist the raw script (with [CHAPTER:]/[IMAGE:] markers) next to
    // the project so the SEO pack — phase 12 here, or the Library panel
    // re-run on an OLD project — can rebuild real chapters from it.
    let _ = std::fs::write(project_dir.join("script.txt"), &_full_script);
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
    // Free the LLM (~3-5 GB) before TTS loads its own weights. In v0.2.0+
    // the default backend is llama.cpp: the sidecar kills `llama-server.exe`
    // and drops the `.llamacpp_suspended` flag so the supervisor doesn't
    // respawn during the image/TTS/depth chain. If the user explicitly
    // selected Ollama from Settings, the same call falls back to
    // `keep_alive=0` + /api/ps polling. Either way the Rust pipeline stays
    // backend-agnostic.
    unload(&client, "llm").await;

    // ─── Phase 3: TTS ────────────────────────────────────────────────
    // Audio language comes from the FIRST entry in `languages` (the UI's
    // primary-language convention). Map IETF tag → Qwen3-TTS canonical
    // name; everything outside the catalog defaults to English so the
    // TTS still produces something legible instead of erroring out. The
    // earlier hardcoded "English" silently ignored the user's selection,
    // so even when the UI checked Spanish first the audio came back in
    // English (and only the subtitles honoured the Spanish request).
    // Audio language: explicit `audio_language` field wins; legacy
    // path falls back to `languages[0]` for backcompat.
    let audio_lang_tag = req
        .audio_language
        .as_deref()
        .or_else(|| req.languages.first().map(|s| s.as_str()))
        .unwrap_or("en");
    let audio_lang_name = match audio_lang_tag {
        "en" => "English",
        "es" => "Spanish",
        "zh" | "zh-CN" => "Chinese",
        "ja" => "Japanese",
        "ko" => "Korean",
        "de" => "German",
        "fr" => "French",
        "it" => "Italian",
        "pt" | "pt-BR" => "Portuguese",
        "ru" => "Russian",
        _ => "English",
    };
    emit(app, pid, 3, "running", 0.0,
        &format!("Sintetizando voz en {}…", audio_lang_name));

    // ── Phase 3 resume guard ─────────────────────────────────────────
    // If a prior run already completed TTS and the WAV is still on disk,
    // skip the ~2-25 min Qwen3-TTS call and reuse the recorded artifact.
    let (narration_audio, narration_duration) = if let Some(cached) =
        phase_already_done(pool, pid, 3).await
    {
        let path = cached["audio_path"].as_str().unwrap_or("").to_string();
        let dur  = cached["duration_seconds"].as_f64().unwrap_or(0.0);
        tracing::info!(project = %pid, audio_path = %path, "phase 3: resuming — reusing persisted TTS audio");
        emit(app, pid, 3, "done", 100.0, "Voz (reanudada — ya completada)");
        (path, dur)
    } else {
        // v0.2.6.1 — best-effort VRAM reclaim before loading the ~7 GB
        // Qwen3-TTS clone model. llama-server is already killed (above), but
        // a ComfyUI baseline + desktop GPU apps (browser/Teams/Photos) can
        // shave the headroom enough that the clone model spills into Windows
        // Sysmem-fallback thrash (the 2026-05-15 run: TTS clone took 17 min
        // vs ~2.5 min normal). We reclaim everything WE control; this never
        // aborts (TTS is mandatory — there is no library fallback for the
        // narration) — it just maximises the free card.
        ensure_comfyui_vram(app, &client, 6.0).await;
        let tts: serde_json::Value = client
            .post(format!("{}/tts", PY_SIDECAR))
            // v0.2.6.1 — was UNBOUNDED. A TTS clone that fell into Sysmem
            // thrash with no timeout would hang the ENTIRE pipeline forever
            // (the worst failure mode — no error, no recovery). 25 min
            // covers a legitimately slow long-form clone with margin while
            // bounding a true hang so the run fails cleanly instead of
            // hanging indefinitely.
            .timeout(std::time::Duration::from_secs(25 * 60))
            .json(&serde_json::json!({
                "text": narration,
                "language": audio_lang_name,
                "speaker": req.voice_speaker.clone().unwrap_or_else(|| "Vivian".to_string()),
                "out_dir": out_dir,
            }))
            .send()
            .await?
            .json()
            .await?;
        let path = tts["audio_path"].as_str().unwrap_or("").to_string();
        // Real audio duration (seconds). The LLM produces image markers with
        // timestamps based on a hard-coded 150 wpm assumption, but Qwen3-TTS
        // narrates at its own pace — combined with the LLM's tendency to put
        // markers in the second half of a script, the marker timestamps end
        // up far off the actual audio. We use the TTS's reported duration to
        // redistribute beats UNIFORMLY across the whole audio in Phase 4
        // instead of trusting the marker timestamps. Result: no 17 s of black
        // at the start, no 34 s of black at the end, no last image clipped.
        let dur = tts["duration_seconds"].as_f64().unwrap_or(0.0);
        persist_step(pool, pid, 3, "done", &tts).await?;
        emit(app, pid, 3, "done", 100.0, "Voz lista");
        (path, dur)
    };
    // (variable names kept identical to the pre-resume shape so all downstream
    // code — phases 4, 6, 8 — consumes them without any other changes)
    // Free Qwen3-TTS VRAM before Z-Image loads (~4-5 GB recovered).
    unload(&client, "tts").await;

    // ─── Phase 4: Images (one per IMAGE marker) ──────────────────────
    // Native aspect generation: vertical Shorts → 720x1280, horizontal video → 1280x720.
    // Both fit comfortably in 8 GB VRAM (sweet spot per Z-Image-Turbo Q4 GGUF benchmarks)
    // and avoid the offload cost of going to 768x1344 / 1344x768.
    let (img_w, img_h) = if req.vertical { (720, 1280) } else { (1280, 720) };
    emit(app, pid, 4, "running", 0.0, &format!("Generando imágenes {}x{}…", img_w, img_h));

    // ── Phase 4 resume guard ─────────────────────────────────────────
    // Phase 4 stores {"beats": [...]} where each beat has a "path" key.
    // phase_already_done() only checks scalar path keys, so we do a custom
    // check: fetch the persisted row and verify EVERY beat path still exists.
    let mut beats: Vec<serde_json::Value> = {
        let cached_beats: Option<Vec<serde_json::Value>> = async {
            let (status, oj): (String, Option<String>) = sqlx::query_as(
                "SELECT status, output_json FROM pipeline_steps \
                 WHERE project_id = ? AND phase = 4",
            )
            .bind(pid)
            .fetch_optional(pool)
            .await
            .ok()??;
            if status != "done" { return None; }
            let v: serde_json::Value = serde_json::from_str(&oj?).ok()?;
            let arr = v.get("beats")?.as_array()?.clone();
            if arr.is_empty() { return None; }
            // All still images (path key) must exist; clip_paths are optional.
            for beat in &arr {
                let p = beat.get("path").and_then(|p| p.as_str()).unwrap_or("");
                if p.is_empty() || !std::path::Path::new(p).exists() {
                    return None;
                }
            }
            Some(arr)
        }.await;

        if let Some(arr) = cached_beats {
            tracing::info!(
                project = %pid, beats = arr.len(),
                "phase 4: resuming — reusing {} persisted image beats", arr.len()
            );
            emit(app, pid, 4, "done", 100.0, "Imágenes (reanudadas — ya completadas)");
            arr
        } else {
            Vec::new() // will be populated in the normal generation path below
        }
    };

    let beats_already_done = !beats.is_empty();
    if !beats_already_done {
    if let Some(arr) = markers.as_array() {
        let image_markers: Vec<&serde_json::Value> =
            arr.iter().filter(|m| m["kind"] == "image").collect();
        let total = image_markers.len().max(1);
        for (i, m) in image_markers.iter().enumerate() {
            let prompt = m["prompt"].as_str().unwrap_or("");
            // v0.2.1 — preserve the marker's ORIGINAL textual timestamp
            // (computed by `parse_markers` from words-before / 150 wpm),
            // so the timeline normalisation below can scale text-relative
            // positions to the real audio duration instead of throwing
            // them away with a uniform distribution.
            let text_seconds = m["timestamp_seconds"].as_f64().unwrap_or(0.0);
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
            // Placeholder start/duration — replaced below by the
            // text-proportional scaling pass.
            beats.push(serde_json::json!({
                "path": img_path.clone(),
                "text_seconds": text_seconds,
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
    } // end if let Some(arr) = markers.as_array()
    } // end if !beats_already_done (image generation block)
    // ─── Beat timeline normalisation (v0.2.1: text-proportional) ────
    //
    // Bug we're fixing: the previous version used `normalise_beat_timeline`
    // which spread every beat UNIFORMLY across the audio. That guaranteed
    // coverage but broke the link between image and narration — Gemma
    // wrote `[IMAGE: serpiente emplumada]` after sentence 5 of the script,
    // the uniform distribution then placed it at second 45 of the audio,
    // but at second 45 the voice was already talking about the Aztec
    // calendar. User feedback: "muchas imágenes extremadamente iguales,
    // y que a lo mejor no concuerdan con el punto exacto del montaje".
    //
    // Fix: each marker comes from `parse_markers` with `timestamp_seconds`
    // = (words_before / 150) * 60 — i.e. its CHARACTER POSITION in the
    // script translated to a 150 wpm clock. That's a faithful proxy for
    // *when in the narration* the marker should fire. The real TTS rate
    // is rarely exactly 150 wpm, so we LINEARLY SCALE every marker's
    // text_seconds to the real audio duration. Result: markers retain
    // their relative position in the narration but cover the full audio
    // without dead air. No more "image-narration desync".
    //
    // Each beat's duration = next beat's start − current start. The last
    // beat extends to the end of the audio so we never leave a black tail.
    //
    // Skip when resuming: the cached beats already carry correct start/
    // duration/transition from the original run — no need to rewrite them.
    if !beats_already_done && !beats.is_empty() && narration_duration > 0.0 {
        let n = beats.len();
        // Find the maximum text_seconds — that's the scale denominator.
        // If all beats reported 0 (legacy clients), fall back to uniform.
        let max_text = beats
            .iter()
            .filter_map(|b| b["text_seconds"].as_f64())
            .fold(0.0f64, f64::max);
        if max_text > 0.0 {
            // Same transition cycle the legacy uniform path used (v0.1.23
            // dropped inkwash because it created the "iris closing on a
            // near-identical image" effect). Defined here locally so the
            // text-scaled path stays in sync with normalise_beat_timeline.
            const TRANS: &[&str] = &["cross", "flash", "cross", "whip"];
            let scale = narration_duration / max_text;
            // Pass 1: scale every beat's start time.
            let mut scaled_starts: Vec<f64> = beats
                .iter()
                .map(|b| {
                    let t = b["text_seconds"].as_f64().unwrap_or(0.0);
                    (t * scale).max(0.0).min(narration_duration)
                })
                .collect();
            // Defensive: parse_markers sometimes emits two adjacent markers
            // at the same word offset (e.g. `[IMAGE: a] [IMAGE: b]` with
            // no narration between them). Bump duplicates forward by 0.5 s
            // so each image still gets visible screen time.
            for i in 1..scaled_starts.len() {
                if scaled_starts[i] <= scaled_starts[i - 1] {
                    scaled_starts[i] = (scaled_starts[i - 1] + 0.5).min(narration_duration);
                }
            }
            // Pass 2: write start + duration. duration = next.start − this.start
            // (last beat extends to audio end).
            for (i, start) in scaled_starts.iter().enumerate() {
                let next_start = scaled_starts
                    .get(i + 1)
                    .copied()
                    .unwrap_or(narration_duration);
                let duration = (next_start - start).max(0.5);
                let transition = TRANS[i % TRANS.len()];
                beats[i]["start"] = serde_json::json!(*start);
                beats[i]["duration"] = serde_json::json!(duration);
                beats[i]["transition"] = serde_json::json!(transition);
            }
            tracing::info!(
                beats = n,
                audio_seconds = narration_duration,
                max_text_seconds = max_text,
                scale = scale,
                "beat timeline scaled from text-position to real audio duration",
            );
        } else {
            // No text positions (very old marker shape) — fall back to
            // the legacy uniform behaviour so nothing crashes.
            let normalised = normalise_beat_timeline(n, narration_duration);
            for (i, slot) in normalised.iter().enumerate() {
                beats[i]["start"] = serde_json::json!(slot.start);
                beats[i]["duration"] = serde_json::json!(slot.duration);
                beats[i]["transition"] = serde_json::json!(slot.transition);
            }
            tracing::warn!(
                beats = n,
                "no text_seconds on beats — falling back to uniform distribution",
            );
        }
    }

    if !beats_already_done {
        persist_step(pool, pid, 4, "done", &serde_json::json!({"beats": beats})).await?;
        emit(app, pid, 4, "done", 100.0, "Imágenes listas");
    }
    // (when beats_already_done the emit + persist were already done in the resume guard above)

    // Sequential VRAM swap: free Z-Image (ComfyUI) before depth/render/whisper.
    unload(&client, "comfyui").await;
    unload(&client, "image").await;

    // ─── Phase 4b: DepthFlow 2.5D parallax clips (v0.1.38) ──────────────
    // For each generated still we ask DepthFlow to render a short
    // parallax MP4 (12 s, looped at the renderer level). DepthFlow uses
    // a per-pixel depth gradient (Depth-Anything-V2 + GLSL shader) so
    // there are NO inpainting artefacts — fixes the "broken pyramid
    // tops" problem we saw with the legacy rembg+inpaint approach.
    //
    // Auto-detection: if the DepthFlow venv isn't installed (wizard
    // component `python-deps-depthflow` not run yet), `/depthflow/health`
    // reports `venv_python_exists=false` and we skip this phase. The
    // renderer then falls back to single-image + Ken Burns. Same goes
    // for any clip-level error: the beat keeps its still image path
    // and the renderer just plays it as <img> instead of <video>.
    emit(app, pid, 4, "running", 80.0, "Generando parallax 2.5D con DepthFlow…");

    let depthflow_available = match client
        .get(format!("{}/depthflow/health", PY_SIDECAR))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
            Ok(v) => v
                .get("venv_python_exists")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            Err(_) => false,
        },
        _ => false,
    };

    let mut all_layered = false;
    if depthflow_available && !beats.is_empty() {
        let img_paths: Vec<String> = beats
            .iter()
            .map(|b| b["path"].as_str().unwrap_or("").to_string())
            .collect();
        let df_dir = format!("{}/df-clips", out_dir);
        let _ = std::fs::create_dir_all(&df_dir);
        let df_call = client
            .post(format!("{}/depthflow/batch", PY_SIDECAR))
            .timeout(std::time::Duration::from_secs(30 * 60))
            .json(&serde_json::json!({
                "images": img_paths,
                "out_dir": df_dir,
                // 12-second clips loop at the renderer level, so we never
                // need a per-beat-duration generation cost spike. Empirically
                // this avoids the GPU OOM that 41 s clips triggered on RTX
                // 4060 Laptop while still giving every beat its own unique
                // depth-driven camera move.
                "duration_seconds": 12.0,
                "fps": 24,
                "width": if req.vertical { 1080 } else { 1920 },
                "height": if req.vertical { 1920 } else { 1088 },
            }))
            .send()
            .await;
        if let Ok(resp) = df_call {
            if resp.status().is_success() {
                if let Ok(df_resp) = resp.json::<serde_json::Value>().await {
                    if let Some(results) = df_resp["results"].as_array() {
                        // v0.1.46: accept PARTIAL results. Previously we
                        // required `results.len() == beats.len()` (all 16
                        // of 16) and otherwise discarded every clip,
                        // including the ones that succeeded — so a single
                        // UnicodeDecodeError on clip 13 destroyed the
                        // parallax for clips 0-12 too. Now we attach a
                        // clip_path to every beat whose result is valid
                        // and leave the rest as static KenBurns. The
                        // renderer handles a mixed timeline fine.
                        let mut attached = 0usize;
                        for (i, r) in results.iter().enumerate() {
                            if i >= beats.len() { break; }
                            if let Some(out) = r["output_path"].as_str() {
                                if !out.is_empty()
                                    && std::fs::metadata(out)
                                        .map(|m| m.len() > 1024)
                                        .unwrap_or(false)
                                {
                                    beats[i]["clip_path"] = serde_json::json!(out);
                                    attached += 1;
                                }
                            }
                        }
                        if attached == beats.len() {
                            all_layered = true;
                            emit(app, pid, 4, "done", 100.0, "Parallax 2.5D listo (DepthFlow)");
                        } else if attached > 0 {
                            tracing::warn!(
                                attached, total = beats.len(),
                                "depthflow batch partial — using {attached}/{} clips, rest as KenBurns",
                                beats.len()
                            );
                            emit(
                                app, pid, 4, "done", 100.0,
                                &format!("Parallax 2.5D parcial: {}/{} clips", attached, beats.len()),
                            );
                        } else {
                            emit(app, pid, 4, "done", 100.0, "Parallax sin clips — usando KenBurns");
                        }
                    }
                }
            } else {
                tracing::warn!(
                    status = %resp.status(),
                    "depthflow batch returned non-2xx — falling back to single-image",
                );
                // v0.1.45: emit phase-4 completion on fallback so the
                // UI doesn't stay stuck at the last DepthFlow progress
                // percentage (user complaint: "stuck at 80%"). The
                // pipeline really IS continuing to music; without this
                // explicit emit the renderer never sees the phase
                // transition and the progress bar appears frozen.
                emit(app, pid, 4, "done", 100.0, "Parallax falló — continuando con KenBurns");
            }
        } else if let Err(e) = df_call {
            tracing::warn!(error = %e, "depthflow batch errored — falling back to single-image");
            emit(app, pid, 4, "done", 100.0, "DepthFlow inalcanzable — continuando con KenBurns");
        }
    } else if !depthflow_available {
        tracing::info!("depthflow venv not installed — skipping parallax phase, using single-image render");
        emit(app, pid, 4, "done", 100.0, "Imágenes listas (DepthFlow no instalado)");
    }
    unload(&client, "depth").await;

    // ─── Phase 5: Music selector ─────────────────────────────────────
    emit(app, pid, 5, "running", 0.0, "Seleccionando música…");

    // ── Phase 5 resume guard ─────────────────────────────────────────
    // If a prior run already selected/generated music and the audio file
    // is still on disk, skip the ~7-12 min ACE-Step / MusicGen call.
    // `music` is used downstream as the JSON value passed to /render/narrative
    // (music_path key) and /render (music_path key from FFmpeg path) — both
    // read music["audio_path"], so reusing the whole JSON is safe.
    let music: serde_json::Value = if let Some(cached) = phase_already_done(pool, pid, 5).await {
        tracing::info!(
            project = %pid, audio_path = %cached["audio_path"].as_str().unwrap_or(""),
            "phase 5: resuming — reusing persisted music track"
        );
        emit(app, pid, 5, "done", 100.0, "Música (reanudada — ya completada)");
        cached
    } else {
    // v0.2.3 — DO NOT wake llama-server before /music. MusicGen needs
    // ~4 GB VRAM and llama-server holds ~3 GB; with 8 GB total the
    // contention either spills MusicGen to CPU (50× slower) or stalls
    // outright. /music never invokes the LLM (style_hint is computed
    // ahead of time from the script_resp.setting_tag), so keeping the
    // suspend flag in place through music + render + thumbnail and
    // only waking the LLM right before /subtitles is the correct
    // VRAM choreography. v0.2.2 mistakenly inserted wake_llm here
    // and that's what hung the post-DepthFlow phase in field tests.
    // v0.1.38: pass topic + setting_tag as style_hint so the music
    // generator biases toward the right era / culture (e.g. "1990s
    // superhero TV" for Power Rangers vs "ancient Egyptian percussion"
    // for Egyptian gods) instead of always sounding xianxia-orchestral.
    let style_hint = script_resp.get("setting_tag")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| req.topic.clone());
    // v0.2.6 — hard 12-min timeout. Python `/music` is MusicGen-only now
    // (ACE-Step removed: see CHANGELOG and routes/music.py). MusicGen has
    // a strict GPU-only pre-check (≥4 GB free VRAM, else 503). For an 8-min
    // narrative MusicGen needs ~7-9 min of chunked generation, so 12 min
    // covers the happy path with margin. On timeout / any error we fall
    // back to a library track (instant) so the pipeline never stalls on
    // this phase.
    // v0.2.9 — ACE-Step v1.5 is the PRINCIPAL music generator (no
    // toggle). `use_musicgen` means "generate AI music" — the Python
    // /music route always tries ACE-Step first (its venv auto-bootstraps
    // in the background), then MusicGen, then library. _acestep_v15
    // never raises so the chain can't block.
    let music_body = serde_json::json!({
        "mood": "epic",
        "duration_seconds": script_resp["estimated_seconds"].as_f64().unwrap_or(900.0),
        "use_musicgen": req.use_musicgen,
        "style_hint": style_hint,
    });
    let music_first = client
        .post(format!("{}/music", PY_SIDECAR))
        .timeout(std::time::Duration::from_secs(12 * 60))
        .json(&music_body)
        .send()
        .await;
    let music: serde_json::Value = match music_first {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "music JSON decode failed — falling back to library");
                emit(app, pid, 5, "running", 95.0, "MusicGen falló, usando librería local…");
                let fb_body = serde_json::json!({
                    "mood": "epic",
                    "duration_seconds": script_resp["estimated_seconds"].as_f64().unwrap_or(900.0),
                    "use_musicgen": false,
                    "style_hint": style_hint,
                });
                client.post(format!("{}/music", PY_SIDECAR))
                    .timeout(std::time::Duration::from_secs(120))
                    .json(&fb_body).send().await?.json().await?
            }
        },
        other => {
            let why = match other {
                Ok(r) => format!("status {}", r.status()),
                Err(e) => e.to_string(),
            };
            tracing::warn!(reason = %why, "musicgen call failed — falling back to library");
            emit(app, pid, 5, "running", 95.0, "MusicGen falló, usando librería local…");
            let fb_body = serde_json::json!({
                "mood": "epic",
                "duration_seconds": script_resp["estimated_seconds"].as_f64().unwrap_or(900.0),
                "use_musicgen": false,
                "style_hint": style_hint,
            });
            client.post(format!("{}/music", PY_SIDECAR))
                .timeout(std::time::Duration::from_secs(120))
                .json(&fb_body).send().await?.json().await?
        }
    }; // end inner match (new music generation)
    persist_step(pool, pid, 5, "done", &music).await?;
    emit(app, pid, 5, "done", 100.0, "Música lista");
    music // return value for the outer `else` arm
    }; // end phase 5 resume else-branch
    // Release MusicGen PyTorch tensors (~3-4 GB) before render.
    // Phase 6 doesn't need GPU compute (HyperFrames uses Chromium + ffmpeg
    // NVENC) so this is the cheapest phase to leave VRAM clean for.
    // When resuming, music was not loaded so the unload is a no-op.
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

    // ── Phase 6 resume guard ─────────────────────────────────────────
    // If a prior run already rendered the final MP4 and the file is still
    // on disk, skip the 20-60 min HyperFrames / FFmpeg render. The
    // `video_path` key was added to the persisted output in v0.5.0
    // (additive — does not change existing output shape). For older rows
    // that only have `out_path` or `video_path`, `phase_already_done`
    // checks both via the PATH_KEYS list, so the guard works for any run
    // that completed Phase 6 after this code ships.
    emit(app, pid, 6, "running", 0.0, "Verificando render previo…");
    let phase6_cached = phase_already_done(pool, pid, 6).await;
    let mut produced_video: String;
    if let Some(ref cached6) = phase6_cached {
        produced_video = cached6
            .get("video_path")
            .or_else(|| cached6.get("out_path"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| video_out.clone());
        tracing::info!(
            project = %pid, video_path = %produced_video,
            "phase 6: resuming — reusing persisted rendered video"
        );
        emit(app, pid, 6, "done", 100.0, "Render (reanudado — ya completado)");
    } else {

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
        // v0.1.38 — derive intro eyebrow from setting_tag (e.g. "Ancient
        // Egyptian setting (sand-gold, …)" → "ANCIENT EGYPTIAN · HISTORIA
        // REAL"). Mirrors the pilot's logic so the compiled app and the
        // pilot produce the same intro card.
        let intro_eyebrow = {
            let raw = script_resp.get("setting_tag")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let core = raw.splitn(2, |c: char| c == '(' || c == '[')
                .next().unwrap_or("").trim()
                .trim_end_matches(|c: char| ".,;: ".contains(c))
                .to_string();
            let core_lower = core.to_lowercase();
            let suffix_stripped = ["setting", "era", "period", "world", "universe", "atmosphere"]
                .iter()
                .fold(core_lower, |acc, s| {
                    if acc.ends_with(s) { acc[..acc.len() - s.len()].trim().to_string() } else { acc }
                });
            let trimmed = suffix_stripped.trim_end_matches(|c: char| ".,;: ".contains(c)).trim();
            if trimmed.is_empty() {
                "DOCUMENTAL".to_string()
            } else {
                format!("{} · HISTORIA REAL", trimmed.to_uppercase())
            }
        };
        match try_hyperframes_render(
            &client, pid, &req.topic, &beats, &narration_audio,
            &music["audio_path"], &video_out, width, height, &intro_eyebrow,
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
    // `produced_video` was declared above (in the phase 6 resume guard block).
    produced_video = render
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

    // Persist with a top-level "video_path" key so the phase-6 resume guard
    // (and phase_already_done) can verify the artifact on disk in a future
    // run. We merge it into a fresh object to avoid mutating `render`.
    let mut render_persist = render.clone();
    if let Some(obj) = render_persist.as_object_mut() {
        obj.insert("video_path".to_string(), serde_json::json!(produced_video));
    }
    persist_step(pool, pid, 6, "done", &render_persist).await?;
    let mut tag = used_engine.to_string();
    if req.vertical { tag.push_str(" + reframe"); }
    emit(app, pid, 6, "done", 100.0, &format!("Vídeo renderizado ({})", tag));

    } // end phase 6 resume else-branch (new render path)

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
    // v0.1.37: pass the LLM-generated setting_tag to the thumbnail flow
    // so the Z-Image prompt is anchored in the right era / culture /
    // palette (same source of truth used for image markers + music).
    let thumb_setting_tag = script_resp.get("setting_tag")
        .and_then(|v| v.as_str());
    // v0.2.6 — VRAM gate. The thumbnail forces a Z-Image COLD reload
    // (text encoder + Lumina2 + VAE, ~5.5 GB) because the image phase
    // evicted ComfyUI. If something upstream left the card contended
    // (e.g. the old ACE-Step leak — now dropped — or a hung worker),
    // the cold reload would enter Sysmem-fallback thrash and hang ~30
    // min. `ensure_comfyui_vram` reclaims (respawning ComfyUI if its
    // worker is stuck); if we STILL can't free enough we skip Z-Image
    // entirely and extract a video frame — instant, never hangs.
    let thumb_vram = ensure_comfyui_vram(app, &client, THUMB_MIN_VRAM_GB).await;
    let thumb_attempt = if thumb_vram >= THUMB_MIN_VRAM_GB {
        try_thumbnail(
            &client, &req.topic, &meta, thumb_setting_tag,
            thumb_w, thumb_h, &out_dir, &thumb_out,
        ).await
    } else {
        tracing::warn!(
            free_gb = thumb_vram,
            target_gb = THUMB_MIN_VRAM_GB,
            "insufficient VRAM for Z-Image thumbnail cold reload — extracting video frame directly"
        );
        Err(anyhow::anyhow!(
            "VRAM gate: only {:.1} GB free (< {:.1} GB) — skipped Z-Image to avoid Sysmem thrash",
            thumb_vram, THUMB_MIN_VRAM_GB
        ))
    };
    let thumbnail_path: Option<String> = match thumb_attempt {
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
    // Free Z-Image VRAM before Whisper loads.
    unload(&client, "image").await;
    // v0.2.6 — HARD ComfyUI reclaim. The plain best-effort `/free` does
    // NOT work when ComfyUI's worker is stuck on a hung prompt (the exact
    // failure that killed the 2026-05-15 run: a thumbnail Z-Image prompt
    // thrashed for 30 min, ComfyUI never released VRAM, then llama-server
    // (3 GB) + Whisper (3 GB) couldn't fit and the subtitles route hung
    // 15 min until the Rust timeout). `ensure_comfyui_vram` escalates to
    // killing + respawning ComfyUI so a fresh process returns the card to
    // ~full free. We target 4 GB so llama-server + Whisper co-exist.
    ensure_comfyui_vram(app, &client, WHISPER_MIN_VRAM_GB).await;
    // v0.2.2 — wake llama-server before /subtitles. When `target_subs`
    // contains languages different from `primary_lang`, the Python
    // route invokes the LLM for translation. Without an explicit wake
    // the suspend flag (set after script generation) would survive
    // the entire image+depth+music chain and stall here exactly as
    // v0.2.1 did. Done AFTER the ComfyUI reclaim so the freed VRAM is
    // what llama-server loads into (not a still-contended card).
    wake_llm(&client).await;

    // Subtitles: source = audio language (the one Whisper transcribes
    // and that gets burned into the MP4); targets = the multi-select
    // subtitle_languages from the UI (each produces its own SRT+ASS).
    // Backcompat: when audio_language/subtitle_languages are absent we
    // fall back to the legacy `languages[0]` + `languages` shape.
    let primary_lang = req
        .audio_language
        .clone()
        .or_else(|| req.languages.first().cloned())
        .unwrap_or_else(|| "en".to_string());
    let target_subs: Vec<String> = req
        .subtitle_languages
        .clone()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            if req.languages.is_empty() {
                vec![primary_lang.clone()]
            } else {
                req.languages.clone()
            }
        });
    // Always make sure the audio language is present so a track exists
    // for the burned-in caption pass.
    let mut target_subs_normalised = target_subs.clone();
    if !target_subs_normalised.iter().any(|x| x == &primary_lang) {
        target_subs_normalised.insert(0, primary_lang.clone());
    }
    let subs: serde_json::Value = client
        .post(format!("{}/subtitles", PY_SIDECAR))
        // v0.2.6.1 — was 15 min. Even with the Python-side fixes (whisper
        // evicted before translation + batched LLM calls) a long video
        // with many subtitle entries × multiple target languages is
        // legitimately minutes of LLM work. 15 min killed the 2026-05-15
        // run at 16.9 min when the route WOULD have completed. 30 min is
        // the safety net; the real speed fix is whisper-unload + batching.
        .timeout(std::time::Duration::from_secs(30 * 60))
        .json(&serde_json::json!({
            "audio_path": narration_audio,
            "source_language": primary_lang,
            "target_languages": target_subs_normalised,
            "vertical": req.vertical,
            "out_dir": out_dir,
            "style": req.caption_style.clone().unwrap_or_else(|| "xianxia".to_string()),
            // v0.1.46: tell the subtitle generator the narration audio
            // sits at t=6 inside the FINAL composed video (the Node
            // renderer prepends an INTRO_SEC=6.0 intro card + silence).
            // Without this, every cue appears 6 s ahead of the spoken
            // word — the desync the user reported across long-form
            // videos since the intro card was added in v0.1.38.
            "intro_offset_seconds": 6.0,
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

                // v0.4.0 — record the scheduled_uploads row. This was the
                // missing producer: the table + publish-flip cron existed
                // but nothing ever wrote here, so scheduled publishing was
                // dormant and the Planificador screen had no real data.
                // Best-effort: bookkeeping must NEVER fail the pipeline.
                let privacy = req.publish_privacy.clone().unwrap_or_else(|| "private".to_string());
                let now_ts = chrono::Utc::now().timestamp();
                let (status, sched_at) = if privacy == "public" {
                    ("published", now_ts) // already public — history only
                } else if let Some(at) = req.publish_at {
                    ("uploaded", at)      // cron flips it public when due
                } else {
                    ("held", now_ts)      // private, no schedule — cron ignores
                };
                if let Err(e) = crate::db::scheduled::record(
                    pool,
                    crate::db::scheduled::NewScheduled {
                        project_id: pid.to_string(),
                        youtube_video_id: Some(resp.video_id.clone()),
                        scheduled_at: sched_at,
                        privacy_status: privacy,
                        publish_at: req.publish_at,
                        is_short: req.vertical,
                        status: status.to_string(),
                    },
                )
                .await
                {
                    tracing::warn!(error = %e, "scheduled_uploads record failed (non-fatal)");
                }
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

    // ─── Phase 12: SEO metadata pack (100 % local, best-effort) ────
    // Title + variants, per-language description with the hook front-
    // loaded, tags (500-char budget), hashtags, REAL chapters from the
    // script markers, SEO score. Written to seo.json/seo.txt next to the
    // MP4. NEVER blocks the pipeline — the video is already done.
    emit(app, pid, 12, "running", 0.0, "Generando metadatos SEO…");
    wake_llm(&client).await; // project rule: any LLM phase wakes llama first
    // v0.2.16 audit: capture WHY the SEO pack was skipped instead of
    // swallowing the error silently — purely diagnostic, behaviour
    // unchanged (still best-effort, still never blocks the pipeline).
    let (seo_resp, seo_reason): (Option<serde_json::Value>, String) = match client
        .post(format!("{}/seo", PY_SIDECAR))
        .timeout(std::time::Duration::from_secs(6 * 60))
        .json(&serde_json::json!({
            "script": _full_script,
            "project_id": pid,
            "topic": req.topic,
            "languages": req.languages,
            "model": req.llm_model.clone().unwrap_or_else(|| "xianxia-llm".to_string()),
            "out_dir": out_dir,
        }))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => (r.json().await.ok(), String::new()),
        Ok(r) => (None, format!("HTTP {}", r.status())),
        Err(e) => (None, format!("request error: {}", e)),
    };
    match seo_resp {
        Some(pack) if pack.get("title").is_some() => {
            let score = pack["seo_score"].as_i64().unwrap_or(0);
            persist_step(pool, pid, 12, "done", &pack).await?;
            emit(app, pid, 12, "done", 100.0,
                 &format!("Metadatos SEO listos · score {}/100", score));
        }
        _ => {
            let why = if seo_reason.is_empty() {
                "respuesta sin título".to_string()
            } else {
                seo_reason
            };
            tracing::warn!(phase = 12, reason = %why, "SEO pack skipped");
            emit(app, pid, 12, "skipped", 0.0,
                 &format!("Metadatos SEO no disponibles · {}", why));
        }
    }

    // ─── Phase 13: AI-provenance watermark (Meta AudioSeal) ────────
    // Imperceptible neural watermark on the FINAL video's audio so the
    // published artifact is provably AI-generated (YouTube AI disclosure,
    // complements the SEO pack). Best-effort, EXACT mirror of phase 12:
    // the video is already done, this never blocks and never `?`-propagates.
    // The video stream is copied bit-identical sidecar-side (`-c:v copy`).
    emit(app, pid, 13, "running", 0.0, "Marca de agua de procedencia IA…");
    let (wm_resp, wm_reason): (Option<serde_json::Value>, String) = match client
        .post(format!("{}/watermark", PY_SIDECAR))
        .timeout(std::time::Duration::from_secs(7 * 60))
        .json(&serde_json::json!({
            "video_path": final_video,
            "out_dir": out_dir,
        }))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => (r.json().await.ok(), String::new()),
        Ok(r) => (None, format!("HTTP {}", r.status())),
        Err(e) => (None, format!("request error: {}", e)),
    };
    match wm_resp {
        Some(pack) if pack.get("watermarked").and_then(|v| v.as_bool()) == Some(true) => {
            persist_step(pool, pid, 13, "done", &pack).await?;
            emit(app, pid, 13, "done", 100.0, "Marca de agua IA aplicada");
        }
        _ => {
            let why = if !wm_reason.is_empty() {
                wm_reason
            } else if let Some(p) = &wm_resp {
                p.get("reason").and_then(|v| v.as_str()).unwrap_or("no disponible").to_string()
            } else {
                "no disponible".to_string()
            };
            tracing::warn!(phase = 13, reason = %why, "watermark skipped");
            emit(app, pid, 13, "skipped", 0.0,
                 &format!("Marca de agua IA omitida · {}", why));
        }
    }

    Ok(())
}

/// Resume support: if `phase` already completed in a prior run AND every
/// filesystem artifact it recorded still exists on disk, return its persisted
/// output JSON so the caller can skip recomputation.
///
/// The helper checks the top-level string fields whose names are conventional
/// artifact path keys. If any recorded path is missing the phase is NOT
/// considered resumable — the caller must recompute and re-persist.
///
/// NOTE: phases that store compound artifacts (beats array, subs object) are
/// NOT handled here; they use their own inline guard (see Phase 4).
async fn phase_already_done(pool: &DbPool, pid: &str, phase: u8) -> Option<serde_json::Value> {
    // `fetch_optional` returns `Result<Option<T>>` where T is the row type.
    // We annotate the inner T (not wrapped in Option) and `.ok()?` unwraps
    // the Result, then `?` propagates the Option.
    let (status, oj): (String, Option<String>) = sqlx::query_as(
        "SELECT status, output_json FROM pipeline_steps WHERE project_id = ? AND phase = ?",
    )
    .bind(pid)
    .bind(phase as i64)
    .fetch_optional(pool)
    .await
    .ok()??;
    if status != "done" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&oj?).ok()?;

    // For every path-like key present in the output, verify the file exists.
    // If ANY recorded artifact is missing the phase must be re-run.
    const PATH_KEYS: &[&str] = &["audio_path", "video_path", "wav_path", "out_path", "path"];
    for key in PATH_KEYS {
        if let Some(p) = v.get(key).and_then(|p| p.as_str()) {
            if !p.is_empty() && !std::path::Path::new(p).exists() {
                return None;
            }
        }
    }
    Some(v)
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

/// Emitted by the long-form chapter loop so the UI can track individual
/// chapter progress. Best-effort: failures are silently ignored (same
/// policy as `emit`).
///
/// `eta_seconds`: wall-clock estimate of remaining chapter-writing time.
/// Only present after ≥1 fresh chapter completes; None for resumed chapters
/// and for the "writing" pre-emit. The UI stores this as `pipelineStore.eta`
/// with basis "capítulos".
#[derive(Debug, Serialize, Clone)]
struct ChapterUpdate {
    project_id: String,
    index: i64,
    total: i64,
    title: String,
    status: String,
    words: i64,
    /// None → UI keeps its current eta unchanged (e.g. resume or writing pre-emit).
    eta_seconds: Option<i64>,
}

fn emit_chapter(
    app: &AppHandle,
    pid: &str,
    index: i64,
    total: i64,
    title: &str,
    status: &str,
    words: i64,
    eta_seconds: Option<i64>,
) {
    let _ = app.emit(
        "pipeline:chapter",
        ChapterUpdate {
            project_id: pid.to_string(),
            index,
            total,
            title: title.to_string(),
            status: status.to_string(),
            words,
            eta_seconds,
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

    // ─── phase_already_done unit tests ──────────────────────────────────
    // Verify the three contract cases using an in-memory SQLite pool:
    //   1. status=done + artifact path exists on disk         → Some(value)
    //   2. status=done + artifact path does NOT exist on disk → None
    //   3. status=failed                                      → None

    async fn setup_pool_with_project() -> crate::db::DbPool {
        // Use a single-connection private in-memory DB so each test gets a
        // fresh schema without the UNIQUE-migration-version conflict that the
        // shared `file::memory:?cache=shared` pool triggers when multiple
        // tests run in parallel.
        use sqlx::sqlite::SqlitePoolOptions;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory pool");
        sqlx::migrate!("./migrations").run(&pool).await.expect("migrate");
        sqlx::query(
            "INSERT INTO projects (id,title,topic,status,languages,created_at,updated_at) \
             VALUES ('p-resume','T','t','generating','en',0,0)",
        )
        .execute(&pool)
        .await
        .expect("seed project");
        pool
    }

    async fn insert_pipeline_step(
        pool: &crate::db::DbPool,
        phase: u8,
        status: &str,
        output_json: &str,
    ) {
        sqlx::query(
            "INSERT INTO pipeline_steps \
             (id, project_id, phase, name, status, started_at, finished_at, progress, output_json) \
             VALUES (?, 'p-resume', ?, ?, ?, 0, 0, 100, ?) \
             ON CONFLICT(project_id, phase) DO UPDATE \
             SET status=excluded.status, output_json=excluded.output_json",
        )
        .bind(format!("step-{}", phase))
        .bind(phase as i64)
        .bind(format!("phase_{}", phase))
        .bind(status)
        .bind(output_json)
        .execute(pool)
        .await
        .expect("insert pipeline_step");
    }

    #[tokio::test]
    async fn phase_already_done_returns_some_when_artifact_exists() {
        let pool = setup_pool_with_project().await;
        // Create a real temporary file that we'll reference as the artifact.
        let tmp = std::env::temp_dir().join("xianxia_test_tts_resume.wav");
        std::fs::write(&tmp, b"fake wav").expect("write temp file");
        let path = tmp.to_string_lossy().to_string();

        // Use serde_json to ensure the path is properly escaped in the JSON
        // (critical on Windows where backslashes must become \\).
        let oj = serde_json::json!({"audio_path": path, "duration_seconds": 120.0}).to_string();
        insert_pipeline_step(&pool, 3, "done", &oj).await;

        let result = super::phase_already_done(&pool, "p-resume", 3).await;
        assert!(result.is_some(), "expected Some when artifact exists on disk");
        assert_eq!(
            result.unwrap()["audio_path"].as_str(),
            Some(path.as_str()),
        );

        // Cleanup.
        let _ = std::fs::remove_file(&tmp);
    }

    #[tokio::test]
    async fn phase_already_done_returns_none_when_artifact_missing() {
        let pool = setup_pool_with_project().await;
        // Path that definitely does not exist.
        let missing = "/nonexistent/path/xianxia_test_missing.wav";

        insert_pipeline_step(
            &pool, 3, "done",
            &format!(r#"{{"audio_path":"{}","duration_seconds":60.0}}"#, missing),
        ).await;

        let result = super::phase_already_done(&pool, "p-resume", 3).await;
        assert!(result.is_none(), "expected None when artifact does not exist on disk");
    }

    #[tokio::test]
    async fn phase_already_done_returns_none_when_status_not_done() {
        let pool = setup_pool_with_project().await;
        // Even if output_json has no path keys, a non-done status must return None.
        insert_pipeline_step(&pool, 3, "failed", r#"{"error":"oops"}"#).await;

        let result = super::phase_already_done(&pool, "p-resume", 3).await;
        assert!(result.is_none(), "expected None when status is failed (not done)");
    }
}
