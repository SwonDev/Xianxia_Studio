mod app_settings;
mod commands;
mod db;
mod diag;
mod hardware;
mod installer;
mod pipeline;
mod process_ext;
mod scheduler;
mod sidecars;
mod tiktok;
mod youtube;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Structured JSONL logging (writes to <cache_dir>/logs/pipeline-rust.jsonl)
    // plus a console layer for dev. Replaces the previous fmt-only setup so
    // pipeline runs leave a machine-readable audit trail that the
    // Python /diag/snapshot endpoint can merge with sidecar logs.
    let _ = diag::init();
    if let Err(e) = diag::rotate_logs() {
        tracing::warn!(error = %e, "log rotation failed at boot");
    }

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
            commands::list_scheduled,
            commands::cancel_scheduled,
            commands::create_project,
            commands::start_generation,
            pipeline::abort_generation,
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
            commands::library::library_reveal_video,
            hardware::detect_hardware,
            hardware::safe_llm_alternative,
            installer::runner::run_install,
            installer::runner::get_install_manifest,
            installer::runner::install_optional_component,
            installer::llm::install_llm,
            installer::verify::verify_stack,
            installer::detect::detect_installed_tools,
            installer::llamacpp::llamacpp_status,
            installer::llamacpp::llamacpp_install,
            sidecars::get_sidecar_state,
            sidecars::get_workspace_root,
            sidecars::get_sidecar_logs,
            app_settings::app_settings_get,
            app_settings::app_settings_set_ollama_enabled,
            youtube::commands::youtube_status,
            youtube::commands::youtube_disconnect,
            youtube::commands::youtube_oauth_start,
            youtube::commands::youtube_upload,
            youtube::commands::youtube_publish_now,
            youtube::commands::youtube_app_status,
            youtube::commands::youtube_set_app_credentials,
            youtube::commands::youtube_clear_app_credentials,
            tiktok::commands::tiktok_status,
            tiktok::commands::tiktok_set_session,
            tiktok::commands::tiktok_clear_session,
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

            // Kill any sidecar processes left running by a previous instance
            // of this .exe (e.g. after a passive auto-update). Without this,
            // the new supervisor sees ports 8731/8732/8188 already bound and
            // can never spawn the new code.
            sidecars::kill_orphan_sidecars();

            // Extract bundled sidecars (sidecar-py + sidecar-node) into the
            // runtime dir on first launch / after upgrade. The supervisor
            // resolves them from there, so the installed .exe doesn't depend
            // on the dev workspace existing.
            if let Err(e) = sidecars::extract_bundled_sidecars(app.handle()) {
                tracing::warn!(error = %e, "sidecar extraction failed — falling back to dev workspace if available");
            }

            // Periodic VRAM snapshot writer — appends to vram.jsonl every 30 s
            // for cross-process VRAM correlation when diagnosing pipeline races.
            tauri::async_runtime::spawn(async move {
                diag::vram_monitor_loop().await;
            });

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

            // The DB pool must be `.manage()`d BEFORE the webview can issue
            // any IPC command, otherwise commands like `start_generation`
            // panic with "state not managed for field `pool`". We block the
            // setup hook for ~1–2 s while the SQLite pool opens and the
            // migrations apply — that's the cost of correctness here.
            match tauri::async_runtime::block_on(db::init_pool()) {
                Ok(pool) => {
                    let pool = Arc::new(pool);
                    app.manage(pool.clone());
                    let pool_clone = pool.clone();
                    tauri::async_runtime::spawn(async move {
                        scheduler::run_loop(pool_clone).await
                    });
                    tracing::info!("database + scheduler up");
                }
                Err(e) => {
                    tracing::error!(error = %e, "db init failed — falling back to in-memory pool so the UI still loads");
                    // Last-ditch fallback: in-memory SQLite + migrations so the
                    // commands that need the pool don't blow up. The user
                    // will see project CRUD reset on next launch but the app
                    // is at least usable instead of stuck on a startup panic.
                    if let Ok(mem_pool) = tauri::async_runtime::block_on(db::init_memory_pool()) {
                        app.manage(Arc::new(mem_pool));
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
