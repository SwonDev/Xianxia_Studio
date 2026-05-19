//! Stack verification — invoked from Settings or after the install wizard.
//!
//! Checks every component in the order it's actually used by the pipeline,
//! tolerating multiple valid install locations:
//!   - Embedded runtime under <data_dir>/runtime/
//!   - System tools on PATH (auto-detected)
//!   - Models in HF cache (<data_dir>/hf-cache) or ComfyUI models dir
//!
//! Returns a single grouped report so the UI can show the user exactly what
//! is detected, what is missing, and where each artefact lives.

use serde::Serialize;
use std::path::{Path, PathBuf};

use super::{detect, paths};
use crate::process_ext::HideConsole;

#[derive(Serialize, Clone)]
pub struct CheckItem {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
    /// Optional category for grouping in the UI.
    pub group: String,
}

#[derive(Serialize, Clone)]
pub struct StackReport {
    pub all_ok: bool,
    pub checks: Vec<CheckItem>,
    /// Quick aggregate flags useful for UI badges.
    pub summary: StackSummary,
}

#[derive(Serialize, Clone, Default)]
pub struct StackSummary {
    pub gpu_available: bool,
    pub video_hw_accelerated: bool,
    pub ollama_running: bool,
    pub xianxia_llm_registered: bool,
    pub sidecar_python_running: bool,
    pub sidecar_node_running: bool,
    pub comfyui_running: bool,
    pub hyperframes_installed: bool,
    pub rembg_installed: bool,
    pub mediapipe_installed: bool,
    pub ultralytics_installed: bool,
    // Kept (always false) for backwards compatibility with older UI builds
    // that still reference it. Removed entirely in v0.2.7.
    pub acestep_installed: bool,
    pub musicgen_installed: bool,
    pub tribe_installed: bool,
    pub models_ready_count: usize,
    pub models_total: usize,
}

#[tauri::command]
pub async fn verify_stack() -> Result<StackReport, String> {
    let mut checks: Vec<CheckItem> = Vec::new();
    let mut s = StackSummary::default();

    // ─── Group: Hardware ─────────────────────────────────────────────
    let hw = crate::hardware::detect_hardware();
    let gpu_present = hw.gpu.is_some();
    s.gpu_available = gpu_present;
    let gpu_detail = match &hw.gpu {
        Some(g) => format!(
            "{} {} · {} cores · {:.1} GB RAM",
            g.vendor,
            g.name,
            hw.cpu_cores,
            hw.total_ram_gb,
        ),
        None => format!("Sin GPU dedicada · {} cores · {:.1} GB RAM", hw.cpu_cores, hw.total_ram_gb),
    };
    checks.push(CheckItem {
        id: "hw-gpu".into(),
        label: "GPU / Hardware".into(),
        ok: gpu_present,
        detail: gpu_detail,
        group: "Hardware".into(),
    });

    // ─── Group: Runtimes (Python / Node / FFmpeg) ────────────────────
    let py_embedded = super::python_env::python_exe().ok().filter(|p| p.exists());
    let py_system = detect::detect_python();
    let py_ok = py_embedded.is_some() || py_system.compatible;
    let py_detail = if let Some(p) = &py_embedded {
        format!("Embebido: {}", p.display())
    } else if py_system.compatible {
        format!("Sistema: {} ({})",
                py_system.path.unwrap_or_default(),
                py_system.version.unwrap_or_default())
    } else if py_system.installed {
        format!("Sistema {} (no compatible — descargar 3.11 embebido)",
                py_system.version.unwrap_or_default())
    } else {
        "no encontrado".into()
    };
    checks.push(CheckItem {
        id: "python".into(),
        label: "Python 3.11–3.12".into(),
        ok: py_ok,
        detail: py_detail,
        group: "Runtimes".into(),
    });

    let node_embedded = paths::node_dir()
        .map(|d| has_subdir_with_node(&d))
        .unwrap_or(false);
    let node_system = detect::detect_node();
    let node_ok = node_embedded || node_system.compatible;
    let node_detail = if node_embedded {
        "Embebido en runtime/node/".into()
    } else if node_system.compatible {
        format!("Sistema: {} ({})",
                node_system.path.unwrap_or_default(),
                node_system.version.unwrap_or_default())
    } else if node_system.installed {
        format!("Sistema {} (versión < 22 — descargar portable)",
                node_system.version.unwrap_or_default())
    } else {
        "no encontrado".into()
    };
    checks.push(CheckItem {
        id: "node".into(),
        label: "Node.js 22+".into(),
        ok: node_ok,
        detail: node_detail,
        group: "Runtimes".into(),
    });

    let ffmpeg_embedded = paths::ffmpeg_dir()
        .map(|d| d.exists() && has_ffmpeg_binary(&d))
        .unwrap_or(false);
    let ffmpeg_system = detect::detect_ffmpeg();
    let ffmpeg_ok = ffmpeg_embedded || ffmpeg_system.compatible || ffmpeg_system.installed;
    let ffmpeg_detail = if ffmpeg_embedded {
        "Embebido en runtime/ffmpeg/".into()
    } else if ffmpeg_system.installed {
        format!("Sistema: {} (v{})",
                ffmpeg_system.path.unwrap_or_default(),
                ffmpeg_system.version.unwrap_or_default())
    } else {
        "no encontrado".into()
    };
    checks.push(CheckItem {
        id: "ffmpeg".into(),
        label: "FFmpeg".into(),
        ok: ffmpeg_ok,
        detail: ffmpeg_detail,
        group: "Runtimes".into(),
    });

    // NVENC / hardware video encoder probe
    let (nvenc_ok, nvenc_detail) = probe_nvenc();
    s.video_hw_accelerated = nvenc_ok;
    checks.push(CheckItem {
        id: "video-encoder".into(),
        label: "Codec de vídeo acelerado".into(),
        ok: nvenc_ok,
        detail: nvenc_detail,
        group: "Runtimes".into(),
    });

    // ─── Group: Services ─────────────────────────────────────────────
    let ollama = super::ollama::is_running().await;
    s.ollama_running = ollama;
    let xianxia_registered = ollama && ollama_has_model("xianxia-llm").await;
    s.xianxia_llm_registered = xianxia_registered;
    checks.push(CheckItem {
        id: "ollama".into(),
        label: "Ollama daemon".into(),
        ok: ollama,
        detail: if ollama { "corriendo en :11434".into() } else { "no responde".into() },
        group: "Servicios".into(),
    });
    checks.push(CheckItem {
        id: "ollama-llm".into(),
        label: "Modelo Ollama xianxia-llm registrado".into(),
        ok: xianxia_registered,
        detail: if xianxia_registered {
            "xianxia-llm:latest disponible".into()
        } else if ollama {
            "Ollama up pero modelo NO registrado — ejecuta el wizard".into()
        } else {
            "Ollama no responde".into()
        },
        group: "Servicios".into(),
    });

    let py_sidecar = http_ok("http://127.0.0.1:8731/health").await;
    s.sidecar_python_running = py_sidecar;
    checks.push(CheckItem {
        id: "sidecar-py".into(),
        label: "Sidecar Python (FastAPI)".into(),
        ok: py_sidecar,
        detail: if py_sidecar { ":8731 ok".into() } else { ":8731 no responde".into() },
        group: "Servicios".into(),
    });

    let node_sidecar = http_ok("http://127.0.0.1:8732/health").await;
    s.sidecar_node_running = node_sidecar;
    checks.push(CheckItem {
        id: "sidecar-node".into(),
        label: "Sidecar Node (HyperFrames)".into(),
        ok: node_sidecar,
        detail: if node_sidecar { ":8732 ok".into() } else { ":8732 no responde (opcional)".into() },
        group: "Servicios".into(),
    });

    let comfyui = http_ok("http://127.0.0.1:8188/system_stats").await;
    s.comfyui_running = comfyui;
    let comfy_installed = paths::paths()
        .ok()
        .map(|p| p.data_dir.join("runtime/comfyui/main.py").exists())
        .unwrap_or(false);
    checks.push(CheckItem {
        id: "comfyui".into(),
        label: "ComfyUI (Z-Image runtime)".into(),
        ok: comfyui || comfy_installed,
        detail: if comfyui {
            ":8188 activo — workflows disponibles".into()
        } else if comfy_installed {
            "instalado en runtime/comfyui (no arrancado)".into()
        } else {
            "no instalado — instala desde el wizard".into()
        },
        group: "Servicios".into(),
    });

    // ─── Group: CLI tools ────────────────────────────────────────────
    let hyperframes_path = check_hyperframes();
    s.hyperframes_installed = hyperframes_path.is_some();
    checks.push(CheckItem {
        id: "hyperframes".into(),
        label: "HyperFrames CLI (render HTML/CSS)".into(),
        ok: s.hyperframes_installed,
        detail: hyperframes_path
            .clone()
            .map(|p| format!("✓ {}", p.display()))
            .unwrap_or_else(|| "no encontrado en sidecar-node/node_modules/.bin".into()),
        group: "Herramientas".into(),
    });

    let (rembg, rembg_detail) = check_python_pkg("rembg").await;
    s.rembg_installed = rembg;
    checks.push(CheckItem {
        id: "rembg".into(),
        label: "rembg + onnxruntime-gpu (parallax 2.5D)".into(),
        ok: rembg,
        detail: rembg_detail,
        group: "Herramientas".into(),
    });

    let (mediapipe, mp_detail) = check_python_pkg("mediapipe").await;
    s.mediapipe_installed = mediapipe;
    checks.push(CheckItem {
        id: "mediapipe".into(),
        label: "MediaPipe (subject tracking)".into(),
        ok: mediapipe,
        detail: mp_detail,
        group: "Herramientas".into(),
    });

    let (ultra, ultra_detail) = check_python_pkg("ultralytics").await;
    s.ultralytics_installed = ultra;
    checks.push(CheckItem {
        id: "ultralytics".into(),
        label: "ultralytics YOLO11 (Shorts subject tracking)".into(),
        ok: ultra,
        detail: ultra_detail,
        group: "Herramientas".into(),
    });

    // ─── Group: Música (MusicGen GPU-only · v0.2.6) ──────────────────
    // ACE-Step v1.5 was removed in v0.2.6: it needs cpu_offload=True on
    // 8 GB VRAM (per its README) which violates the project's GPU-only
    // rule, and on Windows the offload-disabled path hangs indefinitely.
    // MusicGen-medium fp16 fits comfortably under 4 GB.
    s.acestep_installed = false;

    let (audiocraft, ac_detail) = check_python_pkg("audiocraft").await;
    s.musicgen_installed = audiocraft;
    checks.push(CheckItem {
        id: "musicgen".into(),
        label: "MusicGen-medium (audiocraft · GPU-only)".into(),
        ok: audiocraft,
        detail: if audiocraft {
            ac_detail
        } else {
            "no instalado — opcional. Sin él, /music usa la biblioteca local".into()
        },
        group: "Música".into(),
    });

    // ─── Group: Engagement (TRIBE v2 in-silico neuroscience) ─────────
    let (tribe, tribe_detail) = check_python_pkg("tribev2").await;
    s.tribe_installed = tribe;
    checks.push(CheckItem {
        id: "tribe".into(),
        label: "TRIBE v2 (Meta · engagement neurociencia in-silico)".into(),
        ok: tribe,
        detail: if tribe {
            format!("{} · CC-BY-NC-4.0", tribe_detail)
        } else {
            "no instalado — opcional. Predice valles aburridos y los corrige".into()
        },
        group: "Engagement".into(),
    });

    // ─── Group: Models ───────────────────────────────────────────────
    let model_checks = vec![
        check_llm(),
        check_z_image(),
        check_qwen_tts(),
        check_faster_whisper(),
    ];
    s.models_total = model_checks.len();
    s.models_ready_count = model_checks.iter().filter(|c| c.ok).count();
    checks.extend(model_checks);

    let all_ok = checks.iter().all(|c| c.ok);
    Ok(StackReport { all_ok, checks, summary: s })
}

// ─── Helpers ────────────────────────────────────────────────────────

async fn http_ok(url: &str) -> bool {
    reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn check_hyperframes() -> Option<PathBuf> {
    let bin_subpath = std::path::Path::new("node_modules").join(".bin");
    let mut roots: Vec<PathBuf> = Vec::new();
    // 1) Installed runtime (production .exe): <data_dir>/runtime/sidecar-node
    if let Ok(p) = paths::paths() {
        roots.push(p.data_dir.join("runtime").join("sidecar-node"));
    }
    // 2) Dev workspace fallback
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        roots.push(
            std::path::Path::new(manifest)
                .join("..")
                .join("..")
                .join("..")
                .join("apps")
                .join("sidecar-node"),
        );
    }
    for root in roots {
        for ext in &[".cmd", ".CMD", ""] {
            let p = root.join(&bin_subpath).join(format!("hyperframes{}", ext));
            if p.exists() {
                return Some(p);
            }
        }
    }
    // 3) Global npm install on PATH
    if let Ok(out) = std::process::Command::new("hyperframes")
        .arg("--version")
        .hide_console()
        .output()
    {
        if out.status.success() {
            return Some(PathBuf::from("hyperframes (global)"));
        }
    }
    None
}

/// Check whether a Python package is importable in the embedded interpreter.
/// Returns (ok, detail_string).
async fn check_python_pkg(pkg: &str) -> (bool, String) {
    let py = match super::python_env::python_exe() {
        Ok(p) if p.exists() => p,
        _ => return (false, "intérprete embebido no disponible".into()),
    };
    let probe = format!("import {}; print(getattr({}, '__version__', 'ok'))", pkg, pkg);
    let out = match std::process::Command::new(&py)
        .args(["-c", &probe])
        .hide_console()
        .output()
    {
        Ok(o) => o,
        Err(e) => return (false, format!("error ejecutando intérprete: {}", e)),
    };
    if out.status.success() {
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (true, format!("v{}", v))
    } else {
        (false, format!("no instalado en {}", py.display()))
    }
}

async fn ollama_has_model(name: &str) -> bool {
    let resp = reqwest::Client::new()
        .get("http://127.0.0.1:11434/api/tags")
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;
    let Ok(r) = resp else { return false };
    let Ok(json) = r.json::<serde_json::Value>().await else { return false };
    let Some(models) = json.get("models").and_then(|m| m.as_array()) else { return false };
    models.iter().any(|m| {
        m.get("name").and_then(|n| n.as_str())
            .map(|s| s == name || s.starts_with(&format!("{}:", name)))
            .unwrap_or(false)
    })
}

fn probe_nvenc() -> (bool, String) {
    let out = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .hide_console()
        .output();
    let Ok(o) = out else { return (false, "ffmpeg no ejecutable".into()); };
    let stdout = String::from_utf8_lossy(&o.stdout);
    if stdout.contains("h264_nvenc") {
        (true, "h264_nvenc disponible (NVIDIA NVENC)".into())
    } else if stdout.contains("h264_qsv") {
        (true, "h264_qsv disponible (Intel Quick Sync)".into())
    } else if stdout.contains("h264_amf") {
        (true, "h264_amf disponible (AMD)".into())
    } else {
        (false, "Solo libx264 (CPU) — render más lento".into())
    }
}

fn check_llm() -> CheckItem {
    let id = "model-llm".to_string();
    let label = "LLM (Gemma 4 GGUF)".to_string();
    let group = "Modelos".to_string();
    let candidates: Vec<PathBuf> = paths::paths()
        .ok()
        .map(|p| {
            vec![
                p.data_dir.join("hf-cache/models/llm"),
                p.data_dir.join("models/llm"),
            ]
        })
        .unwrap_or_default();
    for d in &candidates {
        if let Some(file) = first_file_with_ext(d, ".gguf") {
            let sz = std::fs::metadata(&file).ok().map(|m| m.len()).unwrap_or(0);
            return CheckItem {
                id, label, group,
                ok: true,
                detail: format!("{} ({:.1} GB)", file.display(), sz as f64 / 1024.0 / 1024.0 / 1024.0),
            };
        }
    }
    CheckItem {
        id, label, group,
        ok: false,
        detail: "no encontrado en hf-cache/models/llm o models/llm".into(),
    }
}

fn check_z_image() -> CheckItem {
    let id = "model-image".to_string();
    let label = "Z-Image-Turbo".to_string();
    let group = "Modelos".to_string();

    if let Ok(p) = paths::paths() {
        // 1. GGUF Q4_K_M (preferred for ≤ 8 GB VRAM, ~4.7 GB)
        let gguf = p.data_dir.join("runtime/comfyui/models/diffusion_models/z-image-turbo-Q4_K_M.gguf");
        if gguf.exists() {
            let sz = std::fs::metadata(&gguf).ok().map(|m| m.len()).unwrap_or(0);
            return CheckItem {
                id, label, group,
                ok: true,
                detail: format!("ComfyUI GGUF Q4_K_M: {} ({:.1} GB) — fits 8 GB VRAM", gguf.display(), sz as f64 / 1024.0 / 1024.0 / 1024.0),
            };
        }
        // 2. ComfyUI single-file BF16 (Comfy-Org/z_image_turbo, ~12 GB)
        let comfy_unet = p.data_dir.join("runtime/comfyui/models/diffusion_models/z_image_turbo_bf16.safetensors");
        if comfy_unet.exists() {
            let sz = std::fs::metadata(&comfy_unet).ok().map(|m| m.len()).unwrap_or(0);
            return CheckItem {
                id, label, group,
                ok: true,
                detail: format!("ComfyUI BF16: {} ({:.1} GB)", comfy_unet.display(), sz as f64 / 1024.0 / 1024.0 / 1024.0),
            };
        }
        // Diffusers HF snapshot (Tongyi-MAI/Z-Image-Turbo)
        let diff = p.data_dir.join("hf-cache/models--Tongyi-MAI--Z-Image-Turbo");
        if diff.join("model_index.json").exists() {
            return CheckItem {
                id, label, group,
                ok: true,
                detail: format!("Diffusers: {}", diff.display()),
            };
        }
        // Fallback legacy path
        let legacy = p.data_dir.join("models/image");
        if legacy.exists() {
            return CheckItem {
                id, label, group,
                ok: true,
                detail: format!("Legacy: {}", legacy.display()),
            };
        }
    }
    CheckItem {
        id, label, group,
        ok: false,
        detail: "no encontrado en ComfyUI ni hf-cache".into(),
    }
}

fn check_qwen_tts() -> CheckItem {
    let id = "model-tts".to_string();
    let label = "Qwen3-TTS".to_string();
    let group = "Modelos".to_string();
    if let Ok(p) = paths::paths() {
        let candidates = [
            p.data_dir.join("hf-cache/models--Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice"),
            p.data_dir.join("hf-cache/models--Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice"),
            p.data_dir.join("models/tts"),
        ];
        for c in &candidates {
            if c.exists() && (c.join("model.safetensors").exists() || dir_has_files(c, ".safetensors") || dir_has_files(c, ".bin")) {
                return CheckItem {
                    id, label, group,
                    ok: true,
                    detail: c.display().to_string(),
                };
            }
        }
    }
    CheckItem {
        id, label, group,
        ok: false,
        detail: "no encontrado en hf-cache".into(),
    }
}

fn check_faster_whisper() -> CheckItem {
    let id = "model-whisper".to_string();
    let label = "faster-whisper".to_string();
    let group = "Modelos".to_string();
    if let Ok(p) = paths::paths() {
        // faster-whisper uses HF hub format with prefix `models--Systran--faster-whisper-...`
        let hf_cache = p.data_dir.join("hf-cache");
        if hf_cache.exists() {
            if let Ok(entries) = std::fs::read_dir(&hf_cache) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.contains("faster-whisper") || name.contains("Systran") {
                        return CheckItem {
                            id, label, group,
                            ok: true,
                            detail: e.path().display().to_string(),
                        };
                    }
                }
            }
            // Or the hub-style hub/ subdir
            let hub = hf_cache.join("hub");
            if let Ok(entries) = std::fs::read_dir(&hub) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.contains("faster-whisper") || name.contains("Systran") {
                        return CheckItem {
                            id, label, group,
                            ok: true,
                            detail: e.path().display().to_string(),
                        };
                    }
                }
            }
        }
        // Legacy
        let legacy = p.data_dir.join("models/whisper");
        if legacy.exists() {
            return CheckItem {
                id, label, group,
                ok: true,
                detail: legacy.display().to_string(),
            };
        }
    }
    CheckItem {
        id, label, group,
        ok: false,
        detail: "no encontrado en hf-cache".into(),
    }
}

fn first_file_with_ext(dir: &Path, ext: &str) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() && p.to_string_lossy().to_lowercase().ends_with(ext) {
            return Some(p);
        }
    }
    None
}

fn dir_has_files(dir: &Path, suffix: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    let suffix = suffix.trim_start_matches('*');
    entries.flatten().any(|e| {
        e.file_name().to_string_lossy().to_string().ends_with(suffix)
    })
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
        if depth > 4 { return false; }
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
