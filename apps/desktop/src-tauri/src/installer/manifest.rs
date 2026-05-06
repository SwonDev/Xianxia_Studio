use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Component {
    pub id: String,
    pub label: String,
    pub category: Category,
    pub size_bytes: u64,
    pub url: String,
    pub url_macos: Option<String>,
    pub url_linux: Option<String>,
    pub sha256: Option<String>,
    pub kind: AssetKind,
    pub required: bool,
    /// IDs of components that must be installed before this one.
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Runtime,
    Model,
    Tool,
    Sidecar,
    Postinstall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    /// Python 3.11 standalone tarball — extract into runtime/python.
    PythonEmbed,
    /// Node.js portable archive — extract into runtime/node.
    NodeEmbed,
    /// FFmpeg static build (zip/tar.xz).
    FfmpegBinary,
    /// Ollama installer (.exe / .sh / .zip).
    OllamaInstaller,
    /// Run `pip install -r requirements.txt` (no download — uses local file).
    PipInstall { requirements: String },
    /// Run `npm install` inside the bundled sidecar-node folder.
    NpmInstall { workdir: String },
    /// `npm install -g hyperframes` (or local-equivalent).
    HyperFramesInstall,
    /// Copy sidecar source files (apps/sidecar-py or apps/sidecar-node) to runtime/.
    CopySidecar { source: String, dest: String },
    /// Build the TypeScript sidecar (`npm run build`).
    BuildSidecarNode,
    /// Download a single GGUF/safetensors file from a HuggingFace repo.
    HuggingfaceFile { repo: String, filename: String, target: String },
    /// Download a full HuggingFace snapshot (multi-file model).
    HuggingfaceSnapshot { repo: String, target: String },
    /// Create an Ollama model from a local GGUF via Modelfile.
    OllamaCreate { gguf_relative_path: String, model_name: String, abliterated: bool },
    /// Start the Ollama daemon if not running.
    OllamaStart,
    /// Run a smoke test against all sidecars + Ollama.
    SmokeTest,
    /// `git clone` a repository into a target directory inside runtime/.
    GitClone { repo_url: String, target: String },
    /// Place a HuggingFace single file at a target path (used to drop the
    /// Comfy-Org/z_image_turbo split files into ComfyUI's models/ directories).
    HuggingfaceFileTo { repo: String, filename: String, target_path: String },
}

/// The full install plan, in dependency order. A consumer (the runner) walks
/// this list once; the UI wizard groups components by Category for display.
pub fn full_manifest() -> Vec<Component> {
    let py_url_win = "https://github.com/astral-sh/python-build-standalone/releases/download/20251020/cpython-3.11.13+20251020-x86_64-pc-windows-msvc-install_only.tar.gz";
    let py_url_mac = "https://github.com/astral-sh/python-build-standalone/releases/download/20251020/cpython-3.11.13+20251020-aarch64-apple-darwin-install_only.tar.gz";
    let py_url_lnx = "https://github.com/astral-sh/python-build-standalone/releases/download/20251020/cpython-3.11.13+20251020-x86_64-unknown-linux-gnu-install_only.tar.gz";

    let node_url_win = "https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip";
    let node_url_mac = "https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-arm64.tar.gz";
    let node_url_lnx = "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz";

    let ffmpeg_win = "https://github.com/GyanD/codexffmpeg/releases/download/8.0/ffmpeg-8.0-essentials_build.zip";
    let ffmpeg_mac = "https://evermeet.cx/ffmpeg/getrelease/zip";
    let ffmpeg_lnx = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";

    let ollama_win = "https://ollama.com/download/OllamaSetup.exe";
    let ollama_mac = "https://ollama.com/download/Ollama-darwin.zip";
    let ollama_lnx = "https://ollama.com/install.sh";

    vec![
        // ─── Runtimes ────────────────────────────────────────────────
        Component {
            id: "python-3.11".to_string(),
            label: "Python 3.11 embebido".to_string(),
            category: Category::Runtime,
            size_bytes: 30 * 1024 * 1024,
            url: py_url_win.to_string(),
            url_macos: Some(py_url_mac.to_string()),
            url_linux: Some(py_url_lnx.to_string()),
            sha256: None,
            kind: AssetKind::PythonEmbed,
            required: true,
            depends_on: vec![],
        },
        Component {
            id: "node-22".to_string(),
            label: "Node.js 22 portable".to_string(),
            category: Category::Runtime,
            size_bytes: 35 * 1024 * 1024,
            url: node_url_win.to_string(),
            url_macos: Some(node_url_mac.to_string()),
            url_linux: Some(node_url_lnx.to_string()),
            sha256: None,
            kind: AssetKind::NodeEmbed,
            required: true,
            depends_on: vec![],
        },
        Component {
            id: "ffmpeg-8".to_string(),
            label: "FFmpeg 8".to_string(),
            category: Category::Tool,
            size_bytes: 80 * 1024 * 1024,
            url: ffmpeg_win.to_string(),
            url_macos: Some(ffmpeg_mac.to_string()),
            url_linux: Some(ffmpeg_lnx.to_string()),
            sha256: None,
            kind: AssetKind::FfmpegBinary,
            required: true,
            depends_on: vec![],
        },
        Component {
            id: "ollama".to_string(),
            label: "Ollama".to_string(),
            category: Category::Tool,
            size_bytes: 600 * 1024 * 1024,
            url: ollama_win.to_string(),
            url_macos: Some(ollama_mac.to_string()),
            url_linux: Some(ollama_lnx.to_string()),
            sha256: None,
            kind: AssetKind::OllamaInstaller,
            required: true,
            depends_on: vec![],
        },

        // ─── Sidecar source files ────────────────────────────────────
        Component {
            id: "sidecar-py-files".to_string(),
            label: "Sidecar Python (código)".to_string(),
            category: Category::Sidecar,
            size_bytes: 200 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::CopySidecar {
                source: "sidecar-py".to_string(),
                dest: "sidecar-py".to_string(),
            },
            required: true,
            depends_on: vec![],
        },
        Component {
            id: "sidecar-node-files".to_string(),
            label: "Sidecar Node (código)".to_string(),
            category: Category::Sidecar,
            size_bytes: 80 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::CopySidecar {
                source: "sidecar-node".to_string(),
                dest: "sidecar-node".to_string(),
            },
            required: true,
            depends_on: vec![],
        },

        // ─── Python deps (core, light) ───────────────────────────────
        Component {
            id: "python-deps-core".to_string(),
            label: "Python dependencias base (FastAPI, huggingface)".to_string(),
            category: Category::Postinstall,
            size_bytes: 150 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::PipInstall {
                requirements: "sidecar-py/requirements.txt".to_string(),
            },
            required: true,
            depends_on: vec!["python-3.11".to_string(), "sidecar-py-files".to_string()],
        },

        // ─── Python deps (heavy AI: torch, diffusers, qwen-tts, whisper) ─
        Component {
            id: "python-deps-ai".to_string(),
            label: "Python AI (torch+CUDA, diffusers, qwen-tts, faster-whisper)".to_string(),
            category: Category::Postinstall,
            size_bytes: 8500 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::PipInstall {
                requirements: "sidecar-py/requirements-ai.txt".to_string(),
            },
            required: true,
            depends_on: vec!["python-deps-core".to_string()],
        },

        // ─── Python deps (parallax 2.5D + smart reframe) ────────────
        Component {
            id: "python-deps-vision".to_string(),
            label: "rembg + onnxruntime-gpu + MediaPipe + opencv (parallax 2.5D, subject tracking)".to_string(),
            category: Category::Postinstall,
            size_bytes: 700 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::PipInstall {
                requirements: "sidecar-py/requirements-vision.txt".to_string(),
            },
            required: true,
            depends_on: vec!["python-deps-core".to_string()],
        },

        // ─── Python deps (música — ACE-Step v1.5 preferred + MusicGen fallback) ──
        // Optional: app falls back to local music library if neither backend
        // is installed. ~5-8 GB total. ACE-Step downloads its checkpoint to
        // ~/.cache/ace-step on first inference (≈3.5 GB Apache 2.0 weights).
        Component {
            id: "python-deps-music".to_string(),
            label: "ACE-Step v1.5 + MusicGen-medium (música cinematográfica generada)".to_string(),
            category: Category::Postinstall,
            size_bytes: 6 * 1024 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::PipInstall {
                requirements: "sidecar-py/requirements-music.txt".to_string(),
            },
            required: false,
            depends_on: vec!["python-deps-core".to_string()],
        },

        // ─── Python deps (engagement — Meta TRIBE v2 in-silico neuroscience) ──
        // Optional. CC-BY-NC-4.0 (non-commercial). ~12 GB pesos descargados
        // a ~/.cache/tribev2/ en el primer inference (LLaMA-3.2-3B + V-JEPA2 +
        // Wav2Vec-BERT). El runtime "light" salta el text encoder para 8 GB VRAM.
        // Predice respuestas fMRI → mapeamos a redes funcionales (Yeo 7-net) →
        // engagement score per second + boring-spot detection + auto-fix.
        Component {
            id: "python-deps-engagement".to_string(),
            label: "TRIBE v2 (Meta · análisis de engagement con neurociencia in-silico)".to_string(),
            category: Category::Postinstall,
            size_bytes: 12 * 1024 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::PipInstall {
                requirements: "sidecar-py/requirements-engagement.txt".to_string(),
            },
            required: false,
            depends_on: vec!["python-deps-core".to_string()],
        },

        // ─── Node deps for the HyperFrames sidecar ──────────────────
        Component {
            id: "node-deps".to_string(),
            label: "Node deps del sidecar".to_string(),
            category: Category::Postinstall,
            size_bytes: 150 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::NpmInstall {
                workdir: "sidecar-node".to_string(),
            },
            required: true,
            depends_on: vec!["node-22".to_string(), "sidecar-node-files".to_string()],
        },
        Component {
            id: "sidecar-node-build".to_string(),
            label: "Compilar sidecar Node".to_string(),
            category: Category::Postinstall,
            size_bytes: 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::BuildSidecarNode,
            required: true,
            depends_on: vec!["node-deps".to_string()],
        },
        Component {
            id: "hyperframes".to_string(),
            label: "HyperFrames CLI".to_string(),
            category: Category::Postinstall,
            size_bytes: 60 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::HyperFramesInstall,
            required: true,
            depends_on: vec!["node-22".to_string()],
        },

        // ─── ComfyUI (optional UI for image generation) ──────────────
        Component {
            id: "comfyui-clone".to_string(),
            label: "ComfyUI (clone)".to_string(),
            category: Category::Tool,
            size_bytes: 250 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::GitClone {
                repo_url: "https://github.com/comfyanonymous/ComfyUI.git".to_string(),
                target: "comfyui".to_string(),
            },
            required: false,
            depends_on: vec!["python-3.11".to_string()],
        },
        Component {
            id: "comfyui-deps".to_string(),
            label: "ComfyUI deps".to_string(),
            category: Category::Postinstall,
            size_bytes: 200 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::PipInstall {
                requirements: "../runtime/comfyui/requirements.txt".to_string(),
            },
            required: false,
            depends_on: vec!["comfyui-clone".to_string(), "python-deps-ai".to_string()],
        },
        Component {
            id: "comfyui-gguf-node".to_string(),
            label: "ComfyUI-GGUF custom node".to_string(),
            category: Category::Tool,
            size_bytes: 5 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::GitClone {
                repo_url: "https://github.com/city96/ComfyUI-GGUF.git".to_string(),
                target: "comfyui/custom_nodes/ComfyUI-GGUF".to_string(),
            },
            required: false,
            depends_on: vec!["comfyui-clone".to_string()],
        },
        // rgthree quality-of-life nodes (Context, Lora Stack, Bookmark, Fast Muter,
        // progress bar). Used by the ComfyUI workflows when present; harmless if
        // absent. Useful for dev. Tiny (<2 MB).
        Component {
            id: "comfyui-rgthree-node".to_string(),
            label: "rgthree-comfy QoL nodes".to_string(),
            category: Category::Tool,
            size_bytes: 2 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::GitClone {
                repo_url: "https://github.com/rgthree/rgthree-comfy.git".to_string(),
                target: "comfyui/custom_nodes/rgthree-comfy".to_string(),
            },
            required: false,
            depends_on: vec!["comfyui-clone".to_string()],
        },

        // ─── Z-Image-Turbo Q4_K_M GGUF (~4.7 GB) — best fit for ≤ 8 GB VRAM ──
        // The runtime auto-selects this variant when present (see comfyui_client
        // py xianxia_workflow). For 12+ GB cards, the BF16 variant below gives
        // sharper output but isn't required.
        Component {
            id: "z-image-comfy-gguf".to_string(),
            label: "Z-Image-Turbo Q4_K_M GGUF (8 GB VRAM, ComfyUI-GGUF)".to_string(),
            category: Category::Model,
            size_bytes: (4_700u64) * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::HuggingfaceFileTo {
                repo: "unsloth/Z-Image-Turbo-GGUF".to_string(),
                filename: "z-image-turbo-Q4_K_M.gguf".to_string(),
                target_path: "comfyui/models/diffusion_models/z-image-turbo-Q4_K_M.gguf".to_string(),
            },
            required: true,
            depends_on: vec!["comfyui-clone".to_string(), "comfyui-gguf-node".to_string(), "python-deps-core".to_string()],
        },

        // ─── Z-Image-Turbo single-files for ComfyUI native usage ─────
        // BF16 (~11.7 GB) — optional, for 12+ GB VRAM cards. The pipeline runs
        // fine on the GGUF variant alone for 8 GB cards.
        Component {
            id: "z-image-comfy-unet".to_string(),
            label: "Z-Image-Turbo BF16 (ComfyUI, opcional 12+ GB VRAM)".to_string(),
            category: Category::Model,
            size_bytes: (11_700u64) * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::HuggingfaceFileTo {
                repo: "Comfy-Org/z_image_turbo".to_string(),
                filename: "split_files/diffusion_models/z_image_turbo_bf16.safetensors".to_string(),
                target_path: "comfyui/models/diffusion_models/z_image_turbo_bf16.safetensors".to_string(),
            },
            required: false,
            depends_on: vec!["comfyui-clone".to_string(), "python-deps-core".to_string()],
        },
        Component {
            id: "z-image-comfy-clip".to_string(),
            label: "Qwen3-4B FP8 text encoder (ComfyUI)".to_string(),
            category: Category::Model,
            size_bytes: (5_400u64) * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::HuggingfaceFileTo {
                repo: "Comfy-Org/z_image_turbo".to_string(),
                filename: "split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors".to_string(),
                target_path: "comfyui/models/text_encoders/qwen_3_4b_fp8_mixed.safetensors".to_string(),
            },
            required: false,
            depends_on: vec!["comfyui-clone".to_string(), "python-deps-core".to_string()],
        },
        Component {
            id: "z-image-comfy-vae".to_string(),
            label: "Z-Image VAE (ComfyUI)".to_string(),
            category: Category::Model,
            size_bytes: 320 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::HuggingfaceFileTo {
                repo: "Comfy-Org/z_image_turbo".to_string(),
                filename: "split_files/vae/ae.safetensors".to_string(),
                target_path: "comfyui/models/vae/ae.safetensors".to_string(),
            },
            required: false,
            depends_on: vec!["comfyui-clone".to_string(), "python-deps-core".to_string()],
        },

        // ─── AI models (heavy, downloaded via huggingface_hub) ────────
        Component {
            id: "model-z-image".to_string(),
            label: "Z-Image-Turbo (imagen)".to_string(),
            category: Category::Model,
            size_bytes: 9 * 1024 * 1024 * 1024, // ~9 GB FP16
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::HuggingfaceSnapshot {
                repo: "Tongyi-MAI/Z-Image-Turbo".to_string(),
                target: "models/image".to_string(),
            },
            required: true,
            depends_on: vec!["python-deps-core".to_string()],
        },
        Component {
            id: "model-qwen-tts".to_string(),
            label: "Qwen3-TTS 1.7B (voz)".to_string(),
            category: Category::Model,
            size_bytes: 4 * 1024 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::HuggingfaceSnapshot {
                repo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice".to_string(),
                target: "models/tts".to_string(),
            },
            required: true,
            depends_on: vec!["python-deps-core".to_string()],
        },
        Component {
            id: "model-whisper".to_string(),
            label: "faster-whisper large-v3 (subtítulos)".to_string(),
            category: Category::Model,
            size_bytes: 3 * 1024 * 1024 * 1024,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::HuggingfaceSnapshot {
                repo: "Systran/faster-whisper-large-v3".to_string(),
                target: "models/whisper".to_string(),
            },
            required: true,
            depends_on: vec!["python-deps-core".to_string()],
        },
        // The LLM (Gemma 4 GGUF) is added dynamically per hardware tier
        // via `with_llm_for_tier(...)` below.

        // ─── Final orchestration ─────────────────────────────────────
        Component {
            id: "ollama-start".to_string(),
            label: "Iniciar Ollama".to_string(),
            category: Category::Postinstall,
            size_bytes: 0,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::OllamaStart,
            required: true,
            depends_on: vec!["ollama".to_string()],
        },
        Component {
            id: "smoke-test".to_string(),
            label: "Verificación final".to_string(),
            category: Category::Postinstall,
            size_bytes: 0,
            url: String::new(),
            url_macos: None,
            url_linux: None,
            sha256: None,
            kind: AssetKind::SmokeTest,
            required: true,
            depends_on: vec![
                "python-deps-ai".to_string(),
                "sidecar-node-build".to_string(),
                "hyperframes".to_string(),
                "model-z-image".to_string(),
                "model-qwen-tts".to_string(),
                "model-whisper".to_string(),
                "ollama-start".to_string(),
            ],
        },
    ]
}

/// Adds the GGUF download + Modelfile creation steps for the chosen hardware
/// tier, inserted right before the smoke test. The Ollama model registered is
/// always named `xianxia-llm` (or `xianxia-llm-safe` if the user opted into
/// the official Gemma 4 IT variant with safety filters); the pipeline always
/// invokes `xianxia-llm` so swapping the underlying GGUF doesn't require code
/// changes — just re-run the wizard.
pub fn with_llm_for_tier(
    base: Vec<Component>,
    hf_repo: &str,
    gguf_file: &str,
    label: &str,
    abliterated: bool,
    size_bytes: u64,
) -> Vec<Component> {
    let mut out = base.clone();
    let llm_id = "llm-gguf".to_string();
    let model_name = if abliterated { "xianxia-llm" } else { "xianxia-llm-safe" };

    let download = Component {
        id: llm_id.clone(),
        label: format!("LLM: {}", label),
        category: Category::Model,
        size_bytes,
        url: String::new(),
        url_macos: None,
        url_linux: None,
        sha256: None,
        kind: AssetKind::HuggingfaceFile {
            repo: hf_repo.to_string(),
            filename: gguf_file.to_string(),
            target: "models/llm".to_string(),
        },
        required: true,
        depends_on: vec!["python-deps-core".to_string()],
    };

    let create = Component {
        id: "ollama-create-llm".to_string(),
        label: format!("Registrar {} en Ollama", model_name),
        category: Category::Postinstall,
        size_bytes: 0,
        url: String::new(),
        url_macos: None,
        url_linux: None,
        sha256: None,
        kind: AssetKind::OllamaCreate {
            gguf_relative_path: format!("models/llm/{}", gguf_file),
            model_name: model_name.to_string(),
            abliterated,
        },
        required: true,
        depends_on: vec![llm_id.clone(), "ollama-start".to_string()],
    };

    // Insert before the smoke test (which depends on everything)
    let smoke_idx = out.iter().position(|c| c.id == "smoke-test").unwrap_or(out.len());
    out.insert(smoke_idx, download);
    out.insert(smoke_idx + 1, create);
    // smoke-test depends on these too
    if let Some(smoke) = out.iter_mut().find(|c| c.id == "smoke-test") {
        smoke.depends_on.push(llm_id);
        smoke.depends_on.push("ollama-create-llm".to_string());
    }
    out
}
