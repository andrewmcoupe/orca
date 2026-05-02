use rusqlite::Connection;
use std::path::PathBuf;
use directories::ProjectDirs;

pub fn db_path() -> PathBuf {
    let dirs = ProjectDirs::from("com", "yourname", "appname")
        .expect("could not resolve app data dir");
    let data_dir = dirs.data_dir();
    std::fs::create_dir_all(data_dir).expect("could not create app data dir");
    data_dir.join("app.sqlite")
}

pub fn init() -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            last_opened_at INTEGER
        );"
    )?;
    Ok(conn)
}