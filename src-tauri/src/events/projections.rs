//! Projection tables and appliers.
//!
//! Projections are derived state. They live in either the global db (workspace) or the
//! per-workspace db (task, phase_run) and are updated in the same transaction as the
//! event append.

use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::types::AppendedEvent;

#[derive(Debug, Error)]
pub enum ProjectionError {
    #[error("projection database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("projection serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("unknown event type: {0}")]
    UnknownEventType(String),
}

// ---------- Workspace (global db) ----------

pub const WORKSPACE_PROJECTION_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS workspace_projection (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    settings_json   TEXT NOT NULL DEFAULT '{}',
    archived        INTEGER NOT NULL DEFAULT 0,
    archived_reason TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
"#;

pub fn apply_workspace_projection_ddl(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(WORKSPACE_PROJECTION_DDL)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceProjection {
    pub id: String,
    pub path: String,
    pub name: String,
    pub archived: bool,
    pub archived_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct WorkspaceRegisteredPayload {
    path: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct WorkspaceSettingsChangedPayload {
    settings: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct WorkspaceArchivedPayload {
    reason: String,
}

pub fn apply_workspace_event(
    tx: &Transaction,
    event: &AppendedEvent,
) -> Result<(), ProjectionError> {
    match event.event_type.as_str() {
        "WorkspaceRegistered" => {
            let p: WorkspaceRegisteredPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "INSERT INTO workspace_projection (id, path, name, settings_json, archived, archived_reason, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '{}', 0, NULL, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET path=excluded.path, name=excluded.name, updated_at=excluded.updated_at",
                params![event.aggregate_id, p.path, p.name, event.created_at],
            )?;
        }
        "WorkspaceSettingsChanged" => {
            let p: WorkspaceSettingsChangedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE workspace_projection SET settings_json = ?1, updated_at = ?2 WHERE id = ?3",
                params![p.settings.to_string(), event.created_at, event.aggregate_id],
            )?;
        }
        "WorkspaceArchived" => {
            let p: WorkspaceArchivedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE workspace_projection SET archived = 1, archived_reason = ?1, updated_at = ?2 WHERE id = ?3",
                params![p.reason, event.created_at, event.aggregate_id],
            )?;
        }
        other => return Err(ProjectionError::UnknownEventType(other.to_string())),
    }
    Ok(())
}

pub fn list_active_workspaces(conn: &Connection) -> rusqlite::Result<Vec<WorkspaceProjection>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, name, archived, archived_reason, created_at, updated_at
         FROM workspace_projection
         WHERE archived = 0
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(WorkspaceProjection {
            id: r.get(0)?,
            path: r.get(1)?,
            name: r.get(2)?,
            archived: r.get::<_, i64>(3)? != 0,
            archived_reason: r.get(4)?,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_workspace(conn: &Connection, id: &str) -> rusqlite::Result<Option<WorkspaceProjection>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, name, archived, archived_reason, created_at, updated_at
         FROM workspace_projection WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(r) = rows.next()? {
        Ok(Some(WorkspaceProjection {
            id: r.get(0)?,
            path: r.get(1)?,
            name: r.get(2)?,
            archived: r.get::<_, i64>(3)? != 0,
            archived_reason: r.get(4)?,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
        }))
    } else {
        Ok(None)
    }
}

// ---------- Task & PhaseRun (per-workspace db) ----------

pub const TASK_PROJECTION_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS plan_projection (
    id                  TEXT PRIMARY KEY,
    workspace_id        TEXT NOT NULL,
    title               TEXT NOT NULL,
    description         TEXT NOT NULL,
    source              TEXT NOT NULL,        -- manual | prd_file | linear | github_issue
    source_metadata     TEXT,                 -- JSON object or NULL
    status              TEXT NOT NULL,        -- active | paused | completed | cancelled | archived
    pause_reason        TEXT,
    cancel_reason       TEXT,
    task_count              INTEGER NOT NULL DEFAULT 0,
    running_task_count      INTEGER NOT NULL DEFAULT 0,
    done_task_count         INTEGER NOT NULL DEFAULT 0,
    failed_task_count       INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_projection_workspace ON plan_projection (workspace_id);

CREATE TABLE IF NOT EXISTS task_projection (
    id                  TEXT PRIMARY KEY,
    workspace_id        TEXT NOT NULL,
    plan_id             TEXT NOT NULL,
    title               TEXT NOT NULL,
    spec_markdown       TEXT NOT NULL,
    status              TEXT NOT NULL,        -- created | cancelled | approved | merged | archived
    cancel_reason       TEXT,
    approved_by         TEXT,
    merged_commit_sha   TEXT,
    merge_strategy      TEXT,
    latest_phase_run_id TEXT,
    worktree_path       TEXT,                 -- absolute path while a worktree exists
    worktree_branch     TEXT,
    worktree_base_commit TEXT,
    worktree_status     TEXT,                 -- 'active' | 'removed' | NULL if never created
    worktree_removal_reason TEXT,
    phase_config        TEXT NOT NULL DEFAULT '{}', -- resolved phase config JSON for this task
    task_base_commit    TEXT,                 -- diff anchor for the task (TaskBaseCommitRecorded)
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_projection_workspace ON task_projection (workspace_id);
CREATE INDEX IF NOT EXISTS idx_task_projection_plan ON task_projection (plan_id);

CREATE TABLE IF NOT EXISTS phase_run_projection (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    phase           TEXT NOT NULL,
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    status          TEXT NOT NULL,        -- running | completed | failed
    summary         TEXT,
    exit_code       INTEGER,
    error_kind      TEXT,
    error_message   TEXT,
    files_changed   TEXT,                 -- JSON array
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    started_at      INTEGER NOT NULL,
    completed_at    INTEGER,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phase_run_projection_task ON phase_run_projection (task_id);

CREATE TABLE IF NOT EXISTS phase_run_output (
    phase_run_id    TEXT NOT NULL,
    chunk_seq       INTEGER NOT NULL,
    chunk           TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (phase_run_id, chunk_seq)
);

CREATE TABLE IF NOT EXISTS phase_run_tool_call (
    phase_run_id    TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    tool_name       TEXT NOT NULL,
    args            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (phase_run_id, seq)
);

CREATE TABLE IF NOT EXISTS phase_run_gate (
    phase_run_id    TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    gate_name       TEXT NOT NULL,
    passed          INTEGER NOT NULL,
    output          TEXT NOT NULL,
    duration_ms     INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (phase_run_id, seq)
);

CREATE TABLE IF NOT EXISTS auditor_verdict_projection (
    phase_run_id    TEXT PRIMARY KEY,         -- the auditor PhaseRun whose verdict this is
    task_id         TEXT NOT NULL,
    verdict         TEXT NOT NULL,            -- approve | revise | reject
    confidence      REAL NOT NULL,
    summary         TEXT NOT NULL,
    concerns_json   TEXT NOT NULL,            -- JSON array of concern objects
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditor_verdict_task ON auditor_verdict_projection (task_id);
"#;

pub fn apply_workspace_db_projection_ddl(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(TASK_PROJECTION_DDL)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanProjection {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: String,
    pub source: String,
    pub source_metadata: Option<serde_json::Value>,
    pub status: String,
    pub pause_reason: Option<String>,
    pub cancel_reason: Option<String>,
    pub task_count: i64,
    pub running_task_count: i64,
    pub done_task_count: i64,
    pub failed_task_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct PlanCreatedPayload {
    workspace_id: String,
    title: String,
    description: String,
    source: String,
    source_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct PlanDescriptionRevisedPayload {
    title: String,
    description: String,
    #[allow(dead_code)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlanPausedPayload {
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlanCancelledPayload {
    reason: String,
}

pub fn apply_plan_event(tx: &Transaction, event: &AppendedEvent) -> Result<(), ProjectionError> {
    match event.event_type.as_str() {
        "PlanCreated" => {
            let p: PlanCreatedPayload = serde_json::from_str(&event.payload)?;
            let metadata_str = p
                .source_metadata
                .as_ref()
                .map(|v| v.to_string());
            tx.execute(
                "INSERT INTO plan_projection
                    (id, workspace_id, title, description, source, source_metadata, status,
                     task_count, running_task_count, done_task_count, failed_task_count,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 0, 0, 0, 0, ?7, ?7)",
                params![
                    event.aggregate_id,
                    p.workspace_id,
                    p.title,
                    p.description,
                    p.source,
                    metadata_str,
                    event.created_at,
                ],
            )?;
        }
        "PlanDescriptionRevised" => {
            let p: PlanDescriptionRevisedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE plan_projection SET title = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
                params![p.title, p.description, event.created_at, event.aggregate_id],
            )?;
        }
        "PlanPaused" => {
            let p: PlanPausedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE plan_projection SET status = 'paused', pause_reason = ?1, updated_at = ?2 WHERE id = ?3",
                params![p.reason, event.created_at, event.aggregate_id],
            )?;
        }
        "PlanResumed" => {
            tx.execute(
                "UPDATE plan_projection SET status = 'active', pause_reason = NULL, updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "PlanCompleted" => {
            tx.execute(
                "UPDATE plan_projection SET status = 'completed', updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "PlanCancelled" => {
            let p: PlanCancelledPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE plan_projection SET status = 'cancelled', cancel_reason = ?1, updated_at = ?2 WHERE id = ?3",
                params![p.reason, event.created_at, event.aggregate_id],
            )?;
        }
        "PlanArchived" => {
            tx.execute(
                "UPDATE plan_projection SET status = 'archived', updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        other => return Err(ProjectionError::UnknownEventType(other.to_string())),
    }
    Ok(())
}

fn read_plan(r: &rusqlite::Row) -> rusqlite::Result<PlanProjection> {
    let metadata_str: Option<String> = r.get(5)?;
    let source_metadata = metadata_str
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .unwrap_or(None);
    Ok(PlanProjection {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        title: r.get(2)?,
        description: r.get(3)?,
        source: r.get(4)?,
        source_metadata,
        status: r.get(6)?,
        pause_reason: r.get(7)?,
        cancel_reason: r.get(8)?,
        task_count: r.get(9)?,
        running_task_count: r.get(10)?,
        done_task_count: r.get(11)?,
        failed_task_count: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
    })
}

const PLAN_COLUMNS: &str = "id, workspace_id, title, description, source, source_metadata, status, pause_reason, cancel_reason, task_count, running_task_count, done_task_count, failed_task_count, created_at, updated_at";

pub fn list_plans(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<PlanProjection>> {
    let sql = format!(
        "SELECT {PLAN_COLUMNS} FROM plan_projection WHERE workspace_id = ?1 ORDER BY updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![workspace_id], read_plan)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_plan(conn: &Connection, id: &str) -> rusqlite::Result<Option<PlanProjection>> {
    let sql = format!("SELECT {PLAN_COLUMNS} FROM plan_projection WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    if let Some(r) = rows.next()? {
        Ok(Some(read_plan(r)?))
    } else {
        Ok(None)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskProjection {
    pub id: String,
    pub workspace_id: String,
    pub plan_id: String,
    pub title: String,
    pub spec_markdown: String,
    pub status: String,
    pub cancel_reason: Option<String>,
    pub approved_by: Option<String>,
    pub merged_commit_sha: Option<String>,
    pub merge_strategy: Option<String>,
    pub latest_phase_run_id: Option<String>,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub worktree_base_commit: Option<String>,
    pub worktree_status: Option<String>,
    pub worktree_removal_reason: Option<String>,
    /// Resolved phase config JSON for this task (the value at create time — events are immutable).
    pub phase_config: serde_json::Value,
    pub task_base_commit: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseRunProjection {
    pub id: String,
    pub task_id: String,
    pub phase: String,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub summary: Option<String>,
    pub exit_code: Option<i64>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub files_changed: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseRunOutputChunk {
    pub chunk_seq: i64,
    pub chunk: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
struct TaskCreatedPayload {
    plan_id: String,
    title: String,
    spec_markdown: String,
    /// Resolved at task-creation time. Optional in deserialization so v2 events on disk
    /// (which lack the field) replay cleanly with bundled defaults.
    #[serde(default)]
    phase_config: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct TaskBaseCommitRecordedPayload {
    commit_sha: String,
}

#[derive(Debug, Deserialize)]
struct AuditorVerdictRenderedPayload {
    phase_run_id: String,
    verdict: String,
    confidence: f64,
    summary: String,
    concerns: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct TaskSpecRevisedPayload {
    spec_markdown: String,
    #[allow(dead_code)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TaskCancelledPayload {
    reason: String,
}

#[derive(Debug, Deserialize)]
struct TaskApprovedPayload {
    by: String,
}

#[derive(Debug, Deserialize)]
struct TaskMergedPayload {
    commit_sha: String,
    merge_strategy: String,
}

#[derive(Debug, Deserialize)]
struct WorktreeCreatedPayload {
    worktree_path: String,
    branch_name: String,
    base_commit: String,
}

#[derive(Debug, Deserialize)]
struct WorktreeRemovedPayload {
    #[allow(dead_code)]
    worktree_path: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct WorktreeRemovalFailedPayload {
    #[allow(dead_code)]
    worktree_path: String,
    #[allow(dead_code)]
    error: String,
    #[allow(dead_code)]
    reason: String,
}

pub fn apply_task_event(tx: &Transaction, event: &AppendedEvent) -> Result<(), ProjectionError> {
    match event.event_type.as_str() {
        "TaskCreated" => {
            let p: TaskCreatedPayload = serde_json::from_str(&event.payload)?;
            // workspace_id is derived from the parent plan; this also enforces that the
            // referenced plan exists.
            let workspace_id: String = tx
                .query_row(
                    "SELECT workspace_id FROM plan_projection WHERE id = ?1",
                    params![p.plan_id],
                    |r| r.get(0),
                )
                .map_err(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => ProjectionError::Database(
                        rusqlite::Error::QueryReturnedNoRows,
                    ),
                    other => ProjectionError::Database(other),
                })?;
            // Phase config: events are immutable, so we serialize whatever was on the
            // event. Old v2 events (no phase_config field) get the bundled default
            // baked into the projection — this is the one place "old data tolerance"
            // lives in the applier.
            let phase_config_json = match p.phase_config {
                Some(v) => v.to_string(),
                None => serde_json::to_string(&crate::settings::PhaseConfig::bundled_default())?,
            };
            tx.execute(
                "INSERT INTO task_projection
                    (id, workspace_id, plan_id, title, spec_markdown, status, phase_config, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'created', ?6, ?7, ?7)",
                params![
                    event.aggregate_id,
                    workspace_id,
                    p.plan_id,
                    p.title,
                    p.spec_markdown,
                    phase_config_json,
                    event.created_at,
                ],
            )?;
            // Cross-aggregate: bump the plan's task_count.
            tx.execute(
                "UPDATE plan_projection SET task_count = task_count + 1, updated_at = ?1 WHERE id = ?2",
                params![event.created_at, p.plan_id],
            )?;
        }
        "TaskSpecRevised" => {
            let p: TaskSpecRevisedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection SET spec_markdown = ?1, updated_at = ?2 WHERE id = ?3",
                params![p.spec_markdown, event.created_at, event.aggregate_id],
            )?;
        }
        "TaskCancelled" => {
            let p: TaskCancelledPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection SET status = 'cancelled', cancel_reason = ?1, updated_at = ?2 WHERE id = ?3",
                params![p.reason, event.created_at, event.aggregate_id],
            )?;
        }
        "TaskApproved" => {
            let p: TaskApprovedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection SET status = 'approved', approved_by = ?1, updated_at = ?2 WHERE id = ?3",
                params![p.by, event.created_at, event.aggregate_id],
            )?;
        }
        "TaskMerged" => {
            let p: TaskMergedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection SET status = 'merged', merged_commit_sha = ?1, merge_strategy = ?2, updated_at = ?3 WHERE id = ?4",
                params![p.commit_sha, p.merge_strategy, event.created_at, event.aggregate_id],
            )?;
            // Cross-aggregate: bump the plan's done_task_count.
            tx.execute(
                "UPDATE plan_projection
                 SET done_task_count = done_task_count + 1, updated_at = ?1
                 WHERE id = (SELECT plan_id FROM task_projection WHERE id = ?2)",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "TaskArchived" => {
            tx.execute(
                "UPDATE task_projection SET status = 'archived', updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "TaskBaseCommitRecorded" => {
            let p: TaskBaseCommitRecordedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection SET task_base_commit = ?1, updated_at = ?2 WHERE id = ?3",
                params![p.commit_sha, event.created_at, event.aggregate_id],
            )?;
        }
        "WorktreeCreated" => {
            let p: WorktreeCreatedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection
                 SET worktree_path = ?1,
                     worktree_branch = ?2,
                     worktree_base_commit = ?3,
                     worktree_status = 'active',
                     worktree_removal_reason = NULL,
                     updated_at = ?4
                 WHERE id = ?5",
                params![
                    p.worktree_path,
                    p.branch_name,
                    p.base_commit,
                    event.created_at,
                    event.aggregate_id,
                ],
            )?;
        }
        "WorktreeRemoved" => {
            let p: WorktreeRemovedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection
                 SET worktree_status = 'removed',
                     worktree_removal_reason = ?1,
                     updated_at = ?2
                 WHERE id = ?3",
                params![p.reason, event.created_at, event.aggregate_id],
            )?;
        }
        "WorktreeRemovalFailed" => {
            // No-op on the projection: the worktree is still considered active. Surfaced via
            // the recent_events strip and (eventually) a UI affordance to retry.
            let _: WorktreeRemovalFailedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection SET updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        other => return Err(ProjectionError::UnknownEventType(other.to_string())),
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct PhaseRunStartedPayload {
    task_id: String,
    phase: String,
    provider: String,
    model: String,
    #[allow(dead_code)]
    prompt_template_id: String,
    #[allow(dead_code)]
    worktree_path: String,
}

#[derive(Debug, Deserialize)]
struct PhaseRunOutputAppendedPayload {
    chunk: String,
    chunk_seq: i64,
}

#[derive(Debug, Deserialize)]
struct PhaseRunToolCalledPayload {
    tool_name: String,
    args: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct PhaseRunCompletedPayload {
    exit_code: i64,
    summary: String,
    files_changed: Vec<String>,
    token_usage: TokenUsage,
}

#[derive(Debug, Deserialize)]
struct TokenUsage {
    input: i64,
    output: i64,
}

#[derive(Debug, Deserialize)]
struct PhaseRunFailedPayload {
    error_kind: String,
    error_message: String,
}

#[derive(Debug, Deserialize)]
struct GateRanPayload {
    gate_name: String,
    passed: bool,
    output: String,
    duration_ms: i64,
}

pub fn apply_phase_run_event(
    tx: &Transaction,
    event: &AppendedEvent,
) -> Result<(), ProjectionError> {
    match event.event_type.as_str() {
        "PhaseRunStarted" => {
            let p: PhaseRunStartedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "INSERT INTO phase_run_projection
                    (id, task_id, phase, provider, model, status, started_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?6)",
                params![
                    event.aggregate_id,
                    p.task_id,
                    p.phase,
                    p.provider,
                    p.model,
                    event.created_at,
                ],
            )?;
            tx.execute(
                "UPDATE task_projection SET latest_phase_run_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![event.aggregate_id, event.created_at, p.task_id],
            )?;
            // Cross-aggregate: bump the plan's running counter.
            tx.execute(
                "UPDATE plan_projection
                 SET running_task_count = running_task_count + 1, updated_at = ?1
                 WHERE id = (SELECT plan_id FROM task_projection WHERE id = ?2)",
                params![event.created_at, p.task_id],
            )?;
        }
        "PhaseRunOutputAppended" => {
            let p: PhaseRunOutputAppendedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "INSERT OR REPLACE INTO phase_run_output (phase_run_id, chunk_seq, chunk, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![event.aggregate_id, p.chunk_seq, p.chunk, event.created_at],
            )?;
            tx.execute(
                "UPDATE phase_run_projection SET updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "PhaseRunToolCalled" => {
            let p: PhaseRunToolCalledPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "INSERT INTO phase_run_tool_call (phase_run_id, seq, tool_name, args, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![event.aggregate_id, event.seq, p.tool_name, p.args.to_string(), event.created_at],
            )?;
        }
        "PhaseRunCompleted" => {
            let p: PhaseRunCompletedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE phase_run_projection
                 SET status = 'completed',
                     summary = ?1,
                     exit_code = ?2,
                     files_changed = ?3,
                     input_tokens = ?4,
                     output_tokens = ?5,
                     completed_at = ?6,
                     updated_at = ?6
                 WHERE id = ?7",
                params![
                    p.summary,
                    p.exit_code,
                    serde_json::to_string(&p.files_changed)?,
                    p.token_usage.input,
                    p.token_usage.output,
                    event.created_at,
                    event.aggregate_id,
                ],
            )?;
            // Cross-aggregate: drop the plan's running counter (clamped at 0).
            tx.execute(
                "UPDATE plan_projection
                 SET running_task_count = MAX(running_task_count - 1, 0), updated_at = ?1
                 WHERE id = (
                     SELECT t.plan_id FROM task_projection t
                     JOIN phase_run_projection pr ON pr.task_id = t.id
                     WHERE pr.id = ?2
                 )",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "PhaseRunFailed" => {
            let p: PhaseRunFailedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE phase_run_projection
                 SET status = 'failed',
                     error_kind = ?1,
                     error_message = ?2,
                     completed_at = ?3,
                     updated_at = ?3
                 WHERE id = ?4",
                params![p.error_kind, p.error_message, event.created_at, event.aggregate_id],
            )?;
            // Cross-aggregate: running -1, failed +1 on the parent plan.
            tx.execute(
                "UPDATE plan_projection
                 SET running_task_count = MAX(running_task_count - 1, 0),
                     failed_task_count  = failed_task_count + 1,
                     updated_at = ?1
                 WHERE id = (
                     SELECT t.plan_id FROM task_projection t
                     JOIN phase_run_projection pr ON pr.task_id = t.id
                     WHERE pr.id = ?2
                 )",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "AuditorVerdictRendered" => {
            let p: AuditorVerdictRenderedPayload = serde_json::from_str(&event.payload)?;
            // Look up the auditor's task_id via the phase run projection for indexing.
            let task_id: String = tx
                .query_row(
                    "SELECT task_id FROM phase_run_projection WHERE id = ?1",
                    params![p.phase_run_id],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            tx.execute(
                "INSERT OR REPLACE INTO auditor_verdict_projection
                    (phase_run_id, task_id, verdict, confidence, summary, concerns_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    p.phase_run_id,
                    task_id,
                    p.verdict,
                    p.confidence,
                    p.summary,
                    p.concerns.to_string(),
                    event.created_at,
                ],
            )?;
        }
        "GateRan" => {
            let p: GateRanPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "INSERT INTO phase_run_gate (phase_run_id, seq, gate_name, passed, output, duration_ms, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    event.aggregate_id,
                    event.seq,
                    p.gate_name,
                    if p.passed { 1 } else { 0 },
                    p.output,
                    p.duration_ms,
                    event.created_at,
                ],
            )?;
        }
        other => return Err(ProjectionError::UnknownEventType(other.to_string())),
    }
    Ok(())
}

fn read_task(r: &rusqlite::Row) -> rusqlite::Result<TaskProjection> {
    let phase_config_str: String = r.get(16)?;
    let phase_config = serde_json::from_str(&phase_config_str)
        .unwrap_or_else(|_| serde_json::json!({}));
    Ok(TaskProjection {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        plan_id: r.get(2)?,
        title: r.get(3)?,
        spec_markdown: r.get(4)?,
        status: r.get(5)?,
        cancel_reason: r.get(6)?,
        approved_by: r.get(7)?,
        merged_commit_sha: r.get(8)?,
        merge_strategy: r.get(9)?,
        latest_phase_run_id: r.get(10)?,
        worktree_path: r.get(11)?,
        worktree_branch: r.get(12)?,
        worktree_base_commit: r.get(13)?,
        worktree_status: r.get(14)?,
        worktree_removal_reason: r.get(15)?,
        phase_config,
        task_base_commit: r.get(17)?,
        created_at: r.get(18)?,
        updated_at: r.get(19)?,
    })
}

const TASK_COLUMNS: &str = "id, workspace_id, plan_id, title, spec_markdown, status, cancel_reason, approved_by, merged_commit_sha, merge_strategy, latest_phase_run_id, worktree_path, worktree_branch, worktree_base_commit, worktree_status, worktree_removal_reason, phase_config, task_base_commit, created_at, updated_at";

pub fn list_tasks_in_plan(
    conn: &Connection,
    plan_id: &str,
) -> rusqlite::Result<Vec<TaskProjection>> {
    let sql = format!(
        "SELECT {TASK_COLUMNS} FROM task_projection WHERE plan_id = ?1 AND status != 'archived' ORDER BY created_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![plan_id], read_task)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_task(conn: &Connection, id: &str) -> rusqlite::Result<Option<TaskProjection>> {
    let sql = format!("SELECT {TASK_COLUMNS} FROM task_projection WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    if let Some(r) = rows.next()? {
        Ok(Some(read_task(r)?))
    } else {
        Ok(None)
    }
}

pub fn list_phase_runs_for_task(
    conn: &Connection,
    task_id: &str,
) -> rusqlite::Result<Vec<PhaseRunProjection>> {
    let mut stmt = conn.prepare(
        "SELECT id, task_id, phase, provider, model, status, summary, exit_code, error_kind, error_message,
                files_changed, input_tokens, output_tokens, started_at, completed_at, updated_at
         FROM phase_run_projection
         WHERE task_id = ?1
         ORDER BY started_at ASC",
    )?;
    let rows = stmt.query_map(params![task_id], |r| {
        Ok(PhaseRunProjection {
            id: r.get(0)?,
            task_id: r.get(1)?,
            phase: r.get(2)?,
            provider: r.get(3)?,
            model: r.get(4)?,
            status: r.get(5)?,
            summary: r.get(6)?,
            exit_code: r.get(7)?,
            error_kind: r.get(8)?,
            error_message: r.get(9)?,
            files_changed: r.get(10)?,
            input_tokens: r.get(11)?,
            output_tokens: r.get(12)?,
            started_at: r.get(13)?,
            completed_at: r.get(14)?,
            updated_at: r.get(15)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn list_phase_run_output(
    conn: &Connection,
    phase_run_id: &str,
) -> rusqlite::Result<Vec<PhaseRunOutputChunk>> {
    let mut stmt = conn.prepare(
        "SELECT chunk_seq, chunk, created_at FROM phase_run_output
         WHERE phase_run_id = ?1 ORDER BY chunk_seq ASC",
    )?;
    let rows = stmt.query_map(params![phase_run_id], |r| {
        Ok(PhaseRunOutputChunk {
            chunk_seq: r.get(0)?,
            chunk: r.get(1)?,
            created_at: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditorVerdictProjection {
    pub phase_run_id: String,
    pub task_id: String,
    pub verdict: String,
    pub confidence: f64,
    pub summary: String,
    /// JSON array of concerns; the frontend parses these.
    pub concerns: serde_json::Value,
    pub created_at: i64,
}

fn read_verdict(r: &rusqlite::Row) -> rusqlite::Result<AuditorVerdictProjection> {
    let concerns_str: String = r.get(5)?;
    let concerns =
        serde_json::from_str(&concerns_str).unwrap_or(serde_json::Value::Array(Vec::new()));
    Ok(AuditorVerdictProjection {
        phase_run_id: r.get(0)?,
        task_id: r.get(1)?,
        verdict: r.get(2)?,
        confidence: r.get(3)?,
        summary: r.get(4)?,
        concerns,
        created_at: r.get(6)?,
    })
}

pub fn get_auditor_verdict(
    conn: &Connection,
    phase_run_id: &str,
) -> rusqlite::Result<Option<AuditorVerdictProjection>> {
    let mut stmt = conn.prepare(
        "SELECT phase_run_id, task_id, verdict, confidence, summary, concerns_json, created_at
         FROM auditor_verdict_projection WHERE phase_run_id = ?1",
    )?;
    let mut rows = stmt.query(params![phase_run_id])?;
    if let Some(r) = rows.next()? {
        Ok(Some(read_verdict(r)?))
    } else {
        Ok(None)
    }
}

pub fn list_auditor_verdicts_for_task(
    conn: &Connection,
    task_id: &str,
) -> rusqlite::Result<Vec<AuditorVerdictProjection>> {
    let mut stmt = conn.prepare(
        "SELECT phase_run_id, task_id, verdict, confidence, summary, concerns_json, created_at
         FROM auditor_verdict_projection WHERE task_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![task_id], read_verdict)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
