mod commands;

/// Starts the open-kraken desktop app.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Log to stdout and the app's log folder; the frontend logs through it too.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::initial_repo_path,
            commands::open_repo,
            commands::graph_data,
            commands::commit_files,
            commands::range_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the open-kraken app");
}
