// `dead_code` warnings during ramp-up: many modules expose APIs that are wired
// to UI commands incrementally per milestone. Suppress until M7 ships.
#![allow(dead_code)]

mod commands;
mod db;
mod hardware;
mod installer;
mod pipeline;
mod scheduler;
mod sidecars;
mod youtube;

use std::sync::Arc;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::get_app_version,
            commands::list_projects,
            commands::create_project,
            commands::start_generation,
            commands::list_voices,
            commands::music::music_list_tracks,
            commands::music::music_add_tracks,
            commands::music::music_remove_track,
            commands::music::music_open_folder,
            commands::music::music_get_dir,
            commands::voice_clones::list_voice_clones,
            commands::voice_clones::register_voice_clone,
            commands::voice_clones::delete_voice_clone,
            commands::library::library_list_videos,
            commands::library::library_delete_video,
            commands::library::library_open_video_folder,
            hardware::detect_hardware,
            hardware::safe_llm_alternative,
            installer::runner::run_install,
            installer::runner::get_install_manifest,
            installer::runner::install_optional_component,
            installer::llm::install_llm,
            installer::verify::verify_stack,
            installer::detect::detect_installed_tools,
            sidecars::get_sidecar_state,
            sidecars::get_workspace_root,
            sidecars::get_sidecar_logs,
            youtube::commands::youtube_status,
            youtube::commands::youtube_disconnect,
            youtube::commands::youtube_oauth_start,
            youtube::commands::youtube_upload,
            youtube::commands::youtube_publish_now,
            youtube::commands::youtube_app_status,
            youtube::commands::youtube_set_app_credentials,
            youtube::commands::youtube_clear_app_credentials,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            tracing::info!("Xianxia Studio starting up");

            // Bootstrap music library (creates dir, seeds from workspace bundle).
            commands::music::bootstrap();

            // Bring up the sidecar supervisor IMMEDIATELY (independent of DB) so
            // the topbar dots and other service-level UI work even if the DB
            // migration check fails. Then bring up the DB + scheduler in parallel.
            let handle = app.handle().clone();
            let supervisor = Arc::new(sidecars::Supervisor::new());
            handle.manage(supervisor.clone());
            tauri::async_runtime::spawn({
                let sup = supervisor.clone();
                async move {
                    let _ = sup.start_all().await;
                    sup.run_health_loop().await;
                }
            });

            let handle_db = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::init_pool().await {
                    Ok(pool) => {
                        let pool = Arc::new(pool);
                        handle_db.manage(pool.clone());
                        let pool_clone = pool.clone();
                        tokio::spawn(async move { scheduler::run_loop(pool_clone).await });
                        tracing::info!("database + scheduler up");
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "db init failed — services UI still works, but project CRUD won't");
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
