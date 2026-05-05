//! Stack verification — invoked from Settings or after the install wizard.

use serde::Serialize;
use std::path::Path;

use super::paths;

#[derive(Serialize, Clone)]
pub struct CheckItem {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct StackReport {
    pub all_ok: bool,
    pub checks: Vec<CheckItem>,
}

#[tauri::command]
pub async fn verify_stack() -> Result<StackReport, String> {
    let mut checks: Vec<CheckItem> = Vec::new();

    // Python
    let py = super::python_env::python_exe().ok();
    let py_ok = py.as_ref().map(|p| p.exists()).unwrap_or(false);
    checks.push(CheckItem {
        id: "python".into(),
        label: "Python 3.11 embebido".into(),
        ok: py_ok,
        detail: py.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "no instalado".into()),
    });

    // Node
    let node_ok = paths::node_dir()
        .map(|d| has_subdir_with_node(&d))
        .unwrap_or(false);
    checks.push(CheckItem {
        id: "node".into(),
        label: "Node.js portable".into(),
        ok: node_ok,
        detail: if node_ok { "instalado".into() } else { "no instalado".into() },
    });

    // FFmpeg
    let ffmpeg_ok = paths::ffmpeg_dir().map(|d| d.exists() && has_ffmpeg_binary(&d)).unwrap_or(false);
    checks.push(CheckItem {
        id: "ffmpeg".into(),
        label: "FFmpeg".into(),
        ok: ffmpeg_ok,
        detail: if ffmpeg_ok { "presente".into() } else { "no encontrado".into() },
    });

    // Ollama daemon
    let ollama = super::ollama::is_running().await;
    checks.push(CheckItem {
        id: "ollama".into(),
        label: "Ollama daemon".into(),
        ok: ollama,
        detail: if ollama { "corriendo en :11434".into() } else { "no responde".into() },
    });

    // Sidecar Python
    let py_sidecar = reqwest::Client::new()
        .get("http://127.0.0.1:8731/health")
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    checks.push(CheckItem {
        id: "sidecar-py".into(),
        label: "Sidecar Python (FastAPI)".into(),
        ok: py_sidecar,
        detail: if py_sidecar { "responde en :8731".into() } else { "no responde".into() },
    });

    // Sidecar Node
    let node_sidecar = reqwest::Client::new()
        .get("http://127.0.0.1:8732/health")
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    checks.push(CheckItem {
        id: "sidecar-node".into(),
        label: "Sidecar Node (HyperFrames)".into(),
        ok: node_sidecar,
        detail: if node_sidecar { "responde en :8732".into() } else { "no responde".into() },
    });

    // Models on disk
    let llm_dir = paths::paths().ok().map(|p| p.data_dir.join("models/llm"));
    let llm_ok = llm_dir.as_ref().map(|d| dir_has_files(d, "*.gguf")).unwrap_or(false);
    checks.push(CheckItem {
        id: "model-llm".into(),
        label: "Modelo LLM (Gemma 4 GGUF)".into(),
        ok: llm_ok,
        detail: llm_dir.map(|d| d.display().to_string()).unwrap_or_default(),
    });

    let img_dir = paths::paths().ok().map(|p| p.data_dir.join("models/image"));
    let img_ok = img_dir.as_ref().map(|d| d.exists()).unwrap_or(false);
    checks.push(CheckItem {
        id: "model-image".into(),
        label: "Z-Image-Turbo".into(),
        ok: img_ok,
        detail: img_dir.map(|d| d.display().to_string()).unwrap_or_default(),
    });

    let tts_dir = paths::paths().ok().map(|p| p.data_dir.join("models/tts"));
    let tts_ok = tts_dir.as_ref().map(|d| d.exists()).unwrap_or(false);
    checks.push(CheckItem {
        id: "model-tts".into(),
        label: "Qwen3-TTS".into(),
        ok: tts_ok,
        detail: tts_dir.map(|d| d.display().to_string()).unwrap_or_default(),
    });

    let whisper_dir = paths::paths().ok().map(|p| p.data_dir.join("models/whisper"));
    let whisper_ok = whisper_dir.as_ref().map(|d| d.exists()).unwrap_or(false);
    checks.push(CheckItem {
        id: "model-whisper".into(),
        label: "faster-whisper".into(),
        ok: whisper_ok,
        detail: whisper_dir.map(|d| d.display().to_string()).unwrap_or_default(),
    });

    let all_ok = checks.iter().all(|c| c.ok);
    Ok(StackReport { all_ok, checks })
}

fn has_subdir_with_node(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false; };
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            #[cfg(target_os = "windows")]
            if entry.path().join("node.exe").exists() {
                return true;
            }
            #[cfg(not(target_os = "windows"))]
            if entry.path().join("bin").join("node").exists() {
                return true;
            }
        }
    }
    false
}

fn has_ffmpeg_binary(dir: &Path) -> bool {
    fn walk(d: &Path, depth: usize) -> bool {
        if depth > 4 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(d) else { return false; };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let name = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                if name == "ffmpeg" || name == "ffmpeg.exe" {
                    return true;
                }
            } else if p.is_dir() && walk(&p, depth + 1) {
                return true;
            }
        }
        false
    }
    walk(dir, 0)
}

fn dir_has_files(dir: &Path, pattern: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false; };
    let suffix = pattern.trim_start_matches('*');
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(suffix) {
            return true;
        }
    }
    false
}
