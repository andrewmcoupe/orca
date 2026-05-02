mod db;
mod events;
mod workspace_db;

mod commands;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::Manager;

/// Global app db — workspace events + workspace_projection.
pub struct GlobalDb(pub Mutex<Connection>);

/// Currently active workspace and its open per-workspace events.sqlite connection.
pub struct ActiveWorkspaceState(pub Mutex<Option<ActiveWorkspace>>);

pub struct ActiveWorkspace {
    pub id: String,
    pub path: String,
    pub conn: Connection,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::init().expect("failed to initialize global database");
            app.manage(GlobalDb(Mutex::new(conn)));
            app.manage(ActiveWorkspaceState(Mutex::new(None)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_workspace,
            commands::list_workspaces,
            commands::remove_workspace,
            commands::set_active_workspace,
            commands::get_active_workspace,
            commands::create_task,
            commands::list_tasks,
            commands::get_task,
            commands::list_phase_runs,
            commands::list_phase_run_output,
            commands::start_fake_phase,
            commands::rebuild_projections,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
