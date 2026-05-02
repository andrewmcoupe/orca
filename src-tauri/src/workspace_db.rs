use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::events::projections::apply_workspace_db_projection_ddl;
use crate::events::schema::apply_events_ddl;

pub const WORKSPACE_DIR: &str = ".orca";
pub const EVENTS_DB_FILE: &str = "events.sqlite";

pub fn workspace_dir(workspace_path: &str) -> PathBuf {
    Path::new(workspace_path).join(WORKSPACE_DIR)
}

pub fn events_db_path(workspace_path: &str) -> PathBuf {
    workspace_dir(workspace_path).join(EVENTS_DB_FILE)
}

/// Open (creating if needed) the per-workspace events database. Applies the events table
/// DDL and projection table DDL.
pub fn open_workspace_db(workspace_path: &str) -> std::io::Result<Connection> {
    let dir = workspace_dir(workspace_path);
    fs::create_dir_all(&dir)?;
    ensure_gitignore_entry(workspace_path)?;
    let path = events_db_path(workspace_path);
    let conn = Connection::open(&path).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    // WAL allows the UI's read connection and any background-writer connections to coexist
    // without blocking each other. busy_timeout backstops the rare case where two writers
    // contend on the WAL lock briefly.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    apply_events_ddl(&conn).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    apply_workspace_db_projection_ddl(&conn)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    crate::recent_events::apply_ddl(&conn)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    Ok(conn)
}

/// Ensure the workspace's `.gitignore` contains `.orca/`. Creates the file if missing.
fn ensure_gitignore_entry(workspace_path: &str) -> std::io::Result<()> {
    let gitignore = Path::new(workspace_path).join(".gitignore");
    let entry_line = format!("{}/", WORKSPACE_DIR);

    let existing = fs::read_to_string(&gitignore).unwrap_or_default();
    let already = existing.lines().any(|l| {
        let t = l.trim();
        t == entry_line || t == WORKSPACE_DIR
    });
    if already {
        return Ok(());
    }

    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&gitignore)?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        f.write_all(b"\n")?;
    }
    f.write_all(entry_line.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}
