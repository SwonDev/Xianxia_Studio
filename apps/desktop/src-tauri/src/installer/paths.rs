use anyhow::Result;
use directories::ProjectDirs;
use std::path::PathBuf;

pub struct AppPaths {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
}

pub fn paths() -> Result<AppPaths> {
    let dirs = ProjectDirs::from("studio", "xianxia", "XianxiaStudio")
        .ok_or_else(|| anyhow::anyhow!("cannot resolve project dirs"))?;
    Ok(AppPaths {
        data_dir: dirs.data_dir().to_path_buf(),
        cache_dir: dirs.cache_dir().to_path_buf(),
    })
}

pub fn runtime_dir() -> Result<PathBuf> {
    let p = paths()?.data_dir.join("runtime");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn models_dir() -> Result<PathBuf> {
    let p = paths()?.data_dir.join("models");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn python_dir() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("python"))
}

pub fn node_dir() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("node"))
}

pub fn ffmpeg_dir() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("ffmpeg"))
}

pub fn temp_dir() -> Result<PathBuf> {
    let p = paths()?.cache_dir.join("downloads");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

#[allow(dead_code)] // used by ollama::write_xianxia_modelfile path
pub fn ollama_modelfiles_dir() -> Result<PathBuf> {
    let p = paths()?.data_dir.join("ollama-modelfiles");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}
