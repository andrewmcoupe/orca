mod db;
mod events;
mod gates;
mod merge;
mod phases;
mod pipeline;
mod prompts;
mod providers;
mod recent_events;
mod settings;
mod subprocess;
mod workspace_db;
mod worktree;

mod commands;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{Manager, RunEvent};

use crate::phases::InflightRuns;
use crate::providers::ProviderCache;
use crate::subprocess::ChildTracker;

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
    let tracker: Arc<ChildTracker> = Arc::new(ChildTracker::new());
    let tracker_for_shutdown = Arc::clone(&tracker);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let conn = db::init().expect("failed to initialize global database");
            app.manage(GlobalDb(Mutex::new(conn)));
            app.manage(ActiveWorkspaceState(Mutex::new(None)));
            app.manage(tracker.clone());
            app.manage(InflightRuns::new());
            // Detect providers once on startup; the result populates the cache for the
            // session and is refreshed on demand from the Settings panel.
            app.manage(ProviderCache(Mutex::new(providers::detect_providers())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_workspace,
            commands::list_workspaces,
            commands::remove_workspace,
            commands::get_workspace_settings,
            commands::update_workspace_settings,
            commands::set_active_workspace,
            commands::get_active_workspace,
            commands::create_plan,
            commands::revise_plan,
            commands::pause_plan,
            commands::resume_plan,
            commands::cancel_plan,
            commands::archive_plan,
            commands::preview_plan_cascade,
            commands::list_plans,
            commands::get_plan,
            commands::create_task,
            commands::list_tasks,
            commands::get_task,
            commands::list_phase_runs,
            commands::list_phase_run_output,
            commands::start_fake_phase,
            commands::start_real_phase,
            commands::start_task,
            commands::cancel_phase_run,
            commands::rebuild_projections,
            commands::list_providers,
            commands::refresh_providers,
            commands::get_provider_options,
            commands::list_models,
            commands::list_recent_events,
            commands::get_event_by_id,
            commands::mark_task_merged,
            commands::analyze_task_merge,
            commands::execute_task_merge,
            commands::get_latest_merge_attempt_for_task,
            commands::cancel_task,
            commands::pass_back_to_implementer,
            commands::reject_task,
            commands::approve_task_anyway,
            commands::get_latest_auditor_verdict_for_task,
            commands::open_in_editor,
            commands::delete_worktree,
            commands::list_orphan_worktrees,
            commands::get_prompt,
            commands::save_prompt,
            commands::reset_prompt,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            // Kill any still-running child subprocesses on app exit so we don't leave
            // orphan `claude` processes behind.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                tracker_for_shutdown.kill_all();
            }
        });
}
