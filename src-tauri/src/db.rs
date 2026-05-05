use crate::events::projections::apply_workspace_projection_ddl;
use crate::events::schema::apply_events_ddl;
use directories::ProjectDirs;
use rusqlite::Connection;
use std::path::PathBuf;

pub fn db_path() -> PathBuf {
    let dirs =
        ProjectDirs::from("com", "yourname", "appname").expect("could not resolve app data dir");
    let data_dir = dirs.data_dir();
    std::fs::create_dir_all(data_dir).expect("could not create app data dir");
    data_dir.join("app.sqlite")
}

/// Initialize the global app database.
///
/// Holds: the workspace-aggregate event stream and `workspace_projection` (the read model
/// for workspace registrations). Per-workspace events live in `<repo>/.orca/events.sqlite`.
pub fn init() -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path())?;
    apply_events_ddl(&conn)?;
    apply_workspace_projection_ddl(&conn)?;
    Ok(conn)
}
