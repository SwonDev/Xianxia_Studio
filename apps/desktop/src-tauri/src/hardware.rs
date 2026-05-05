use serde::Serialize;
use sysinfo::{Disks, System};

#[derive(Serialize, Clone)]
pub struct HardwareInfo {
    pub os: String,
    pub arch: String,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub cpu_logical_cores: usize,
    pub total_ram_gb: f64,
    pub available_ram_gb: f64,
    pub free_disk_gb: f64,
    pub gpu: Option<GpuInfo>,
    pub recommendation: ModelRecommendation,
}

#[derive(Serialize, Clone)]
pub struct GpuInfo {
    pub vendor: String,
    pub name: String,
    pub vram_gb: Option<f64>,
    pub driver: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ModelRecommendation {
    /// HuggingFace repo for the chosen LLM GGUF (Gemma 4 family).
    pub llm_hf_repo: String,
    /// Specific .gguf filename inside that repo.
    pub llm_gguf_file: String,
    /// Human label for UI (e.g. "Gemma 4 E4B abliterated").
    pub llm_label: String,
    /// Whether this default is the abliterated (filter-free) variant.
    pub llm_abliterated: bool,
    /// Image diffuser variant id.
    pub image: String,
    /// TTS variant id.
    pub tts: String,
    /// Tier name: ultra | high | medium | medium-safe | low | cpu-only
    pub tier: String,
    /// Estimated total download size in GB.
    pub estimated_download_gb: f64,
}

#[tauri::command]
pub fn detect_hardware() -> HardwareInfo {
    let mut sys = System::new_all();
    sys.refresh_all();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let physical_cores = sys.physical_core_count().unwrap_or_else(|| sys.cpus().len());

    let total_ram_gb = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let available_ram_gb = sys.available_memory() as f64 / 1024.0 / 1024.0 / 1024.0;

    let disks = Disks::new_with_refreshed_list();
    let free_disk_gb = disks
        .iter()
        .map(|d| d.available_space())
        .max()
        .unwrap_or(0) as f64
        / 1024.0
        / 1024.0
        / 1024.0;

    let gpu = detect_gpu();
    let recommendation = recommend_models(&gpu, total_ram_gb);

    HardwareInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_brand,
        cpu_cores: physical_cores,
        cpu_logical_cores: sys.cpus().len(),
        total_ram_gb: round2(total_ram_gb),
        available_ram_gb: round2(available_ram_gb),
        free_disk_gb: round2(free_disk_gb),
        gpu,
        recommendation,
    }
}

fn detect_gpu() -> Option<GpuInfo> {
    #[cfg(feature = "nvidia")]
    if let Some(g) = detect_nvidia() {
        return Some(g);
    }

    #[cfg(target_os = "macos")]
    if let Some(g) = detect_apple_silicon() {
        return Some(g);
    }

    #[cfg(target_os = "windows")]
    if let Some(g) = detect_windows_wmic() {
        return Some(g);
    }

    None
}

#[cfg(feature = "nvidia")]
fn detect_nvidia() -> Option<GpuInfo> {
    use nvml_wrapper::Nvml;
    let nvml = Nvml::init().ok()?;
    let device = nvml.device_by_index(0).ok()?;
    let name = device.name().unwrap_or_else(|_| "NVIDIA GPU".to_string());
    let mem = device.memory_info().ok()?;
    let driver = nvml.sys_driver_version().ok();
    Some(GpuInfo {
        vendor: "NVIDIA".to_string(),
        name,
        vram_gb: Some(round2(mem.total as f64 / 1024.0 / 1024.0 / 1024.0)),
        driver,
    })
}

#[cfg(target_os = "macos")]
fn detect_apple_silicon() -> Option<GpuInfo> {
    use std::process::Command;
    let output = Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let total_ram = sysinfo::System::new_all().total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    if stdout.contains("Apple") {
        Some(GpuInfo {
            vendor: "Apple".to_string(),
            name: "Apple Silicon".to_string(),
            vram_gb: Some(round2(total_ram * 0.7)),
            driver: None,
        })
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_wmic() -> Option<GpuInfo> {
    use std::process::Command;
    let output = Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "Name,AdapterRAM", "/format:csv"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines().skip(2) {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() >= 3 {
            let ram_bytes: u64 = parts[1].trim().parse().unwrap_or(0);
            let name = parts[2].trim().to_string();
            if !name.is_empty() && ram_bytes > 0 {
                let vendor = if name.to_lowercase().contains("nvidia") {
                    "NVIDIA"
                } else if name.to_lowercase().contains("amd") || name.to_lowercase().contains("radeon") {
                    "AMD"
                } else if name.to_lowercase().contains("intel") {
                    "Intel"
                } else {
                    "Unknown"
                };
                return Some(GpuInfo {
                    vendor: vendor.to_string(),
                    name,
                    vram_gb: Some(round2(ram_bytes as f64 / 1024.0 / 1024.0 / 1024.0)),
                    driver: None,
                });
            }
        }
    }
    None
}

/// Hardware-tier model selection. Default is the **abliterated** Gemma 4 variant
/// (per project spec — better suited for dark xianxia/wuxia themes that vanilla
/// safety filters reject). The user can switch to the official Google-filtered
/// variant in Settings if preferred.
fn recommend_models(gpu: &Option<GpuInfo>, total_ram_gb: f64) -> ModelRecommendation {
    let vram = gpu.as_ref().and_then(|g| g.vram_gb).unwrap_or(0.0);

    if vram >= 20.0 {
        ModelRecommendation {
            llm_hf_repo: "unsloth/gemma-4-31B-it-GGUF".to_string(),
            llm_gguf_file: "gemma-4-31B-it-Q4_K_M.gguf".to_string(),
            llm_label: "Gemma 4 31B IT".to_string(),
            llm_abliterated: false,
            image: "z-image-turbo-fp16".to_string(),
            tts: "qwen3-tts-1.7b".to_string(),
            tier: "ultra".to_string(),
            estimated_download_gb: 38.0,
        }
    } else if vram >= 10.0 {
        ModelRecommendation {
            llm_hf_repo: "unsloth/gemma-4-26B-A4B-it-GGUF".to_string(),
            llm_gguf_file: "gemma-4-26B-A4B-it-Q4_K_M.gguf".to_string(),
            llm_label: "Gemma 4 26B-A4B IT (MoE)".to_string(),
            llm_abliterated: false,
            image: "z-image-turbo-aio-fp8".to_string(),
            tts: "qwen3-tts-1.7b".to_string(),
            tier: "high".to_string(),
            estimated_download_gb: 28.0,
        }
    } else if vram >= 6.0 {
        ModelRecommendation {
            llm_hf_repo: "mradermacher/supergemma4-e4b-abliterated-i1-GGUF".to_string(),
            llm_gguf_file: "supergemma4-e4b-abliterated.i1-Q4_K_M.gguf".to_string(),
            llm_label: "Gemma 4 E4B abliterated (default)".to_string(),
            llm_abliterated: true,
            image: "z-image-turbo-gguf-q8".to_string(),
            tts: "qwen3-tts-1.7b".to_string(),
            tier: "medium".to_string(),
            estimated_download_gb: 14.5,
        }
    } else if vram >= 3.0 || total_ram_gb >= 16.0 {
        ModelRecommendation {
            llm_hf_repo: "DuoNeural/Gemma-4-E2B-Abliterated-GGUF".to_string(),
            llm_gguf_file: "Gemma-4-E2B-Abliterated-Q4_K_M.gguf".to_string(),
            llm_label: "Gemma 4 E2B abliterated".to_string(),
            llm_abliterated: true,
            image: "z-image-turbo-gguf-q4".to_string(),
            tts: "qwen3-tts-0.6b".to_string(),
            tier: "low".to_string(),
            estimated_download_gb: 7.5,
        }
    } else {
        ModelRecommendation {
            llm_hf_repo: "DuoNeural/Gemma-4-E2B-Abliterated-GGUF".to_string(),
            llm_gguf_file: "Gemma-4-E2B-Abliterated-Q4_K_M.gguf".to_string(),
            llm_label: "Gemma 4 E2B abliterated (CPU)".to_string(),
            llm_abliterated: true,
            image: "z-image-turbo-gguf-q4".to_string(),
            tts: "qwen3-tts-0.6b".to_string(),
            tier: "cpu-only".to_string(),
            estimated_download_gb: 7.5,
        }
    }
}

/// Alternate "safe" variant for the same tier (Gemma 4 official IT, with filters).
/// Used when the user toggles "Modelo con filtros oficiales" in Settings.
#[tauri::command]
pub fn safe_llm_alternative(tier: String) -> ModelRecommendation {
    let mut hw = HardwareInfo {
        os: String::new(),
        arch: String::new(),
        cpu_brand: String::new(),
        cpu_cores: 0,
        cpu_logical_cores: 0,
        total_ram_gb: 0.0,
        available_ram_gb: 0.0,
        free_disk_gb: 0.0,
        gpu: None,
        recommendation: ModelRecommendation {
            llm_hf_repo: String::new(),
            llm_gguf_file: String::new(),
            llm_label: String::new(),
            llm_abliterated: false,
            image: String::new(),
            tts: String::new(),
            tier: tier.clone(),
            estimated_download_gb: 0.0,
        },
    };
    let (repo, file, label) = match tier.as_str() {
        "ultra" => (
            "unsloth/gemma-4-31B-it-GGUF",
            "gemma-4-31B-it-Q4_K_M.gguf",
            "Gemma 4 31B IT (oficial)",
        ),
        "high" => (
            "unsloth/gemma-4-26B-A4B-it-GGUF",
            "gemma-4-26B-A4B-it-Q4_K_M.gguf",
            "Gemma 4 26B-A4B IT (oficial, MoE)",
        ),
        "medium" => (
            "unsloth/gemma-4-E4B-it-GGUF",
            "gemma-4-E4B-it-Q4_K_M.gguf",
            "Gemma 4 E4B IT (oficial, con filtros)",
        ),
        _ => (
            "unsloth/gemma-4-E4B-it-GGUF",
            "gemma-4-E4B-it-Q4_K_M.gguf",
            "Gemma 4 E4B IT (oficial)",
        ),
    };
    hw.recommendation.llm_hf_repo = repo.to_string();
    hw.recommendation.llm_gguf_file = file.to_string();
    hw.recommendation.llm_label = label.to_string();
    hw.recommendation
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
