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
    merge_target_branch TEXT,                 -- branch we merged into (TaskMerged v2)
    merged_at           INTEGER,              -- created_at of the TaskMerged event
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
    permission_mode TEXT,                 -- the resolved mode at start time; NULL for legacy events

    status          TEXT NOT NULL,        -- running | completed | failed
    summary         TEXT,
    exit_code       INTEGER,
    error_kind      TEXT,
    error_message   TEXT,
    files_changed   TEXT,                 -- JSON array
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    head_commit_after TEXT,                 -- worktree HEAD after the phase committed; null until PhaseRunCompleted lands
    is_retry_of     TEXT,                    -- prior phase_run_id this is a retry of; null for first attempts
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

-- Records every TaskMergeAttempted event (failed merge attempts due to conflicts).
-- Keyed by (task_id, attempted_at) so the UI can show the most recent one inline.
CREATE TABLE IF NOT EXISTS task_merge_attempt_projection (
    task_id          TEXT NOT NULL,
    attempted_at     INTEGER NOT NULL,
    target_branch    TEXT NOT NULL,
    source_branch    TEXT NOT NULL,
    target_head_sha  TEXT NOT NULL,
    conflicts_json   TEXT NOT NULL,           -- JSON array of file paths
    PRIMARY KEY (task_id, attempted_at)
);
CREATE INDEX IF NOT EXISTS idx_task_merge_attempt_task ON task_merge_attempt_projection (task_id);

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
    conn.execute_batch(TASK_PROJECTION_DDL)?;
    // Additive migrations — `CREATE TABLE IF NOT EXISTS` won't add new columns to a
    // pre-existing table, so explicitly add v2-merge columns when missing. Each ALTER
    // is wrapped in a one-shot match so a duplicate-column error from a re-run is a
    // benign no-op.
    let migrations = &[
        "ALTER TABLE task_projection ADD COLUMN merge_target_branch TEXT",
        "ALTER TABLE task_projection ADD COLUMN merged_at INTEGER",
        // M3: worktree initialization. `worktree_init_status` is the load-bearing
        // column — phase runners and the pipeline check it to decide whether to
        // run init or proceed. The other columns are display-only for the UI.
        "ALTER TABLE task_projection ADD COLUMN worktree_init_status TEXT",
        "ALTER TABLE task_projection ADD COLUMN worktree_init_command TEXT",
        "ALTER TABLE task_projection ADD COLUMN worktree_init_exit_code INTEGER",
        "ALTER TABLE task_projection ADD COLUMN worktree_init_duration_ms INTEGER",
        "ALTER TABLE task_projection ADD COLUMN worktree_init_detection_kind TEXT",
        "ALTER TABLE task_projection ADD COLUMN worktree_init_output TEXT",
        // Per-phase permission mode (M-permission-modes): captured on PhaseRunStarted
        // so the UI surfaces what mode the run actually used. Old events are NULL.
        "ALTER TABLE phase_run_projection ADD COLUMN permission_mode TEXT",
    ];
    for sql in migrations {
        match conn.execute(sql, []) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("duplicate column") => {}
            Err(e) => {
                let s = e.to_string();
                if !s.contains("duplicate column") {
                    return Err(e);
                }
            }
        }
    }
    Ok(())
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
    pub merge_target_branch: Option<String>,
    pub merged_at: Option<i64>,
    pub latest_phase_run_id: Option<String>,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub worktree_base_commit: Option<String>,
    pub worktree_status: Option<String>,
    pub worktree_removal_reason: Option<String>,
    /// Resolved phase config JSON for this task (the value at create time — events are immutable).
    pub phase_config: serde_json::Value,
    pub task_base_commit: Option<String>,
    /// 'initialized' (success or user-skipped) | 'failed' | NULL (not yet run).
    /// Phase runners check this before running; if NULL the runner triggers init,
    /// if 'failed' the runner refuses until the user retries or skips.
    #[serde(default)]
    pub worktree_init_status: Option<String>,
    #[serde(default)]
    pub worktree_init_command: Option<String>,
    #[serde(default)]
    pub worktree_init_exit_code: Option<i64>,
    #[serde(default)]
    pub worktree_init_duration_ms: Option<i64>,
    #[serde(default)]
    pub worktree_init_detection_kind: Option<String>,
    #[serde(default)]
    pub worktree_init_output: Option<String>,
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
    /// `"plan" | "acceptEdits" | "bypassPermissions"`. Optional for legacy phase runs
    /// that were started before the field landed; the UI treats `None` as "unknown".
    #[serde(default)]
    pub permission_mode: Option<String>,
    pub status: String,
    pub summary: Option<String>,
    pub exit_code: Option<i64>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub files_changed: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    #[serde(default)]
    pub head_commit_after: Option<String>,
    #[serde(default)]
    pub is_retry_of: Option<String>,
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
    /// v2 fields. Optional in deserialization so v1 events on disk replay cleanly.
    #[serde(default)]
    target_branch: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    source_branch: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    parent_commits: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct TaskMergeAttemptedPayload {
    target_branch: String,
    source_branch: String,
    conflicts: Vec<String>,
    target_head_sha: String,
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

/// Shared payload shape for `WorktreeInitialized` and `WorktreeInitializationFailed`.
/// They differ only in event_type and what status the projection ends up in.
#[derive(Debug, Deserialize)]
struct WorktreeInitializedPayload {
    command: String,
    exit_code: i32,
    duration_ms: u64,
    output: String,
    detection_kind: String,
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
                "UPDATE task_projection
                 SET status = 'merged',
                     merged_commit_sha = ?1,
                     merge_strategy = ?2,
                     merge_target_branch = ?3,
                     merged_at = ?4,
                     updated_at = ?4
                 WHERE id = ?5",
                params![
                    p.commit_sha,
                    p.merge_strategy,
                    p.target_branch,
                    event.created_at,
                    event.aggregate_id,
                ],
            )?;
            // Cross-aggregate: bump the plan's done_task_count.
            tx.execute(
                "UPDATE plan_projection
                 SET done_task_count = done_task_count + 1, updated_at = ?1
                 WHERE id = (SELECT plan_id FROM task_projection WHERE id = ?2)",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "TaskMergeAttempted" => {
            let p: TaskMergeAttemptedPayload = serde_json::from_str(&event.payload)?;
            let conflicts_json = serde_json::to_string(&p.conflicts)?;
            tx.execute(
                "INSERT OR REPLACE INTO task_merge_attempt_projection
                    (task_id, attempted_at, target_branch, source_branch, target_head_sha, conflicts_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    event.aggregate_id,
                    event.created_at,
                    p.target_branch,
                    p.source_branch,
                    p.target_head_sha,
                    conflicts_json,
                ],
            )?;
            tx.execute(
                "UPDATE task_projection SET updated_at = ?1 WHERE id = ?2",
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
            // Reset init status fields too — a fresh worktree is uninitialized,
            // even if a prior worktree on the same task had been initialized.
            tx.execute(
                "UPDATE task_projection
                 SET worktree_path = ?1,
                     worktree_branch = ?2,
                     worktree_base_commit = ?3,
                     worktree_status = 'active',
                     worktree_removal_reason = NULL,
                     worktree_init_status = NULL,
                     worktree_init_command = NULL,
                     worktree_init_exit_code = NULL,
                     worktree_init_duration_ms = NULL,
                     worktree_init_detection_kind = NULL,
                     worktree_init_output = NULL,
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
        "WorktreeInitialized" => {
            let p: WorktreeInitializedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection
                 SET worktree_init_status = 'initialized',
                     worktree_init_command = ?1,
                     worktree_init_exit_code = ?2,
                     worktree_init_duration_ms = ?3,
                     worktree_init_detection_kind = ?4,
                     worktree_init_output = ?5,
                     updated_at = ?6
                 WHERE id = ?7",
                params![
                    p.command,
                    p.exit_code,
                    p.duration_ms as i64,
                    p.detection_kind,
                    p.output,
                    event.created_at,
                    event.aggregate_id,
                ],
            )?;
        }
        "WorktreeInitializationFailed" => {
            let p: WorktreeInitializedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection
                 SET worktree_init_status = 'failed',
                     worktree_init_command = ?1,
                     worktree_init_exit_code = ?2,
                     worktree_init_duration_ms = ?3,
                     worktree_init_detection_kind = ?4,
                     worktree_init_output = ?5,
                     updated_at = ?6
                 WHERE id = ?7",
                params![
                    p.command,
                    p.exit_code,
                    p.duration_ms as i64,
                    p.detection_kind,
                    p.output,
                    event.created_at,
                    event.aggregate_id,
                ],
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
    /// `"plan" | "acceptEdits" | "bypassPermissions"`. Optional so events written before
    /// per-phase permission modes still replay cleanly.
    #[serde(default)]
    permission_mode: Option<String>,
    /// Legacy field; some phase runners (test_author/implementer/auditor in M3-M5+) emit
    /// `prompt_template_hash` instead. Not consumed by the projection — kept as `Option`
    /// so old events still parse.
    #[serde(default)]
    #[allow(dead_code)]
    prompt_template_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    worktree_path: Option<String>,
    #[serde(default)]
    is_retry_of: Option<String>,
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
    /// Recorded by phase runners after auto-commit; absent on legacy events.
    #[serde(default)]
    head_commit_after: Option<String>,
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
                    (id, task_id, phase, provider, model, permission_mode, status, is_retry_of, started_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?8)",
                params![
                    event.aggregate_id,
                    p.task_id,
                    p.phase,
                    p.provider,
                    p.model,
                    p.permission_mode,
                    p.is_retry_of,
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
                     head_commit_after = ?6,
                     completed_at = ?7,
                     updated_at = ?7
                 WHERE id = ?8",
                params![
                    p.summary,
                    p.exit_code,
                    serde_json::to_string(&p.files_changed)?,
                    p.token_usage.input,
                    p.token_usage.output,
                    p.head_commit_after,
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
    let phase_config_str: String = r.get(18)?;
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
        merge_target_branch: r.get(10)?,
        merged_at: r.get(11)?,
        latest_phase_run_id: r.get(12)?,
        worktree_path: r.get(13)?,
        worktree_branch: r.get(14)?,
        worktree_base_commit: r.get(15)?,
        worktree_status: r.get(16)?,
        worktree_removal_reason: r.get(17)?,
        phase_config,
        task_base_commit: r.get(19)?,
        worktree_init_status: r.get(20)?,
        worktree_init_command: r.get(21)?,
        worktree_init_exit_code: r.get(22)?,
        worktree_init_duration_ms: r.get(23)?,
        worktree_init_detection_kind: r.get(24)?,
        worktree_init_output: r.get(25)?,
        created_at: r.get(26)?,
        updated_at: r.get(27)?,
    })
}

const TASK_COLUMNS: &str = "id, workspace_id, plan_id, title, spec_markdown, status, cancel_reason, approved_by, merged_commit_sha, merge_strategy, merge_target_branch, merged_at, latest_phase_run_id, worktree_path, worktree_branch, worktree_base_commit, worktree_status, worktree_removal_reason, phase_config, task_base_commit, worktree_init_status, worktree_init_command, worktree_init_exit_code, worktree_init_duration_ms, worktree_init_detection_kind, worktree_init_output, created_at, updated_at";

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
        "SELECT id, task_id, phase, provider, model, permission_mode, status, summary, exit_code, error_kind, error_message,
                files_changed, input_tokens, output_tokens, head_commit_after, is_retry_of, started_at, completed_at, updated_at
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
            permission_mode: r.get(5)?,
            status: r.get(6)?,
            summary: r.get(7)?,
            exit_code: r.get(8)?,
            error_kind: r.get(9)?,
            error_message: r.get(10)?,
            files_changed: r.get(11)?,
            input_tokens: r.get(12)?,
            output_tokens: r.get(13)?,
            head_commit_after: r.get(14)?,
            is_retry_of: r.get(15)?,
            started_at: r.get(16)?,
            completed_at: r.get(17)?,
            updated_at: r.get(18)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Most recent successful `head_commit_after` per phase for the given task. Phases that
/// have never completed for this task are absent from the map. Used by phase runners to
/// populate `prior_phase_commits` on `PhaseRunStarted` and the prompt context.
pub fn prior_phase_commits(
    conn: &Connection,
    task_id: &str,
) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut stmt = conn.prepare(
        "SELECT phase, head_commit_after FROM phase_run_projection
         WHERE task_id = ?1
           AND status = 'completed'
           AND head_commit_after IS NOT NULL
         ORDER BY completed_at ASC",
    )?;
    let rows = stmt.query_map(params![task_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = std::collections::HashMap::new();
    for r in rows {
        let (phase, sha) = r?;
        // Latest wins because we iterate in completed_at ASC order.
        out.insert(phase, sha);
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

#[allow(dead_code)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMergeAttempt {
    pub task_id: String,
    pub attempted_at: i64,
    pub target_branch: String,
    pub source_branch: String,
    pub target_head_sha: String,
    pub conflicts: Vec<String>,
}

fn read_merge_attempt(r: &rusqlite::Row) -> rusqlite::Result<TaskMergeAttempt> {
    let conflicts_str: String = r.get(5)?;
    let conflicts = serde_json::from_str(&conflicts_str).unwrap_or_default();
    Ok(TaskMergeAttempt {
        task_id: r.get(0)?,
        attempted_at: r.get(1)?,
        target_branch: r.get(2)?,
        source_branch: r.get(3)?,
        target_head_sha: r.get(4)?,
        conflicts,
    })
}

/// Returns the most recent `TaskMergeAttempted` for the task, or None if there have been
/// no failed attempts. The UI surfaces this near the Merge button so users remember they
/// hit conflicts and need to resolve them.
pub fn latest_merge_attempt_for_task(
    conn: &Connection,
    task_id: &str,
) -> rusqlite::Result<Option<TaskMergeAttempt>> {
    let mut stmt = conn.prepare(
        "SELECT task_id, attempted_at, target_branch, source_branch, target_head_sha, conflicts_json
         FROM task_merge_attempt_projection
         WHERE task_id = ?1
         ORDER BY attempted_at DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query(params![task_id])?;
    if let Some(r) = rows.next()? {
        Ok(Some(read_merge_attempt(r)?))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::schema::apply_events_ddl;
    use crate::events::types::AppendedEvent;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        apply_events_ddl(&conn).unwrap();
        apply_workspace_db_projection_ddl(&conn).unwrap();
        // Seed a plan + task so cross-aggregate updates have something to land on.
        conn.execute(
            "INSERT INTO plan_projection
                (id, workspace_id, title, description, source, source_metadata, status,
                 task_count, running_task_count, done_task_count, failed_task_count,
                 created_at, updated_at)
             VALUES ('p1', 'ws', 't', '', 'manual', NULL, 'active', 1, 0, 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_projection
                (id, workspace_id, plan_id, title, spec_markdown, status, phase_config, created_at, updated_at)
             VALUES ('task1', 'ws', 'p1', 'demo', '', 'approved', '{}', 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    fn task_event(seq: i64, event_type: &str, payload: serde_json::Value) -> AppendedEvent {
        AppendedEvent {
            id: format!("ev_{seq}"),
            aggregate_type: "task".into(),
            aggregate_id: "task1".into(),
            seq,
            event_type: event_type.into(),
            version: if event_type == "TaskMerged" { 2 } else { 1 },
            payload: payload.to_string(),
            metadata: "{}".into(),
            created_at: 100 * seq,
        }
    }

    #[test]
    fn task_merge_attempted_inserts_attempt_row() {
        let mut conn = db();
        let tx = conn.transaction().unwrap();
        let ev = task_event(
            1,
            "TaskMergeAttempted",
            serde_json::json!({
                "target_branch": "main",
                "source_branch": "orca/task1",
                "conflicts": ["a.rs", "b/c.rs"],
                "target_head_sha": "deadbeef",
            }),
        );
        apply_task_event(&tx, &ev).unwrap();
        tx.commit().unwrap();

        let attempt = latest_merge_attempt_for_task(&conn, "task1").unwrap().unwrap();
        assert_eq!(attempt.target_branch, "main");
        assert_eq!(attempt.source_branch, "orca/task1");
        assert_eq!(attempt.target_head_sha, "deadbeef");
        assert_eq!(attempt.conflicts, vec!["a.rs", "b/c.rs"]);
        // Task itself stays approved — TaskMergeAttempted is not a state transition.
        let task = get_task(&conn, "task1").unwrap().unwrap();
        assert_eq!(task.status, "approved");
    }

    #[test]
    fn task_merged_v2_populates_new_columns() {
        let mut conn = db();
        let tx = conn.transaction().unwrap();
        let ev = task_event(
            1,
            "TaskMerged",
            serde_json::json!({
                "commit_sha": "abc123",
                "merge_strategy": "squash",
                "target_branch": "main",
                "source_branch": "orca/task1",
                "parent_commits": ["c0", "c1"],
            }),
        );
        apply_task_event(&tx, &ev).unwrap();
        tx.commit().unwrap();

        let task = get_task(&conn, "task1").unwrap().unwrap();
        assert_eq!(task.status, "merged");
        assert_eq!(task.merged_commit_sha.as_deref(), Some("abc123"));
        assert_eq!(task.merge_strategy.as_deref(), Some("squash"));
        assert_eq!(task.merge_target_branch.as_deref(), Some("main"));
        assert_eq!(task.merged_at, Some(100));

        // Plan's done_task_count incremented.
        let plan = get_plan(&conn, "p1").unwrap().unwrap();
        assert_eq!(plan.done_task_count, 1);
    }

    #[test]
    fn task_merged_v1_payload_replays_with_default_target_branch() {
        // v1 events on disk have no target_branch / source_branch / parent_commits — the
        // applier must still accept them, leaving the new columns NULL.
        let mut conn = db();
        let tx = conn.transaction().unwrap();
        let ev = AppendedEvent {
            id: "ev_old".into(),
            aggregate_type: "task".into(),
            aggregate_id: "task1".into(),
            seq: 1,
            event_type: "TaskMerged".into(),
            version: 1,
            payload: r#"{"commit_sha":"abc","merge_strategy":"squash"}"#.into(),
            metadata: "{}".into(),
            created_at: 50,
        };
        apply_task_event(&tx, &ev).unwrap();
        tx.commit().unwrap();
        let task = get_task(&conn, "task1").unwrap().unwrap();
        assert_eq!(task.status, "merged");
        assert_eq!(task.merge_target_branch, None);
        assert_eq!(task.merged_at, Some(50));
    }
}
