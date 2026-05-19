pub mod detect;
pub mod downloader;
pub mod llamacpp;
pub mod llm;
pub mod manifest;
pub mod ollama;
pub mod paths;
pub mod python_env;
pub mod runner;
pub mod verify;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub component: String,
    pub status: ProgressStatus,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub percent: f64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressStatus {
    Pending,
    Downloading,
    Installing,
    Verifying,
    Done,
    Failed,
}
