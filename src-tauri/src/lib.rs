mod db;

use std::sync::Mutex;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

pub struct DbState(pub Mutex<Connection>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub id: String,
    pub path: String,
    pub name: String,
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn add_workspace(path: String, state: State<'_, DbState>) -> Result<Workspace, String> {
    let output = Command::new("git")
        .args(["-C", &path, "rev-parse", "--git-dir"])
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;

    if !output.status.success() {
        return Err(format!("not a git repository: {}", path));
    }

    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();

    let id = format!("ws_{}", uuid_like());
    let added_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO workspaces (id, path, name, added_at, last_opened_at) VALUES (?1, ?2, ?3, ?4, NULL)",
        rusqlite::params![id, path, name, added_at],
    )
    .map_err(|e| e.to_string())?;

    Ok(Workspace {
        id,
        path,
        name,
        added_at,
        last_opened_at: None,
    })
}

#[tauri::command]
fn list_workspaces(state: State<'_, DbState>) -> Result<Vec<Workspace>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, path, name, added_at, last_opened_at FROM workspaces ORDER BY last_opened_at DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Workspace {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                added_at: row.get(3)?,
                last_opened_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn remove_workspace(id: String, state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM workspaces WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn uuid_like() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::init().expect("failed to initialize database");
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            add_workspace,
            list_workspaces,
            remove_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
