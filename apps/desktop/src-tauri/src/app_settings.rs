//! Lightweight user-preferences persisted as JSON under `<data_dir>/app-settings.json`.
//!
//! Today this holds a single flag — `ollama_enabled` — because v0.2.2
//! turns the previous "Ollama-and-llama.cpp side-by-side" supervisor
//! into a strict "llama.cpp only, Ollama is opt-in" runtime.
//!
//! Why a dedicated tiny JSON instead of tauri-plugin-store: the
//! supervisor reads this flag from a sync Rust context (start_all,
//! health loop, spawn_python env), which is awkward to do through the
//! async store plugin. A two-field JSON read+parse is ~50 µs and
//! avoids a dependency-graph for state we change once a year.
//!
//! The file is written atomically (tmp + rename) so a power cut mid-write
//! cannot leave a corrupted half-byte that would prevent app startup.
//!
//! Schema is stable & forward-compatible: missing keys fall back to the
//! default. Adding a new field is a single line + a default; old files
//! still parse without migration.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

use crate::installer::paths;

/// Persisted shape — keep field names stable; add new fields with serde
/// default attributes so old files still parse.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// When `false` (default), the supervisor never touches Ollama:
    /// no `ensure_running`, no `/api/ps` probes, no Ollama dot in the
    /// topbar, no `XIANXIA_LLM_BACKEND=ollama` env. The Python sidecar
    /// runs on llama.cpp exclusively. Setting this to `true` from the
    /// Settings panel respawns the Python sidecar with the Ollama
    /// backend selected, lets the supervisor probe Ollama's port, and
    /// surfaces its status in the UI.
    #[serde(default)]
    pub ollama_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        // Ollama opt-in (v0.2.2). v0.2.9: ACE-Step is the PRINCIPAL
        // music generator (no toggle — auto-bootstrapped venv), so it
        // has no setting here.
        Self { ollama_enabled: false }
    }
}

fn settings_path() -> Result<PathBuf> {
    Ok(paths::paths()?.data_dir.join("app-settings.json"))
}

/// Read settings from disk; missing file ⇒ default. Never panics; on
/// parse failure we log a warning and return the default so a broken
/// settings file never blocks app boot.
pub fn load() -> AppSettings {
    let path = match settings_path() {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };
    let txt = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return AppSettings::default(),
    };
    match serde_json::from_str::<AppSettings>(&txt) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "app-settings.json malformed; using defaults");
            AppSettings::default()
        }
    }
}

/// Persist atomically (write to `.tmp` + rename). Caller is responsible
/// for surfacing failures to the UI; supervisor code should treat the
/// result as best-effort and fall back to the previous in-memory value.
pub fn save(settings: &AppSettings) -> Result<()> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(settings)?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────────

#[tauri::command]
pub fn app_settings_get() -> Result<AppSettings, String> {
    Ok(load())
}

/// Toggle Ollama on/off. Returns the new settings so the UI can confirm.
///
/// Side-effects (best-effort, never block the response):
///   * When turning Ollama OFF → the supervisor will skip Ollama in the
///     next health-loop tick, the Ollama dot disappears, and the
///     Python sidecar respawns with `XIANXIA_LLM_BACKEND=llamacpp`.
///   * When turning Ollama ON → the supervisor calls
///     `installer::ollama::ensure_running()` and the Python sidecar
///     respawns with `XIANXIA_LLM_BACKEND=ollama`.
///
/// The respawn is what materialises the env change without an app
/// restart — same pattern the Settings model browser uses today.
#[tauri::command]
pub async fn app_settings_set_ollama_enabled(
    enabled: bool,
    sup: tauri::State<'_, Arc<crate::sidecars::Supervisor>>,
) -> Result<AppSettings, String> {
    let mut s = load();
    s.ollama_enabled = enabled;
    save(&s).map_err(|e| e.to_string())?;
    // Apply the change live so the user doesn't have to restart the app.
    if enabled {
        let _ = crate::installer::ollama::ensure_running().await;
    }
    // Respawning Python is what flips the backend the sidecar uses for
    // subsequent generations (the env is read once at process start).
    sup.respawn_python().await;
    Ok(s)
}


