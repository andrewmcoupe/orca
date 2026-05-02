//! `recent_events` projection: a per-workspace rolling buffer of the last 200 events
//! across all aggregates, used by the UI's event-stream strip.

use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};

use crate::events::types::AppendedEvent;

pub const RECENT_EVENTS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS recent_events (
    id              TEXT PRIMARY KEY,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    summary         TEXT NOT NULL,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recent_events_created_at ON recent_events (created_at DESC);
"#;

pub const MAX_ROWS: i64 = 200;

pub fn apply_ddl(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(RECENT_EVENTS_DDL)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentEventRow {
    pub id: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub event_type: String,
    pub summary: String,
    pub created_at: i64,
}

/// Insert this event into `recent_events`, then trim the table to the most recent
/// `MAX_ROWS` rows.
pub fn record_event(tx: &Transaction, event: &AppendedEvent) -> rusqlite::Result<()> {
    let summary = summarize(event);
    tx.execute(
        "INSERT OR REPLACE INTO recent_events (id, aggregate_type, aggregate_id, event_type, summary, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            event.id,
            event.aggregate_type,
            event.aggregate_id,
            event.event_type,
            summary,
            event.created_at,
        ],
    )?;
    tx.execute(
        "DELETE FROM recent_events WHERE id NOT IN (
             SELECT id FROM recent_events ORDER BY created_at DESC, id DESC LIMIT ?1
         )",
        params![MAX_ROWS],
    )?;
    Ok(())
}

/// One-line human-readable summary of an event. Best-effort — falls back to the event
/// type if payload parsing fails.
pub fn summarize(event: &AppendedEvent) -> String {
    let payload: serde_json::Value =
        serde_json::from_str(&event.payload).unwrap_or(serde_json::Value::Null);
    let s = |key: &str| payload.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();

    match event.event_type.as_str() {
        "WorkspaceRegistered" => format!("Workspace registered: {}", s("name")),
        "WorkspaceArchived" => format!("Workspace archived: {}", s("reason")),
        "WorkspaceSettingsChanged" => "Workspace settings changed".into(),
        "TaskCreated" => format!("Task created: {}", s("title")),
        "TaskSpecRevised" => "Task spec revised".into(),
        "TaskCancelled" => format!("Task cancelled: {}", s("reason")),
        "TaskApproved" => format!("Task approved by {}", s("by")),
        "TaskMerged" => format!("Task merged ({})", s("merge_strategy")),
        "TaskArchived" => "Task archived".into(),
        "PhaseRunStarted" => format!(
            "Phase run started: {} ({})",
            s("phase"),
            s("provider"),
        ),
        "PhaseRunOutputAppended" => {
            let chunk = payload.get("chunk").and_then(|v| v.as_str()).unwrap_or("");
            format!("Output: {} chars", chunk.chars().count())
        }
        "PhaseRunToolCalled" => format!("Tool called: {}", s("tool_name")),
        "PhaseRunCompleted" => {
            let exit = payload.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(-1);
            format!("Phase run completed (exit {})", exit)
        }
        "PhaseRunFailed" => format!(
            "Phase run failed: {} — {}",
            s("error_kind"),
            s("error_message")
        ),
        "GateRan" => {
            let passed = payload
                .get("passed")
                .and_then(|v| v.as_bool())
                .map(|b| if b { "passed" } else { "failed" })
                .unwrap_or("?");
            format!("Gate {}: {}", s("gate_name"), passed)
        }
        other => other.to_string(),
    }
}

pub fn list_recent(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<RecentEventRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, aggregate_type, aggregate_id, event_type, summary, created_at
         FROM recent_events
         ORDER BY created_at DESC, id DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(RecentEventRow {
            id: r.get(0)?,
            aggregate_type: r.get(1)?,
            aggregate_id: r.get(2)?,
            event_type: r.get(3)?,
            summary: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
