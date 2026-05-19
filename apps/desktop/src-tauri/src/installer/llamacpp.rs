//! llama.cpp installer — downloads the official ggml-org prebuilt binaries,
//! auto-selects the right flavour for the host (CUDA / Vulkan / CPU / macOS /
//! Linux) and extracts them under `<data_dir>/runtime/llama.cpp/`.
//!
//! Why this exists:
//!   v0.2.0 swaps Ollama for llama.cpp as the primary LLM runtime. Unlike
//!   Ollama (which ships a self-contained installer), llama.cpp publishes
//!   per-flavour zip archives at github.com/ggml-org/llama.cpp/releases. We
//!   pick one, fetch it, extract it, and surface the resulting `llama-server`
//!   binary so the Rust supervisor (T3) can spawn it on :8733.
//!
//! Flavour selection is HARDWARE-DRIVEN:
//!   - NVIDIA + CUDA runtime ≥ 12 → CUDA build (~70 GB/s on a 4090)
//!   - NVIDIA + CUDA runtime < 12 → Vulkan build (universal Nvidia driver)
//!   - AMD / Intel / unknown GPU → Vulkan build
//!   - Apple Silicon                → macOS arm64 build (Metal, native)
//!   - No GPU                       → AVX2/AVX512 CPU build
//!
//! The CUDA flavour additionally needs the cudart DLL set (nvrtc, cublas,
//! cuda runtime) which ggml-org publishes as a SEPARATE archive named
//! `llama-<tag>-bin-win-cudart-cu12.4-x64.zip`. We download both and
//! extract them into the same directory so `llama-server.exe` finds its
//! runtime DLLs next to it without polluting the system %PATH%.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::downloader::download;
use super::paths::{models_dir, paths, runtime_dir, temp_dir};
use crate::hardware;

/// Release tag pinned at v0.2.0 ship time. Update via a single constant when
/// rolling forward — the asset filenames keep their `<tag>` prefix so the
/// download URLs are derived at compile time, not hardcoded per file.
///
/// Rationale for pinning instead of "latest": ggml-org publishes 1-2
/// releases per WEEK, occasionally with breaking flag changes. We pin a
/// known-good tag, bump on a tested cadence, and the parity-check (T7)
/// validates that this constant matches what the supervisor spawns.
pub const LLAMACPP_TAG: &str = "b9128";

const BASE_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LlamaCppFlavor {
    /// Windows + NVIDIA, CUDA 13 toolkit. Used when the driver reports
    /// CUDA Version ≥ 13 (i.e. driver build supports the 13.x runtime).
    /// Falls back to WindowsCuda12 inside `install_llamacpp` if the
    /// selected release doesn't ship a cu13 archive yet.
    WindowsCuda13,
    /// Windows + NVIDIA, CUDA 12.4 runtime — universal NVIDIA build.
    WindowsCuda12,
    /// Windows + Vulkan (NVIDIA without CUDA, AMD, Intel Arc).
    WindowsVulkan,
    /// Windows CPU-only (AVX2 + AVX512 where supported).
    WindowsCpu,
    /// macOS Apple Silicon (Metal).
    MacosArm64,
    /// Linux x86_64 (Vulkan).
    LinuxVulkan,
    /// Linux x86_64 CPU-only.
    LinuxCpu,
}

impl LlamaCppFlavor {
    /// Pretty label shown in the install wizard.
    pub fn label(self) -> &'static str {
        match self {
            Self::WindowsCuda13 => "Windows · NVIDIA CUDA 13",
            Self::WindowsCuda12 => "Windows · NVIDIA CUDA 12",
            Self::WindowsVulkan => "Windows · Vulkan",
            Self::WindowsCpu => "Windows · CPU (AVX2)",
            Self::MacosArm64 => "macOS · Apple Silicon (Metal)",
            Self::LinuxVulkan => "Linux · Vulkan",
            Self::LinuxCpu => "Linux · CPU (AVX2)",
        }
    }

    /// Archive filename inside the release. ggml-org's naming convention
    /// (verified against the b9128 release page):
    ///
    ///   * Main binary: `llama-<tag>-bin-win-cuda-<X.Y>-x64.zip`
    ///     (CUDA 12.4 build → `llama-b9128-bin-win-cuda-12.4-x64.zip`)
    ///   * NOT `cu<X.Y>` (that was my prior wrong guess — the real names
    ///     have no `cu` prefix and the version uses a literal dot).
    ///
    /// CUDA 12.4 is published in every release; CUDA 13.1 began shipping
    /// around build b9000. `install_llamacpp` falls back to cu12 if the
    /// cu13 asset 404s (e.g. on a release that predates cu13 publication).
    fn asset_filename(self, tag: &str) -> String {
        match self {
            Self::WindowsCuda13 => format!("llama-{tag}-bin-win-cuda-13.1-x64.zip"),
            Self::WindowsCuda12 => format!("llama-{tag}-bin-win-cuda-12.4-x64.zip"),
            Self::WindowsVulkan => format!("llama-{tag}-bin-win-vulkan-x64.zip"),
            Self::WindowsCpu => format!("llama-{tag}-bin-win-cpu-x64.zip"),
            Self::MacosArm64 => format!("llama-{tag}-bin-macos-arm64.zip"),
            Self::LinuxVulkan => format!("llama-{tag}-bin-ubuntu-vulkan-x64.zip"),
            Self::LinuxCpu => format!("llama-{tag}-bin-ubuntu-x64.zip"),
        }
    }

    /// Companion archive of CUDA runtime DLLs.
    ///
    /// Naming convention (verified against b9128):
    ///   `cudart-llama-bin-win-cuda-<X.Y>-x64.zip`
    ///
    /// NOTE: The cudart archive is NOT versioned by release tag — the
    /// CUDA runtime DLLs only depend on the CUDA major.minor version, so
    /// ggml-org publishes one cudart per CUDA series and reuses it across
    /// release tags. The function still receives `_tag` so the signature
    /// matches `asset_filename`, but the parameter is intentionally
    /// unused.
    fn cudart_filename(self, _tag: &str) -> Option<String> {
        match self {
            Self::WindowsCuda13 => Some("cudart-llama-bin-win-cuda-13.1-x64.zip".to_string()),
            Self::WindowsCuda12 => Some("cudart-llama-bin-win-cuda-12.4-x64.zip".to_string()),
            _ => None,
        }
    }

    /// What to try if the picked flavor's archive is missing for this tag.
    /// CUDA 13 → CUDA 12.4 (forward-compatible, safe). Other flavors fall
    /// back to themselves (no degradation path; either it's there or we
    /// surface the download error to the caller).
    pub fn fallback(self) -> LlamaCppFlavor {
        match self {
            Self::WindowsCuda13 => Self::WindowsCuda12,
            other => other,
        }
    }

    /// On Windows the server binary is `llama-server.exe`; on POSIX it's
    /// the same name without the suffix. Used to locate the executable
    /// after extraction.
    pub fn server_binary_name(self) -> &'static str {
        match self {
            Self::WindowsCuda13
            | Self::WindowsCuda12
            | Self::WindowsVulkan
            | Self::WindowsCpu => "llama-server.exe",
            _ => "llama-server",
        }
    }
}

/// Decide which flavour to install given the detected hardware + OS.
///
/// Honours the env override `XIANXIA_LLAMACPP_FLAVOR` (one of `cuda` /
/// `vulkan` / `cpu` / `metal`) for cases where the auto-detection picks the
/// wrong path — e.g. a laptop with both an iGPU and an eGPU enclosure where
/// the user wants to force CUDA, or CI machines without a GPU at all.
pub fn pick_flavor() -> LlamaCppFlavor {
    if let Ok(forced) = std::env::var("XIANXIA_LLAMACPP_FLAVOR") {
        let f = forced.to_lowercase();
        if cfg!(target_os = "windows") {
            if f == "cuda13" {
                return LlamaCppFlavor::WindowsCuda13;
            }
            if f == "cuda" || f == "cuda12" {
                return LlamaCppFlavor::WindowsCuda12;
            }
            if f == "vulkan" {
                return LlamaCppFlavor::WindowsVulkan;
            }
            if f == "cpu" {
                return LlamaCppFlavor::WindowsCpu;
            }
        } else if cfg!(target_os = "macos") {
            return LlamaCppFlavor::MacosArm64;
        } else if cfg!(target_os = "linux") {
            if f == "vulkan" {
                return LlamaCppFlavor::LinuxVulkan;
            }
            if f == "cpu" {
                return LlamaCppFlavor::LinuxCpu;
            }
        }
    }

    let hw = hardware::detect_hardware();
    let gpu = hw.gpu;
    let vendor_nvidia = gpu
        .as_ref()
        .map(|g| g.vendor.eq_ignore_ascii_case("NVIDIA"))
        .unwrap_or(false);
    let _vendor_apple = gpu
        .as_ref()
        .map(|g| g.vendor.eq_ignore_ascii_case("Apple"))
        .unwrap_or(false);
    let has_gpu = gpu.is_some();

    #[cfg(target_os = "macos")]
    {
        return LlamaCppFlavor::MacosArm64;
    }

    #[cfg(target_os = "windows")]
    {
        if vendor_nvidia {
            // Probe nvidia-smi for the *driver's* CUDA runtime ceiling.
            // CUDA toolkit installs are forward-compatible: a cu13 build
            // runs fine on a driver advertising "CUDA Version: 13.x";
            // a cu12 build runs on anything ≥ 12.x. Pick the highest
            // matching flavor; `install_llamacpp` automatically falls
            // back to cu12 if the chosen release doesn't ship a cu13
            // archive.
            let major = nvidia_smi_cuda_major().unwrap_or(0);
            if major >= 13 {
                return LlamaCppFlavor::WindowsCuda13;
            }
            if major >= 12 {
                return LlamaCppFlavor::WindowsCuda12;
            }
            return LlamaCppFlavor::WindowsVulkan;
        }
        if has_gpu {
            return LlamaCppFlavor::WindowsVulkan;
        }
        return LlamaCppFlavor::WindowsCpu;
    }

    #[cfg(target_os = "linux")]
    {
        if has_gpu {
            return LlamaCppFlavor::LinuxVulkan;
        }
        return LlamaCppFlavor::LinuxCpu;
    }

    // Fallback for unsupported target_os builds (BSDs, etc.) — CPU is
    // the only safe default since Vulkan loaders are not guaranteed.
    #[allow(unreachable_code)]
    {
        let _ = (vendor_nvidia, has_gpu);
        LlamaCppFlavor::LinuxCpu
    }
}

fn nvidia_smi_cuda_major() -> Option<u32> {
    use crate::process_ext::HideConsole;
    let out = std::process::Command::new("nvidia-smi")
        .hide_console()
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    let line = s.lines().find(|l| l.contains("CUDA Version"))?;
    let after = line.split("CUDA Version:").nth(1)?;
    let trimmed = after.split('|').next()?.trim();
    trimmed.split('.').next()?.parse().ok()
}

/// What the installer leaves on disk once a run finishes.
#[derive(Debug, Clone, Serialize)]
pub struct LlamaCppInstall {
    pub flavor: LlamaCppFlavor,
    pub tag: String,
    pub install_dir: PathBuf,
    pub server_binary: PathBuf,
    /// Version string emitted by `llama-server --version`, e.g. "b9114".
    pub version: Option<String>,
}

/// Inspect the canonical runtime location.
///
/// **Design decision (v0.2.0)**: we DO NOT scan third-party apps (Stacklume,
/// LM Studio, KoboldCPP, etc.) for an existing llama-server binary. The
/// rationale is robustness:
///
///   * Foreign installs can be moved / uninstalled / updated by their
///     parent app without our knowledge → Xianxia silently breaks.
///   * Custom forks (e.g. Stacklume's "version: 8303") may diverge from
///     upstream `ggml-org/llama.cpp` API contracts on subtle edge cases.
///   * Two apps fighting for VRAM on the same GPU is a worse UX than
///     "Xianxia downloaded its own copy".
///
/// Industry standard: LM Studio, Ollama, Jan, Cherry Studio, MSTY all
/// ship their own copy. We do the same — version-controlled via the
/// `LLAMACPP_TAG` constant (plus optional `fetch_latest_release_tag()`
/// at install time to stay current with ggml-org upstream).
pub fn detect_llamacpp() -> Option<LlamaCppInstall> {
    let install_dir = runtime_dir().ok()?.join("llama.cpp");
    if !install_dir.is_dir() {
        return None;
    }
    let flavor = pick_flavor();
    let bin_name = flavor.server_binary_name();
    let server_binary = install_dir.join(bin_name);
    if !server_binary.is_file() {
        return None;
    }
    let version = query_version(&server_binary);
    Some(LlamaCppInstall {
        flavor,
        tag: version.clone().unwrap_or_else(|| LLAMACPP_TAG.to_string()),
        install_dir,
        server_binary,
        version,
    })
}

/// Fetch the latest release tag from `ggml-org/llama.cpp` so we never ship
/// a stale binary. Returns `LLAMACPP_TAG` (the build-time pinned constant)
/// on network failure or rate limit — so the install path is always
/// available even if GitHub is unreachable.
///
/// The result is cached for the lifetime of the process; the supervisor
/// only calls this once per spawn cycle.
pub async fn fetch_latest_release_tag() -> String {
    static CACHED: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();
    if let Some(t) = CACHED.get() {
        return t.clone();
    }
    let tag = match try_fetch_latest_tag().await {
        Some(t) => {
            tracing::info!(latest = %t, pinned = LLAMACPP_TAG, "ggml-org latest release");
            t
        }
        None => {
            tracing::warn!(pinned = LLAMACPP_TAG, "GitHub releases API unreachable, using pinned tag");
            LLAMACPP_TAG.to_string()
        }
    };
    let _ = CACHED.set(tag.clone());
    tag
}

async fn try_fetch_latest_tag() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent(format!("Xianxia-Studio/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let resp = client
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let tag = body.get("tag_name")?.as_str()?.to_string();
    // Defensive: tags follow the `b<number>` shape (e.g. "b9114"). Reject
    // anything else so we never accidentally install a non-release SHA.
    if tag.starts_with('b') && tag.len() >= 4 && tag[1..].chars().all(|c| c.is_ascii_digit()) {
        Some(tag)
    } else {
        None
    }
}

fn query_version(bin: &Path) -> Option<String> {
    use crate::process_ext::HideConsole;
    let out = std::process::Command::new(bin)
        .arg("--version")
        .hide_console()
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    // llama-server reports `version: b9114 (sha…)` on stderr in some
    // builds, stdout in others — combine both for robustness.
    let combined = if text.trim().is_empty() {
        String::from_utf8_lossy(&out.stderr).to_string()
    } else {
        text
    };
    combined
        .lines()
        .find_map(|l| {
            let trimmed = l.trim();
            if trimmed.starts_with("version:") {
                Some(
                    trimmed
                        .trim_start_matches("version:")
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .to_string(),
                )
            } else {
                None
            }
        })
}

/// Driver function. Downloads the binary archive + (if CUDA) the cudart
/// archive, verifies their integrity, extracts them into the install dir
/// and returns the resulting `LlamaCppInstall` descriptor.
///
/// `on_progress(bytes_done, bytes_total)` fires while downloading. The
/// extraction step is fast (LZMA-DEFLATE for these archives, ~5 s on SSD)
/// so we don't surface intermediate progress for it — just `Installing`
/// then `Done` from the wizard's POV.
pub async fn install_llamacpp(
    flavor: LlamaCppFlavor,
    on_progress: Option<super::downloader::ProgressCb>,
) -> Result<LlamaCppInstall> {
    // Resolve the latest release tag from ggml-org at install time so the
    // user never gets a stale binary. Falls back to the pinned constant if
    // the GitHub API is unreachable (offline first launch, rate limit).
    let tag = fetch_latest_release_tag().await;
    let install_dir = runtime_dir()?.join("llama.cpp");
    std::fs::create_dir_all(&install_dir)?;
    let tmp = temp_dir()?;

    // ── Main binary archive ─────────────────────────────────────────
    // Try the picked flavor first. If the chosen release doesn't ship the
    // exact archive (e.g. user picked WindowsCuda13 but the tag was cut
    // before cu13 builds existed), fall back to the next-best flavor.
    let (effective_flavor, main_name, main_zip) = {
        let primary_name = flavor.asset_filename(&tag);
        let primary_url = format!("{BASE_URL}/{tag}/{primary_name}");
        let primary_zip = tmp.join(&primary_name);
        match download(&primary_url, &primary_zip, None, on_progress).await {
            Ok(()) => (flavor, primary_name, primary_zip),
            Err(e) => {
                let fallback = flavor.fallback();
                if fallback == flavor {
                    return Err(e); // no fallback available
                }
                tracing::warn!(
                    primary = ?flavor, fallback = ?fallback, error = %e,
                    "primary flavor archive unavailable, retrying with fallback"
                );
                let fb_name = fallback.asset_filename(&tag);
                let fb_url = format!("{BASE_URL}/{tag}/{fb_name}");
                let fb_zip = tmp.join(&fb_name);
                download(&fb_url, &fb_zip, None, None).await?;
                (fallback, fb_name, fb_zip)
            }
        }
    };
    let _ = main_name; // kept for future logging
    extract_zip_to(&main_zip, &install_dir)
        .with_context(|| format!("extracting {} to {}", main_zip.display(), install_dir.display()))?;

    // ── CUDA runtime DLLs (Windows + NVIDIA only) ───────────────────
    if let Some(cudart_name) = effective_flavor.cudart_filename(&tag) {
        let cudart_url = format!("{BASE_URL}/{tag}/{cudart_name}");
        let cudart_zip = tmp.join(&cudart_name);
        // We don't expose a second progress channel for the cudart bundle
        // — it's ~250 MB next to a 110 MB main archive, so the wizard
        // shows "Installing CUDA runtime…" while it streams.
        download(&cudart_url, &cudart_zip, None, None).await?;
        extract_zip_to(&cudart_zip, &install_dir).with_context(|| {
            format!(
                "extracting cudart {} to {}",
                cudart_zip.display(),
                install_dir.display()
            )
        })?;
    }
    let flavor = effective_flavor;

    let server_binary = install_dir.join(flavor.server_binary_name());
    if !server_binary.is_file() {
        return Err(anyhow!(
            "llama-server not found at {} after extraction",
            server_binary.display()
        ));
    }
    // Mark the binary executable on POSIX (zip may strip the +x bit).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&server_binary)?.permissions();
        perms.set_mode(perms.mode() | 0o755);
        std::fs::set_permissions(&server_binary, perms)?;
    }

    let version = query_version(&server_binary);
    Ok(LlamaCppInstall {
        flavor,
        tag,
        install_dir,
        server_binary,
        version,
    })
}

/// Extract a zip archive into `dest`. Skips directory entries (they're
/// implicit from file paths), preserves relative paths AS-IS — the ggml-org
/// archives don't wrap their contents in a top-level folder, so files end
/// up directly under `install_dir` which is what the supervisor expects.
fn extract_zip_to(archive: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue, // skip unsafe paths
        };
        let out_path = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out_file = std::fs::File::create(&out_path)?;
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf)?;
        std::io::Write::write_all(&mut out_file, &buf)?;
    }
    Ok(())
}

// ─── Active model configuration ─────────────────────────────────────
//
// `LlmModelConfig` is the contract between T4 (model browser writes this
// after extracting GGUF metadata + HF metadata + llmfit recommendations)
// and T3 (supervisor reads this to build the llama-server command line).
//
// Persisted at `<data_dir>/models/active.json`. Whichever component writes
// this file is declaring "this is the active LLM". The supervisor watches
// it on each spawn cycle — if it changes (different GGUF, different
// context size, different chat template), the next supervised respawn
// picks up the change without restarting the app.

/// Knobs the supervisor passes to `llama-server` on spawn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmModelConfig {
    /// Absolute path to the .gguf file. Must exist when the supervisor
    /// reads this config; otherwise the spawn fails fast with a clear
    /// error message rather than llama-server printing "no such file".
    pub gguf_path: String,
    /// `-c` — context window. Capped to the model's training context
    /// (read from GGUF metadata `<arch>.context_length`).
    pub context_size: u32,
    /// `-ngl` — number of layers offloaded to GPU. Use -1 to ask llama.cpp
    /// to offload everything; the CUDA backend will clamp to VRAM at runtime.
    pub gpu_layers: i32,
    /// `-fa` — flash attention. Big win on Ada / Hopper, no-op on older arches.
    pub flash_attention: bool,
    /// `--chat-template` — name of the canonical Jinja template (e.g. "gemma",
    /// "chatml", "llama3"). None ⇒ let llama.cpp pick the GGUF-embedded template.
    /// Setting the wrong template silently mangles every reply, so T4 reads
    /// `tokenizer.chat_template` from the GGUF metadata and stores it here.
    pub chat_template: Option<String>,
    /// `-t` — CPU threads. None ⇒ llama.cpp picks (typically cores - 1).
    pub threads: Option<u32>,
    /// `-b` / `--batch-size` — prompt processing batch size.
    pub batch_size: Option<u32>,
    /// `-ub` / `--ubatch-size` — physical batch (must be ≤ batch_size).
    pub ubatch_size: Option<u32>,
    /// `-np` — parallel sequences (keep at 1 unless we explicitly want
    /// batched inference; >1 multiplies VRAM cost).
    pub parallel: Option<u32>,
    /// Escape hatch for one-off flags llmfit recommends but we haven't
    /// modelled yet (e.g. `--rope-freq-base`, `--mlock`).
    pub extra_args: Vec<String>,
    /// Display / diagnostic metadata — never affects the command line.
    pub model_id: String,
    pub architecture: Option<String>,
    pub quantization: Option<String>,
}

impl LlmModelConfig {
    /// Build the argv suffix `llama-server` should receive given this config.
    /// Keep the ordering stable — the parity-check (T7) snapshots this for
    /// regression detection.
    pub fn to_args(&self) -> Vec<String> {
        let mut a: Vec<String> = vec![
            "--model".into(), self.gguf_path.clone(),
            "--port".into(), "8733".into(),
            "--host".into(), "127.0.0.1".into(),
            "-c".into(), self.context_size.to_string(),
            "-ngl".into(), self.gpu_layers.to_string(),
        ];
        // Flash attention. Starting around llama.cpp b9100 the `-fa` flag
        // STOPPED being a boolean toggle and now REQUIRES a value:
        // `-fa on|off|auto`. Passing a bare `-fa` makes llama-server consume
        // the next argument (e.g. `-t`) as the value and crash with
        // "unknown value for --flash-attn: '-t'". Always pass the explicit
        // value form for forward-compat with the new parser; older builds
        // also accept `-fa on` as equivalent to the old bare `-fa`.
        a.push("-fa".into());
        a.push(if self.flash_attention { "on".into() } else { "off".into() });
        if let Some(tmpl) = &self.chat_template {
            a.push("--chat-template".into());
            a.push(tmpl.clone());
        }
        if let Some(t) = self.threads {
            a.push("-t".into());
            a.push(t.to_string());
        }
        if let Some(b) = self.batch_size {
            a.push("-b".into());
            a.push(b.to_string());
        }
        if let Some(ub) = self.ubatch_size {
            a.push("-ub".into());
            a.push(ub.to_string());
        }
        if let Some(np) = self.parallel {
            a.push("-np".into());
            a.push(np.to_string());
        }
        a.extend(self.extra_args.iter().cloned());
        a
    }
}

/// Where the active-model config lives on disk.
pub fn active_config_path() -> Result<PathBuf> {
    Ok(models_dir()?.join("active.json"))
}

/// Read the active model config. Returns `Ok(None)` when no config has been
/// written yet (e.g. fresh install, T4 hasn't run); the supervisor falls
/// back to `discover_default_config()` in that case so v0.2.0 with a
/// pre-existing Ollama GGUF on disk still spawns something usable.
pub fn read_active_config() -> Result<Option<LlmModelConfig>> {
    let p = active_config_path()?;
    if !p.is_file() {
        return Ok(None);
    }
    let txt = std::fs::read_to_string(&p)
        .with_context(|| format!("reading {}", p.display()))?;
    let cfg: LlmModelConfig = serde_json::from_str(&txt)
        .with_context(|| format!("parsing {}", p.display()))?;
    Ok(Some(cfg))
}

/// Probe for ANY usable GGUF on the user's machine and build a reasonable
/// default config. Search order:
///   1. `<data_dir>/models/*.gguf` (T4's download target).
///   2. `<data_dir>/models/*/*.gguf` (HF snapshot layout, repo per subdir).
///   3. User's HuggingFace cache `~/.cache/huggingface/hub/models--*/snapshots/*/*.gguf`
///      (legacy v0.1.x users have the Ollama-imported GGUF here).
///
/// Returns None if no GGUF was found anywhere — the supervisor will then
/// skip spawning llama-server until T4 (model browser) downloads one.
pub fn discover_default_config() -> Option<LlmModelConfig> {
    let candidates = discover_gguf_paths();
    let gguf = candidates.into_iter().next()?;
    let hw = hardware::detect_hardware();
    let vram_gb = hw.gpu.as_ref().and_then(|g| g.vram_gb).unwrap_or(0.0);

    // Heuristics for the default config — T4 replaces this with metadata-
    // grounded values, but for a usable bootstrap on day-1 we approximate:
    //   - context: 8192 (works for every Gemma 4 / Qwen3 / Llama 3.1 quant)
    //   - gpu_layers: 99 (llama.cpp clamps to whatever fits)
    //   - flash_attention: enabled iff GPU has ≥ 6 GB VRAM (Ampere+ have
    //     better FA perf; older Pascal/Turing rarely speed up enough to
    //     justify the precision drift)
    //   - chat_template: None → use GGUF's embedded template (the
    //     authoritative source until T4 cross-references it)
    let fa = vram_gb >= 6.0;
    let context_size = 8192;
    let model_id = gguf
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    Some(LlmModelConfig {
        gguf_path: gguf.to_string_lossy().to_string(),
        context_size,
        gpu_layers: 99,
        flash_attention: fa,
        chat_template: None,
        threads: None,
        batch_size: None,
        ubatch_size: None,
        parallel: Some(1),
        extra_args: vec![],
        model_id,
        architecture: None,
        quantization: None,
    })
}

/// Return every GGUF the resolver knows about, in priority order. Used both
/// by `discover_default_config` (picks the first) and by the model browser
/// UI (shows the full list).
///
/// IMPORTANT: GGUFs under `runtime/comfyui/models/{diffusion_models,
/// text_encoders, vae, …}` are NOT LLM weights — they're Z-Image / Qwen3
/// text encoder pieces ComfyUI uses for image generation. Passing one as
/// `--model` to llama-server crashes immediately. The `is_llm_gguf` filter
/// blocks them by path inspection.
pub fn discover_gguf_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // Layer 1: top-level models dir + per-repo subdirs (T4 download target).
    if let Ok(md) = models_dir() {
        push_gguf_in(&md, &mut out, /*recursive=*/ true);
    }

    // Layer 2: legacy v0.1.x roots. Two layouts coexist after the v0.1.x
    // installer ran:
    //   a) `<data_dir>/hf-cache/models/llm/<file>.gguf` — wizard's xianxia-llm path
    //   b) `<data_dir>/hf-cache/hub/models--<owner>--<name>/snapshots/<sha>/*.gguf`
    //      — HuggingFace native cache (Whisper, Z-Image, etc. live here too,
    //      but the filter rejects the non-LLM ones).
    if let Ok(p) = paths() {
        for sub in ["hf-cache/models/llm", "hf-cache/hub"] {
            let root = p.data_dir.join(sub);
            if root.is_dir() {
                push_gguf_in(&root, &mut out, /*recursive=*/ true);
            }
        }
    }

    // Filter out anything that isn't an LLM weight (ComfyUI diffusion +
    // text encoder GGUFs would otherwise show up).
    out.retain(|p| is_llm_gguf(p));
    out
}

/// Reject paths that clearly aren't LLM weights — see `discover_gguf_paths`
/// docstring for context.
fn is_llm_gguf(path: &Path) -> bool {
    const BLOCKED: &[&str] = &[
        "comfyui",
        "diffusion_models",
        "text_encoders",
        "vae",
        "clip",
        "clip_vision",
        "controlnet",
        "loras",
        "upscale_models",
    ];
    let lower: Vec<String> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .map(|s| s.to_lowercase())
        .collect();
    !BLOCKED.iter().any(|b| lower.iter().any(|p| p == b))
}

fn push_gguf_in(dir: &Path, out: &mut Vec<PathBuf>, recursive: bool) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_dir() {
                if recursive {
                    push_gguf_in(&p, out, recursive);
                }
                continue;
            }
        }
        if p.extension().map(|e| e == "gguf").unwrap_or(false) {
            out.push(p);
        }
    }
}

// ─── Tauri commands ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct LlamaCppStatus {
    pub installed: bool,
    pub flavor: LlamaCppFlavor,
    pub flavor_label: String,
    pub recommended_tag: String,
    pub current: Option<LlamaCppInstall>,
}

#[tauri::command]
pub async fn llamacpp_status() -> LlamaCppStatus {
    let flavor = pick_flavor();
    let current = detect_llamacpp();
    // Use the dynamic tag so the UI's "Forzar instalación (bXXXX)" button
    // always reflects what would actually be downloaded — not the constant
    // baked into the binary at compile time. Falls back to `LLAMACPP_TAG`
    // if the GitHub API is unreachable.
    let recommended_tag = fetch_latest_release_tag().await;
    LlamaCppStatus {
        installed: current.is_some(),
        flavor,
        flavor_label: flavor.label().to_string(),
        recommended_tag,
        current,
    }
}

/// Install llama.cpp using the auto-picked flavour. Fires
/// `llamacpp-install-progress` events on the given window so the wizard
/// can render a real-time progress bar.
#[tauri::command]
pub async fn llamacpp_install(window: tauri::Window) -> Result<LlamaCppInstall, String> {
    use tauri::Emitter;
    let flavor = pick_flavor();
    let win = window.clone();
    let progress_cb: super::downloader::ProgressCb = Box::new(move |done, total| {
        let pct = if total > 0 {
            (done as f64) / (total as f64) * 100.0
        } else {
            0.0
        };
        let _ = win.emit(
            "llamacpp-install-progress",
            serde_json::json!({
                "bytes_done": done,
                "bytes_total": total,
                "percent": pct,
            }),
        );
    });
    install_llamacpp(flavor, Some(progress_cb))
        .await
        .map_err(|e| format!("{e:#}"))
}
