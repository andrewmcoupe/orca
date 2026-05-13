use crate::events::projections::apply_workspace_projection_ddl;
use crate::events::schema::apply_events_ddl;
use directories::ProjectDirs;
use rusqlite::Connection;
use std::path::PathBuf;

pub fn db_path() -> PathBuf {
    let dirs =
        ProjectDirs::from("com", "andycoupe", "orca").expect("could not resolve app data dir");
    let data_dir = dirs.data_dir();
    std::fs::create_dir_all(data_dir).expect("could not create app data dir");
    data_dir.join("app.sqlite")
}

/// One-time migration from the placeholder data directory used during early
/// development (`com.yourname.appname`) to the bundle-aligned one. Runs at
/// startup; a no-op if the new file already exists or the old one doesn't.
fn migrate_legacy_data_dir(target: &PathBuf) {
    if target.exists() {
        return;
    }
    let Some(legacy_dirs) = ProjectDirs::from("com", "yourname", "appname") else {
        return;
    };
    let legacy_db = legacy_dirs.data_dir().join("app.sqlite");
    if !legacy_db.exists() {
        return;
    }
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::rename(&legacy_db, target) {
        eprintln!(
            "could not migrate legacy app db from {} to {}: {}",
            legacy_db.display(),
            target.display(),
            e
        );
    }
}

/// Initialize the global app database.
///
/// Holds: the workspace-aggregate event stream and `workspace_projection` (the read model
/// for workspace registrations). Per-workspace events live under
/// `~/.orca/workspaces/<workspace-key>/events.sqlite`.
pub fn init() -> rusqlite::Result<Connection> {
    let path = db_path();
    migrate_legacy_data_dir(&path);
    let conn = Connection::open(&path)?;
    apply_events_ddl(&conn)?;
    apply_workspace_projection_ddl(&conn)?;
    Ok(conn)
}
