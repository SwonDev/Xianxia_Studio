//! Auto-detection of system-installed tools.
//!
//! Before downloading anything, the wizard checks if the user already has a
//! compatible version of Python, Node.js, FFmpeg, or Ollama on their PATH.
//! Compatible installs are reused — the wizard skips those components.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct DetectedTool {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub compatible: bool,
    pub min_version: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectionReport {
    pub python: DetectedTool,
    pub node: DetectedTool,
    pub ffmpeg: DetectedTool,
    pub ollama: DetectedTool,
    pub git: DetectedTool,
}

#[tauri::command]
pub fn detect_installed_tools() -> DetectionReport {
    DetectionReport {
        python: detect_python(),
        node: detect_node(),
        ffmpeg: detect_ffmpeg(),
        ollama: detect_ollama(),
        git: detect_git(),
    }
}

pub fn detect_python() -> DetectedTool {
    // Try python first (Windows installer convention), then python3 (POSIX).
    let candidates = ["python", "python3", "python3.11", "python3.12"];
    for cand in candidates {
        if let Some((path, version)) = run_version(cand, &["--version"]) {
            let major_minor = parse_python_version(&version);
            // torch / diffusers wheels exist for 3.11 and 3.12. 3.13+ may lack
            // prebuilt wheels for the AI stack — be strict about the upper bound.
            let compatible = major_minor
                .map(|(maj, min)| maj == 3 && (11..=12).contains(&min))
                .unwrap_or(false);
            return DetectedTool {
                id: "python".into(),
                label: "Python 3.11–3.12".into(),
                installed: true,
                version: Some(version),
                path: Some(path),
                compatible,
                min_version: "3.11".into(),
                note: if compatible {
                    Some("Detectado en el sistema, no se descargará embebido".into())
                } else {
                    Some("Versión fuera del rango 3.11–3.12 (wheels de torch/diffusers), se descargará 3.11 embebido".into())
                },
            };
        }
    }
    DetectedTool {
        id: "python".into(),
        label: "Python 3.11+".into(),
        installed: false,
        version: None,
        path: None,
        compatible: false,
        min_version: "3.11".into(),
        note: Some("No detectado, se descargará 3.11 embebido".into()),
    }
}

pub fn detect_node() -> DetectedTool {
    if let Some((path, version)) = run_version("node", &["--version"]) {
        let major = parse_semver_major(&version);
        let compatible = major.map(|m| m >= 22).unwrap_or(false);
        return DetectedTool {
            id: "node".into(),
            label: "Node.js 22+".into(),
            installed: true,
            version: Some(version),
            path: Some(path),
            compatible,
            min_version: "22".into(),
            note: if compatible {
                Some("Detectado en el sistema, no se descargará portable".into())
            } else {
                Some("Versión incompatible, se descargará Node 22 portable".into())
            },
        };
    }
    DetectedTool {
        id: "node".into(),
        label: "Node.js 22+".into(),
        installed: false,
        version: None,
        path: None,
        compatible: false,
        min_version: "22".into(),
        note: Some("No detectado, se descargará Node 22 portable".into()),
    }
}

pub fn detect_ffmpeg() -> DetectedTool {
    if let Some((path, version)) = run_version("ffmpeg", &["-version"]) {
        // ffmpeg -version emits "ffmpeg version 8.0.1-..." on first line
        let v = version.split_whitespace().nth(2).unwrap_or("?").to_string();
        let major = v.split('.').next().and_then(|s| s.parse::<u32>().ok());
        let compatible = major.map(|m| m >= 6).unwrap_or(false); // FFmpeg 6+ is fine
        return DetectedTool {
            id: "ffmpeg".into(),
            label: "FFmpeg 6+".into(),
            installed: true,
            version: Some(v),
            path: Some(path),
            compatible,
            min_version: "6".into(),
            note: if compatible {
                Some("Detectado, se reutiliza".into())
            } else {
                Some("Versión muy antigua, se descargará FFmpeg 8".into())
            },
        };
    }
    DetectedTool {
        id: "ffmpeg".into(),
        label: "FFmpeg 6+".into(),
        installed: false,
        version: None,
        path: None,
        compatible: false,
        min_version: "6".into(),
        note: Some("No detectado, se descargará FFmpeg 8 estático".into()),
    }
}

pub fn detect_ollama() -> DetectedTool {
    if let Some((path, version)) = run_version("ollama", &["--version"]) {
        // "ollama version is 0.23.0"
        let v = version
            .split_whitespace()
            .last()
            .unwrap_or("?")
            .to_string();
        return DetectedTool {
            id: "ollama".into(),
            label: "Ollama".into(),
            installed: true,
            version: Some(v),
            path: Some(path),
            compatible: true, // any recent ollama works
            min_version: "0.1".into(),
            note: Some("Detectado, se reutiliza".into()),
        };
    }
    DetectedTool {
        id: "ollama".into(),
        label: "Ollama".into(),
        installed: false,
        version: None,
        path: None,
        compatible: false,
        min_version: "0.1".into(),
        note: Some("No detectado, se descargará e instalará".into()),
    }
}

fn detect_git() -> DetectedTool {
    if let Some((path, version)) = run_version("git", &["--version"]) {
        let v = version
            .split_whitespace()
            .nth(2)
            .unwrap_or("?")
            .to_string();
        return DetectedTool {
            id: "git".into(),
            label: "Git".into(),
            installed: true,
            version: Some(v),
            path: Some(path),
            compatible: true,
            min_version: "2.0".into(),
            note: Some("Detectado, requerido por pip git+https deps".into()),
        };
    }
    DetectedTool {
        id: "git".into(),
        label: "Git".into(),
        installed: false,
        version: None,
        path: None,
        compatible: false,
        min_version: "2.0".into(),
        note: Some("Falta — necesario para algunas deps de Python (diffusers dev). Instálalo manualmente".into()),
    }
}

fn run_version(bin: &str, args: &[&str]) -> Option<(String, String)> {
    let path = which::which(bin).ok()?;
    let out = Command::new(&path).args(args).output().ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let combined = if stdout.is_empty() { stderr } else { stdout };
    if combined.is_empty() {
        return None;
    }
    let first_line = combined.lines().next().unwrap_or(&combined).to_string();
    Some((path.to_string_lossy().to_string(), first_line))
}

fn parse_python_version(s: &str) -> Option<(u32, u32)> {
    // "Python 3.14.0" → (3, 14)
    let after_space = s.split_whitespace().nth(1)?;
    let mut it = after_space.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

fn parse_semver_major(s: &str) -> Option<u32> {
    // "v22.12.0" → 22
    let stripped = s.trim_start_matches('v');
    stripped.split('.').next()?.parse().ok()
}

/// Resolve the binary to use for a tool, respecting auto-detection:
/// returns the system PATH binary if compatible, otherwise None (caller falls
/// back to the embedded runtime path).
pub fn resolved_python() -> Option<PathBuf> {
    let py = detect_python();
    if py.compatible {
        py.path.map(PathBuf::from)
    } else {
        None
    }
}

pub fn resolved_node() -> Option<PathBuf> {
    let n = detect_node();
    if n.compatible {
        n.path.map(PathBuf::from)
    } else {
        None
    }
}

pub fn resolved_ffmpeg() -> Option<PathBuf> {
    let f = detect_ffmpeg();
    if f.compatible {
        f.path.map(PathBuf::from)
    } else {
        None
    }
}
