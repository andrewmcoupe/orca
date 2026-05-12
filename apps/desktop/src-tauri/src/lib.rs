#![allow(clippy::too_many_arguments)]

mod briefing;
mod briefing_inflight;
mod db;
mod dependencies;
mod diff;
mod diff_service;
mod events;
mod gates;
mod integrations;
mod merge;
mod phases;
mod pipeline;
mod preview_server;
mod prompts;
mod providers;
mod recent_events;
mod settings;
mod subprocess;
mod workspace_db;
mod worktree;
mod worktree_init;
mod write_lock;

mod commands;
mod commands_briefing;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{Manager, RunEvent};

use crate::briefing_inflight::InflightBriefings;
use crate::phases::InflightRuns;
use crate::preview_server::PreviewServerManager;
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

/// macOS launches GUI apps with a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`)
/// that doesn't include Homebrew, nvm, volta, npm globals, or `~/.local/bin` — so
/// `which::which("claude")` fails for users who installed via any of those, even
/// though it works fine in `tauri dev` (which inherits the terminal's PATH).
///
/// Fix: spawn the user's login shell once at startup, ask it for its `$PATH`,
/// and apply that to our process env *before* provider detection runs.
#[cfg(target_os = "macos")]
fn inherit_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // `-l` sources login profile (.zprofile / .bash_profile), `-i` sources
    // interactive rc files (.zshrc / .bashrc). Both together cover the common
    // cases where users put PATH-modifying lines.
    let output = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", "echo -n $PATH"])
        .output();
    let path = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => return,
    };
    if !path.is_empty() {
        std::env::set_var("PATH", path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    inherit_login_shell_path();

    let tracker: Arc<ChildTracker> = Arc::new(ChildTracker::new());
    let tracker_for_shutdown = Arc::clone(&tracker);
    let briefings: Arc<InflightBriefings> = Arc::new(InflightBriefings::new());
    let briefings_for_shutdown = Arc::clone(&briefings);
    let preview_server: Arc<PreviewServerManager> = Arc::new(PreviewServerManager::new());
    let preview_server_for_shutdown = Arc::clone(&preview_server);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            let conn = db::init().expect("failed to initialize global database");
            app.manage(GlobalDb(Mutex::new(conn)));
            app.manage(ActiveWorkspaceState(Mutex::new(None)));
            app.manage(tracker.clone());
            app.manage(briefings.clone());
            app.manage(preview_server.clone());
            app.manage(InflightRuns::new());
            app.manage(diff_service::DiffCache::new());
            // Detect providers once on startup; the result populates the cache for the
            // session and is refreshed on demand from the Settings panel.
            app.manage(ProviderCache(Mutex::new(providers::detect_providers())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_workspace,
            commands::list_workspaces,
            commands::list_workspace_stats,
            commands::get_workspace_home_dispatch,
            commands::remove_workspace,
            commands::get_app_settings,
            commands::update_app_settings,
            commands::get_workspace_settings,
            commands::update_workspace_settings,
            commands::start_preview_server,
            commands::get_preview_server_status,
            commands::stop_preview_server,
            commands::set_active_workspace,
            commands::get_active_workspace,
            commands::clear_active_workspace,
            commands::get_workspace_branch,
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
            commands::get_task_pipeline_snapshot,
            commands::list_phase_runs,
            commands::list_phase_run_output,
            commands::start_real_phase,
            commands::start_task,
            commands::start_task_phase,
            commands::cancel_phase_run,
            commands::retry_worktree_init,
            commands::skip_worktree_init,
            commands::rebuild_projections,
            commands::list_providers,
            commands::refresh_providers,
            commands::get_provider_options,
            commands::list_models,
            commands::list_permission_modes,
            commands::list_recent_events,
            commands::list_task_events,
            commands::get_event_by_id,
            commands::mark_task_merged,
            commands::analyze_task_merge,
            commands::execute_task_merge,
            commands::get_latest_merge_attempt_for_task,
            commands::cancel_task,
            commands::delete_task,
            commands::pass_back_to_implementer,
            commands::reject_task,
            commands::approve_task_anyway,
            commands::get_latest_auditor_verdict_for_task,
            commands::update_task_phase_config,
            commands::reset_task_phase_config,
            commands::update_task_dependencies,
            commands::unqueue_task,
            commands::detect_task_file_overlap,
            commands::open_in_editor,
            commands::delete_worktree,
            commands::list_orphan_worktrees,
            commands::get_prompt,
            commands::save_prompt,
            commands::reset_prompt,
            diff_service::get_task_diff,
            diff_service::refresh_task_diff,
            diff_service::get_unchanged_file_content,
            commands_briefing::start_briefing,
            commands_briefing::generate_briefing_draft,
            commands_briefing::apply_briefing_edits,
            commands_briefing::refine_briefing,
            commands_briefing::accept_briefing,
            commands_briefing::cancel_briefing,
            commands_briefing::cancel_briefing_generation,
            commands_briefing::get_briefing,
            commands_briefing::list_active_briefings,
            commands_briefing::list_briefing_history,
            commands_briefing::validate_briefing_paths,
            integrations::linear::linear_connection_status,
            integrations::linear::linear_save_api_key,
            integrations::linear::linear_disconnect,
            integrations::linear::linear_test_connection,
            integrations::linear::linear_get_issue,
            integrations::linear::linear_search_issues,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            // Kill any still-running child subprocesses on app exit so we don't leave
            // orphan `claude` processes behind. Also signal cancel on every in-flight
            // phase / briefing generation so spawned tasks have a brief window to land
            // terminal events before the process tears down.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(inflight) = _app.try_state::<InflightRuns>() {
                    inflight.cancel_all();
                }
                briefings_for_shutdown.cancel_all();
                preview_server_for_shutdown.stop();
                tracker_for_shutdown.kill_all();
            }
        });
}
