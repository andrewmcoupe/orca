use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::events::projections::apply_workspace_db_projection_ddl;
use crate::events::schema::apply_events_ddl;

pub const ORCA_HOME_DIR: &str = ".orca";
pub const EVENTS_DB_FILE: &str = "events.sqlite";

pub fn orca_home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(ORCA_HOME_DIR)
}

fn workspace_key(workspace_path: &str) -> String {
    let canonical =
        std::fs::canonicalize(workspace_path).unwrap_or_else(|_| PathBuf::from(workspace_path));
    let normalized = canonical.to_string_lossy();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let mut hash = String::with_capacity(16);
    for b in digest.iter().take(8) {
        use std::fmt::Write as _;
        let _ = write!(hash, "{:02x}", b);
    }
    let name = canonical
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("{name}-{hash}")
}

pub fn workspace_dir(workspace_path: &str) -> PathBuf {
    orca_home_dir()
        .join("workspaces")
        .join(workspace_key(workspace_path))
}

pub fn events_db_path(workspace_path: &str) -> PathBuf {
    workspace_dir(workspace_path).join(EVENTS_DB_FILE)
}

/// Open (creating if needed) the per-workspace events database. Applies the events table
/// DDL and projection table DDL.
pub fn open_workspace_db(workspace_path: &str) -> std::io::Result<Connection> {
    let dir = workspace_dir(workspace_path);
    migrate_repo_local_workspace_dir(workspace_path, &dir)?;
    fs::create_dir_all(&dir)?;
    crate::prompts::ensure_prompts_dir(Path::new(workspace_path))?;
    let path = events_db_path(workspace_path);
    let conn = Connection::open(&path).map_err(std::io::Error::other)?;
    // WAL allows the UI's read connection and any background-writer connections to coexist
    // without blocking each other. busy_timeout backstops the rare case where two writers
    // contend on the WAL lock briefly.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(std::io::Error::other)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(std::io::Error::other)?;
    apply_events_ddl(&conn).map_err(std::io::Error::other)?;
    apply_workspace_db_projection_ddl(&conn).map_err(std::io::Error::other)?;
    crate::recent_events::apply_ddl(&conn).map_err(std::io::Error::other)?;
    Ok(conn)
}

fn migrate_repo_local_workspace_dir(workspace_path: &str, new_dir: &Path) -> std::io::Result<()> {
    let old_dir = Path::new(workspace_path).join(ORCA_HOME_DIR);
    if !old_dir.exists() || new_dir.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(new_dir)?;

    for file_name in [
        EVENTS_DB_FILE.to_string(),
        format!("{EVENTS_DB_FILE}-wal"),
        format!("{EVENTS_DB_FILE}-shm"),
    ] {
        let old_events = old_dir.join(&file_name);
        if old_events.exists() {
            if let Err(e) = std::fs::copy(&old_events, new_dir.join(&file_name)) {
                eprintln!(
                    "could not copy repo-local Orca data from {} to {}: {}",
                    old_events.display(),
                    new_dir.display(),
                    e
                );
            }
        }
    }

    let old_prompts = old_dir.join("prompts");
    if old_prompts.is_dir() {
        let new_prompts = new_dir.join("prompts");
        std::fs::create_dir_all(&new_prompts)?;
        for entry in std::fs::read_dir(&old_prompts)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                let _ = std::fs::copy(entry.path(), new_prompts.join(entry.file_name()));
            }
        }
    }

    Ok(())
}
