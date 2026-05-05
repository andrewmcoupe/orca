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
    conn.execute_batch(WORKSPACE_PROJECTION_DDL)?;
    // One-shot migration: prior to the path-freeing fix, archiving a workspace
    // left its row's `path` intact, blocking re-registration of the same repo
    // because of the UNIQUE constraint. Rewrite any leftover archived rows to
    // the same sentinel form the applier now produces. Idempotent — already-
    // sentineled rows match the LIKE filter but the UPDATE is a no-op for
    // them (path = path). The original path remains in the row's
    // `WorkspaceRegistered` event payload, so audit history is preserved.
    conn.execute(
        "UPDATE workspace_projection
         SET path = '__archived:' || id || '__/' || id
         WHERE archived = 1 AND path NOT LIKE '__archived:%'",
        [],
    )?;
    Ok(())
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
            // Free the path for re-registration. The `path` column is UNIQUE so
            // leaving the archived row's original value in place blocks
            // `add_workspace` if the user later re-adds the same repo (the row
            // is hidden from `list_active_workspaces` but still wins the unique
            // index). Rewriting to a sentinel keeps the audit trail intact —
            // the `WorkspaceRegistered` payload still has the real path —
            // while letting a fresh aggregate take the path. The sentinel
            // includes the aggregate id so two archives of the same path don't
            // collide with each other either.
            let archived_path =
                format!("__archived:{}__/{}", event.aggregate_id, event.aggregate_id);
            tx.execute(
                "UPDATE workspace_projection
                 SET archived = 1,
                     archived_reason = ?1,
                     path = ?2,
                     updated_at = ?3
                 WHERE id = ?4",
                params![
                    p.reason,
                    archived_path,
                    event.created_at,
                    event.aggregate_id
                ],
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
    phase_config        TEXT NOT NULL DEFAULT '{}', -- original phase config JSON snapshot from TaskCreated; never mutated after the fact
    current_phase_config TEXT NOT NULL DEFAULT '{}', -- latest effective phase config after applying TaskPhaseConfigChanged events; phase runners read from this
    relevant_files      TEXT NOT NULL DEFAULT '[]', -- RelevantFile[] JSON populated by briefing flow; empty for other paths
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

CREATE TABLE IF NOT EXISTS briefing_projection (
    id                      TEXT PRIMARY KEY,
    workspace_id            TEXT NOT NULL,
    status                  TEXT NOT NULL,            -- active | completed | cancelled
    initial_description     TEXT NOT NULL,
    provider                TEXT NOT NULL,
    model                   TEXT NOT NULL,
    current_draft_json      TEXT,                     -- BriefingDraft JSON, NULL until first draft lands
    pending_edits_json      TEXT,                     -- BriefingEdits JSON, NULL when no edits pending
    validation_results_json TEXT,                     -- PathValidationResult[] JSON, NULL until first draft
    generation_count        INTEGER NOT NULL DEFAULT 0,
    -- Background-generation flags:
    --   is_generating: 1 while a BriefingGenerationStarted has not yet been
    --   matched by a terminal event (DraftProduced, GenerationFailed,
    --   GenerationCancelled, Cancelled). Drives the UI's "still working"
    --   spinner and gates double-start at the command layer.
    --   generation_kind: 'initial' | 'refine' when is_generating, else NULL.
    --   last_generation_error: human-readable reason for the most recent
    --   GenerationFailed; cleared on the next Started/DraftProduced.
    is_generating           INTEGER NOT NULL DEFAULT 0,
    generation_kind         TEXT,
    last_generation_error   TEXT,
    final_plan_id           TEXT,
    cancel_reason           TEXT,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_briefing_projection_workspace ON briefing_projection (workspace_id);
CREATE INDEX IF NOT EXISTS idx_briefing_projection_generating
    ON briefing_projection (workspace_id, is_generating);
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
        // Briefing flow: relevant files identified by the plan author per task.
        // Empty array for tasks created via paths without file awareness.
        "ALTER TABLE task_projection ADD COLUMN relevant_files TEXT NOT NULL DEFAULT '[]'",
        // Per-task phase config editing: the original `phase_config` snapshot stays
        // immutable (audit trail); `current_phase_config` reflects the latest state
        // after `TaskPhaseConfigChanged` events. Phase runners resolve from this.
        // The default '{}' is intentionally wrong for existing rows — backfill below
        // copies `phase_config` over the empty default so existing tasks keep working.
        "ALTER TABLE task_projection ADD COLUMN current_phase_config TEXT NOT NULL DEFAULT '{}'",
        // Brief 4: task dependencies. `depends_on` is the JSON array of task IDs;
        // `is_blocked` is recomputed by appliers whenever a relevant change lands;
        // `is_queued` toggles via TaskQueued / TaskUnqueued and is cleared when the
        // task's first phase run starts; `unblocked_at` records the moment the
        // queue manager resolved the last dependency, with `last_unblocking_task_id`
        // naming which dep's merge produced the unblock (display + audit).
        "ALTER TABLE task_projection ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE task_projection ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE task_projection ADD COLUMN is_queued INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE task_projection ADD COLUMN unblocked_at INTEGER",
        "ALTER TABLE task_projection ADD COLUMN last_unblocking_task_id TEXT",
        // Briefing background-generation flags. See briefing_projection DDL above
        // for semantics. Additive — pre-existing rows default to not-generating
        // with NULL kind/error, which is the correct historical state.
        "ALTER TABLE briefing_projection ADD COLUMN is_generating INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE briefing_projection ADD COLUMN generation_kind TEXT",
        "ALTER TABLE briefing_projection ADD COLUMN last_generation_error TEXT",
    ];
    for sql in migrations {
        match conn.execute(sql, []) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
                if msg.contains("duplicate column") => {}
            Err(e) => {
                let s = e.to_string();
                if !s.contains("duplicate column") {
                    return Err(e);
                }
            }
        }
    }
    // One-time backfill: rows that pre-date the `current_phase_config` column landed
    // with the default '{}'. Copy the original `phase_config` over so the resolver
    // sees something useful. New rows go through the `TaskCreated` applier which
    // sets both columns explicitly. The WHERE clause makes this idempotent — once a
    // row has been backfilled (or genuinely customised), we leave it alone.
    conn.execute(
        "UPDATE task_projection
         SET current_phase_config = phase_config
         WHERE current_phase_config = '{}' AND phase_config <> '{}'",
        [],
    )?;
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
            let metadata_str = p.source_metadata.as_ref().map(|v| v.to_string());
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
    /// Resolved phase config JSON at task-creation time. Immutable — kept as the audit
    /// snapshot of "what the task was set up with."
    pub phase_config: serde_json::Value,
    /// Latest effective phase config — `phase_config` plus any `TaskPhaseConfigChanged`
    /// edits the user has made. Phase runners resolve from this; the UI compares it
    /// against the workspace default to surface the customisation indicator.
    #[serde(default)]
    pub current_phase_config: serde_json::Value,
    /// `RelevantFile[]` populated by the briefing flow. Empty array for tasks created
    /// via paths without file awareness (quick-task shortcut, manual creation).
    #[serde(default)]
    pub relevant_files: serde_json::Value,
    pub task_base_commit: Option<String>,
    /// 'initialized' (success or user-skipped) | 'failed' | 'running' (init in
    /// flight) | NULL (not yet run). Phase runners check this before running;
    /// if NULL the runner triggers init, if 'failed' the runner refuses until
    /// the user retries or skips. 'running' is informational for the UI —
    /// `ensure_initialized` doesn't observe it because it's only set inside its
    /// own call.
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
    /// Brief 4: dependency declarations.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Computed: any dep not in `merged` state. Recomputed by appliers for
    /// `TaskCreated` / `TaskDependenciesChanged` / `TaskMerged` / `TaskUnblocked`.
    #[serde(default)]
    pub is_blocked: bool,
    /// User clicked Run while blocked and chose to queue. Cleared on the
    /// task's first phase actually starting (or via TaskUnqueued).
    #[serde(default)]
    pub is_queued: bool,
    /// When the queue manager last unblocked this task. Display-only.
    #[serde(default)]
    pub unblocked_at: Option<i64>,
    /// The dependency whose merge produced the latest unblock.
    #[serde(default)]
    pub last_unblocking_task_id: Option<String>,
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
    /// Files the plan author flagged as likely targets. Optional so events written before
    /// the briefing flow landed replay cleanly with an empty array.
    #[serde(default)]
    relevant_files: Option<serde_json::Value>,
    /// v4: dependency declarations. Optional so v3 events on disk replay
    /// cleanly with an empty list (no dependencies).
    #[serde(default)]
    depends_on: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct TaskDependenciesChangedPayload {
    depends_on: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct TaskQueuedPayload {
    #[allow(dead_code)]
    queued_at: i64,
}

#[derive(Debug, Deserialize)]
struct TaskUnblockedPayload {
    unblocked_at: i64,
    unblocking_task_id: String,
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
struct TaskPhaseConfigChangedPayload {
    phase: String,
    /// `null` means "revert this field to the workspace default" — the applier removes
    /// the per-phase entry from the maps in `current_phase_config` rather than writing
    /// a literal null, so the resolver sees no override and falls through to the
    /// workspace setting.
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    permission_mode: Option<String>,
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

/// Emitted right before init runs so the projection can show an in-flight state.
/// The terminal exit/duration/output are unknown at this point.
#[derive(Debug, Deserialize)]
struct WorktreeInitializationStartedPayload {
    command: String,
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

/// Get a mutable reference to `value[key]`, replacing it with an empty object if it's
/// missing or non-object. Used by the `TaskPhaseConfigChanged` applier to safely mutate
/// `current_phase_config.models` and `.permission_modes` without losing other top-level
/// fields like `phases` and `gate_overrides`.
fn ensure_object<'a>(
    value: &'a mut serde_json::Value,
    key: &str,
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    if !value.is_object() {
        *value = serde_json::Value::Object(serde_json::Map::new());
    }
    let obj = value
        .as_object_mut()
        .expect("ensure_object: value is now object");
    let entry = obj
        .entry(key.to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !entry.is_object() {
        *entry = serde_json::Value::Object(serde_json::Map::new());
    }
    entry
        .as_object_mut()
        .expect("ensure_object: entry is now object")
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
                    rusqlite::Error::QueryReturnedNoRows => {
                        ProjectionError::Database(rusqlite::Error::QueryReturnedNoRows)
                    }
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
            let relevant_files_json = p
                .relevant_files
                .as_ref()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "[]".to_string());
            // v4: depends_on. Tolerantly defaults to [] for v3 events on disk.
            let depends_on = p.depends_on.unwrap_or_default();
            let depends_on_json = serde_json::to_string(&depends_on)?;
            // Initial is_blocked: any dep not in 'merged' state. The dependency
            // resolver lives in `crate::dependencies` so it's exercised by the
            // command-time validator and the same query here.
            let is_blocked = crate::dependencies::compute_is_blocked(tx, &depends_on)
                .map(|b| b as i64)
                .map_err(ProjectionError::Database)?;
            // `current_phase_config` starts equal to `phase_config` — the task hasn't
            // been edited yet. Subsequent `TaskPhaseConfigChanged` events mutate only
            // the current column, leaving the original snapshot intact for audit.
            tx.execute(
                "INSERT INTO task_projection
                    (id, workspace_id, plan_id, title, spec_markdown, status, phase_config, current_phase_config, relevant_files, depends_on, is_blocked, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'created', ?6, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    event.aggregate_id,
                    workspace_id,
                    p.plan_id,
                    p.title,
                    p.spec_markdown,
                    phase_config_json,
                    relevant_files_json,
                    depends_on_json,
                    is_blocked,
                    event.created_at,
                ],
            )?;
            // Cross-aggregate: bump the plan's task_count.
            tx.execute(
                "UPDATE plan_projection SET task_count = task_count + 1, updated_at = ?1 WHERE id = ?2",
                params![event.created_at, p.plan_id],
            )?;
        }
        "TaskDependenciesChanged" => {
            let p: TaskDependenciesChangedPayload = serde_json::from_str(&event.payload)?;
            let depends_on_json = serde_json::to_string(&p.depends_on)?;
            let is_blocked = crate::dependencies::compute_is_blocked(tx, &p.depends_on)
                .map(|b| b as i64)
                .map_err(ProjectionError::Database)?;
            tx.execute(
                "UPDATE task_projection
                 SET depends_on = ?1, is_blocked = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![
                    depends_on_json,
                    is_blocked,
                    event.created_at,
                    event.aggregate_id,
                ],
            )?;
        }
        "TaskQueued" => {
            let _: TaskQueuedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection SET is_queued = 1, updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "TaskUnqueued" => {
            tx.execute(
                "UPDATE task_projection SET is_queued = 0, updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "TaskUnblocked" => {
            let p: TaskUnblockedPayload = serde_json::from_str(&event.payload)?;
            // The queue manager only emits this event when find_newly_unblocked
            // confirms every dep has merged. Set the flag straight to false; if
            // we recomputed from scratch we'd hit the same answer at the cost of
            // an extra query.
            tx.execute(
                "UPDATE task_projection
                 SET is_blocked = 0,
                     unblocked_at = ?1,
                     last_unblocking_task_id = ?2,
                     updated_at = ?1
                 WHERE id = ?3",
                params![p.unblocked_at, p.unblocking_task_id, event.aggregate_id],
            )?;
        }
        "TaskSpecRevised" => {
            let p: TaskSpecRevisedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE task_projection SET spec_markdown = ?1, updated_at = ?2 WHERE id = ?3",
                params![p.spec_markdown, event.created_at, event.aggregate_id],
            )?;
        }
        "TaskPhaseConfigChanged" => {
            let p: TaskPhaseConfigChangedPayload = serde_json::from_str(&event.payload)?;
            // Read the current effective config, mutate the named phase's entries,
            // write it back. We never touch `phase_config` (the original snapshot).
            // Either of `provider`/`model` being None means "revert that side" — but
            // a `ModelChoice` is provider+model together, so partial updates are
            // collapsed: if either is None, we drop the model entry entirely. The
            // command layer enforces "all three or all-null", so this is defence-
            // in-depth against handcrafted payloads.
            let current_str: String = tx.query_row(
                "SELECT current_phase_config FROM task_projection WHERE id = ?1",
                params![event.aggregate_id],
                |r| r.get(0),
            )?;
            let mut current: serde_json::Value =
                serde_json::from_str(&current_str).unwrap_or_else(|_| serde_json::json!({}));
            let phase_name = p.phase.clone();

            // Models map: `{ phase -> { provider, model } }`.
            let models_obj = ensure_object(&mut current, "models");
            match (p.provider.as_ref(), p.model.as_ref()) {
                (Some(prov), Some(mdl)) => {
                    models_obj.insert(
                        phase_name.clone(),
                        serde_json::json!({ "provider": prov, "model": mdl }),
                    );
                }
                _ => {
                    models_obj.remove(&phase_name);
                }
            }

            // Permission modes map: `{ phase -> "plan" | "acceptEdits" | "bypassPermissions" }`.
            let modes_obj = ensure_object(&mut current, "permission_modes");
            match p.permission_mode.as_ref() {
                Some(m) => {
                    modes_obj.insert(phase_name.clone(), serde_json::Value::String(m.clone()));
                }
                None => {
                    modes_obj.remove(&phase_name);
                }
            }

            tx.execute(
                "UPDATE task_projection SET current_phase_config = ?1, updated_at = ?2 WHERE id = ?3",
                params![current.to_string(), event.created_at, event.aggregate_id],
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
            // Cross-aggregate (Brief 4): every dependent task may now be unblocked.
            // We can't push this into a single SQL statement without JSON1 (and we
            // chose to stay JSON1-free for portability), so we read the candidates,
            // recompute each one's is_blocked, and write back any that changed. The
            // queue manager hook in pipeline::on_task_merged is what dispatches
            // queued tasks — this projection update only refreshes the flag so the
            // UI shows the right state immediately.
            let workspace_id: Option<String> = tx
                .query_row(
                    "SELECT workspace_id FROM task_projection WHERE id = ?1",
                    params![event.aggregate_id],
                    |r| r.get(0),
                )
                .ok();
            if let Some(workspace_id) = workspace_id {
                let mut dependents: Vec<(String, Vec<String>)> = Vec::new();
                {
                    let mut stmt = tx.prepare(
                        "SELECT id, depends_on FROM task_projection
                         WHERE workspace_id = ?1
                           AND is_blocked = 1
                           AND status NOT IN ('merged', 'cancelled', 'archived')",
                    )?;
                    let rows = stmt.query_map(params![workspace_id], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })?;
                    for r in rows {
                        let (id, deps_str) = r?;
                        let deps: Vec<String> = serde_json::from_str(&deps_str).unwrap_or_default();
                        if deps.iter().any(|d| d == &event.aggregate_id) {
                            dependents.push((id, deps));
                        }
                    }
                }
                for (dep_task_id, deps) in dependents {
                    let still_blocked = crate::dependencies::compute_is_blocked(tx, &deps)
                        .map_err(ProjectionError::Database)?;
                    if !still_blocked {
                        // Note: we update the flag here so reads see consistent
                        // state, but do NOT auto-emit TaskUnblocked from inside
                        // the projection applier — that's the queue manager's
                        // job, executed *after* this transaction commits (see
                        // `pipeline::on_task_merged`). Auto-emitting events
                        // from inside an applier would violate the brief's
                        // "auto-derived events emitted after commit" rule.
                        tx.execute(
                            "UPDATE task_projection SET is_blocked = 0, updated_at = ?1 WHERE id = ?2",
                            params![event.created_at, dep_task_id],
                        )?;
                    }
                }
            }
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
        "WorktreeInitializationStarted" => {
            let p: WorktreeInitializationStartedPayload = serde_json::from_str(&event.payload)?;
            // Surface the in-flight install in the projection so the UI can
            // render a "running" row. Output/exit/duration stay NULL — they're
            // only known once the command finishes and we apply
            // `WorktreeInitialized` / `WorktreeInitializationFailed`.
            tx.execute(
                "UPDATE task_projection
                 SET worktree_init_status = 'running',
                     worktree_init_command = ?1,
                     worktree_init_detection_kind = ?2,
                     worktree_init_exit_code = NULL,
                     worktree_init_duration_ms = NULL,
                     worktree_init_output = NULL,
                     updated_at = ?3
                 WHERE id = ?4",
                params![
                    p.command,
                    p.detection_kind,
                    event.created_at,
                    event.aggregate_id,
                ],
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
                "UPDATE task_projection
                 SET latest_phase_run_id = ?1,
                     is_queued = 0,
                     updated_at = ?2
                 WHERE id = ?3",
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
                params![
                    event.aggregate_id,
                    event.seq,
                    p.tool_name,
                    p.args.to_string(),
                    event.created_at
                ],
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
                params![
                    p.error_kind,
                    p.error_message,
                    event.created_at,
                    event.aggregate_id
                ],
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
    let phase_config =
        serde_json::from_str(&phase_config_str).unwrap_or_else(|_| serde_json::json!({}));
    let current_phase_config_str: String = r.get(19)?;
    let current_phase_config =
        serde_json::from_str(&current_phase_config_str).unwrap_or_else(|_| serde_json::json!({}));
    let relevant_files_str: String = r.get(20)?;
    let relevant_files = serde_json::from_str(&relevant_files_str)
        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    let depends_on_str: String = r.get(28)?;
    let depends_on: Vec<String> = serde_json::from_str(&depends_on_str).unwrap_or_default();
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
        current_phase_config,
        relevant_files,
        task_base_commit: r.get(21)?,
        worktree_init_status: r.get(22)?,
        worktree_init_command: r.get(23)?,
        worktree_init_exit_code: r.get(24)?,
        worktree_init_duration_ms: r.get(25)?,
        worktree_init_detection_kind: r.get(26)?,
        worktree_init_output: r.get(27)?,
        depends_on,
        is_blocked: r.get::<_, i64>(29)? != 0,
        is_queued: r.get::<_, i64>(30)? != 0,
        unblocked_at: r.get(31)?,
        last_unblocking_task_id: r.get(32)?,
        created_at: r.get(33)?,
        updated_at: r.get(34)?,
    })
}

const TASK_COLUMNS: &str = "id, workspace_id, plan_id, title, spec_markdown, status, cancel_reason, approved_by, merged_commit_sha, merge_strategy, merge_target_branch, merged_at, latest_phase_run_id, worktree_path, worktree_branch, worktree_base_commit, worktree_status, worktree_removal_reason, phase_config, current_phase_config, relevant_files, task_base_commit, worktree_init_status, worktree_init_command, worktree_init_exit_code, worktree_init_duration_ms, worktree_init_detection_kind, worktree_init_output, depends_on, is_blocked, is_queued, unblocked_at, last_unblocking_task_id, created_at, updated_at";

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

// ============================================================================
// Briefing projection
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BriefingProjection {
    pub id: String,
    pub workspace_id: String,
    pub status: String,
    pub initial_description: String,
    pub provider: String,
    pub model: String,
    pub current_draft: Option<serde_json::Value>,
    pub pending_edits: Option<serde_json::Value>,
    pub validation_results: Option<serde_json::Value>,
    pub generation_count: i64,
    /// True between a `BriefingGenerationStarted` event and its matching terminal
    /// event (`BriefingDraftProduced`, `BriefingGenerationFailed`,
    /// `BriefingGenerationCancelled`, or `BriefingCancelled`). The UI uses this to
    /// drive the spinner and the in-flight chrome indicator; the command layer
    /// uses it to refuse a second concurrent start.
    pub is_generating: bool,
    /// `"initial"` for the first draft, `"refine"` for subsequent regenerations.
    /// `None` when not generating.
    pub generation_kind: Option<String>,
    /// Reason from the most recent `BriefingGenerationFailed`. Cleared when a new
    /// generation starts or a draft is produced. Surfaced as a banner on the
    /// briefing detail page.
    pub last_generation_error: Option<String>,
    pub final_plan_id: Option<String>,
    pub cancel_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct BriefingStartedPayload {
    workspace_id: String,
    initial_description: String,
    provider: String,
    model: String,
}

#[derive(Debug, Deserialize)]
struct BriefingDraftProducedPayload {
    draft: serde_json::Value,
    generation_index: i64,
    #[serde(default)]
    #[allow(dead_code)]
    prompt_template_hash: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    duration_ms: Option<i64>,
    #[serde(default)]
    validation_results: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct BriefingDraftEditedPayload {
    edits: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct BriefingPushedBackPayload {
    assumption_id: String,
    pushback: String,
}

#[derive(Debug, Deserialize)]
struct BriefingCompletedPayload {
    plan_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    final_generation_index: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct BriefingCancelledPayload {
    reason: String,
}

#[derive(Debug, Deserialize)]
struct BriefingGenerationStartedPayload {
    /// `"initial"` (first draft) or `"refine"` (subsequent regeneration).
    kind: String,
}

#[derive(Debug, Deserialize)]
struct BriefingGenerationFailedPayload {
    reason: String,
}

pub fn apply_briefing_event(
    tx: &Transaction,
    event: &AppendedEvent,
) -> Result<(), ProjectionError> {
    match event.event_type.as_str() {
        "BriefingStarted" => {
            let p: BriefingStartedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "INSERT INTO briefing_projection
                    (id, workspace_id, status, initial_description, provider, model,
                     generation_count, created_at, updated_at)
                 VALUES (?1, ?2, 'active', ?3, ?4, ?5, 0, ?6, ?6)",
                params![
                    event.aggregate_id,
                    p.workspace_id,
                    p.initial_description,
                    p.provider,
                    p.model,
                    event.created_at,
                ],
            )?;
        }
        "BriefingDraftProduced" => {
            let p: BriefingDraftProducedPayload = serde_json::from_str(&event.payload)?;
            // Terminal-success transition: clear the in-flight flags and any prior
            // failure reason so the UI shows a clean "draft is ready" state.
            tx.execute(
                "UPDATE briefing_projection
                 SET current_draft_json = ?1,
                     validation_results_json = ?2,
                     pending_edits_json = NULL,
                     generation_count = ?3,
                     is_generating = 0,
                     generation_kind = NULL,
                     last_generation_error = NULL,
                     updated_at = ?4
                 WHERE id = ?5",
                params![
                    p.draft.to_string(),
                    p.validation_results.as_ref().map(|v| v.to_string()),
                    p.generation_index,
                    event.created_at,
                    event.aggregate_id,
                ],
            )?;
        }
        "BriefingGenerationStarted" => {
            let p: BriefingGenerationStartedPayload = serde_json::from_str(&event.payload)?;
            // Set in-flight flags and clear any prior failure so the UI shows
            // "generating" cleanly. The command layer enforces no-double-start;
            // the projection trusts the event log.
            tx.execute(
                "UPDATE briefing_projection
                 SET is_generating = 1,
                     generation_kind = ?1,
                     last_generation_error = NULL,
                     updated_at = ?2
                 WHERE id = ?3",
                params![p.kind, event.created_at, event.aggregate_id],
            )?;
        }
        "BriefingGenerationFailed" => {
            let p: BriefingGenerationFailedPayload = serde_json::from_str(&event.payload)?;
            // Terminal-failure transition: drop the in-flight flag and stash the
            // reason so the briefing page can surface a banner with retry.
            tx.execute(
                "UPDATE briefing_projection
                 SET is_generating = 0,
                     generation_kind = NULL,
                     last_generation_error = ?1,
                     updated_at = ?2
                 WHERE id = ?3",
                params![p.reason, event.created_at, event.aggregate_id],
            )?;
        }
        "BriefingGenerationCancelled" => {
            // Distinct from `BriefingCancelled` (which terminates the whole
            // briefing): this only ends the current attempt. The briefing
            // remains `active`, ready for another start.
            tx.execute(
                "UPDATE briefing_projection
                 SET is_generating = 0,
                     generation_kind = NULL,
                     last_generation_error = NULL,
                     updated_at = ?1
                 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "BriefingDraftEdited" => {
            let p: BriefingDraftEditedPayload = serde_json::from_str(&event.payload)?;
            // Replace pending edits with the latest snapshot. The frontend sends a
            // complete BriefingEdits each time so the projection mirrors current state
            // without us having to merge.
            tx.execute(
                "UPDATE briefing_projection
                 SET pending_edits_json = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![p.edits.to_string(), event.created_at, event.aggregate_id],
            )?;
        }
        "BriefingPushedBack" => {
            // Pushbacks are recorded in the event log for the audit trail; the projection
            // only needs to bump updated_at because pending_edits_json (also stamped by
            // the most recent BriefingDraftEdited) is what the UI/refine step consumes.
            let _: BriefingPushedBackPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE briefing_projection SET updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "BriefingRefineRequested" => {
            tx.execute(
                "UPDATE briefing_projection SET updated_at = ?1 WHERE id = ?2",
                params![event.created_at, event.aggregate_id],
            )?;
        }
        "BriefingCompleted" => {
            let p: BriefingCompletedPayload = serde_json::from_str(&event.payload)?;
            tx.execute(
                "UPDATE briefing_projection
                 SET status = 'completed', final_plan_id = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![p.plan_id, event.created_at, event.aggregate_id],
            )?;
        }
        "BriefingCancelled" => {
            let p: BriefingCancelledPayload = serde_json::from_str(&event.payload)?;
            // Hard terminal: also drop in-flight flags so the chrome indicator
            // doesn't keep counting a generation that's been killed alongside
            // the briefing itself.
            tx.execute(
                "UPDATE briefing_projection
                 SET status = 'cancelled',
                     cancel_reason = ?1,
                     is_generating = 0,
                     generation_kind = NULL,
                     updated_at = ?2
                 WHERE id = ?3",
                params![p.reason, event.created_at, event.aggregate_id],
            )?;
        }
        other => return Err(ProjectionError::UnknownEventType(other.to_string())),
    }
    Ok(())
}

const BRIEFING_COLUMNS: &str = "id, workspace_id, status, initial_description, provider, model, current_draft_json, pending_edits_json, validation_results_json, generation_count, is_generating, generation_kind, last_generation_error, final_plan_id, cancel_reason, created_at, updated_at";

fn read_briefing(r: &rusqlite::Row) -> rusqlite::Result<BriefingProjection> {
    let current_draft_str: Option<String> = r.get(6)?;
    let pending_edits_str: Option<String> = r.get(7)?;
    let validation_results_str: Option<String> = r.get(8)?;
    let is_generating_int: i64 = r.get(10)?;
    Ok(BriefingProjection {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        status: r.get(2)?,
        initial_description: r.get(3)?,
        provider: r.get(4)?,
        model: r.get(5)?,
        current_draft: current_draft_str
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
        pending_edits: pending_edits_str
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
        validation_results: validation_results_str
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
        generation_count: r.get(9)?,
        is_generating: is_generating_int != 0,
        generation_kind: r.get(11)?,
        last_generation_error: r.get(12)?,
        final_plan_id: r.get(13)?,
        cancel_reason: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
    })
}

pub fn get_briefing(conn: &Connection, id: &str) -> rusqlite::Result<Option<BriefingProjection>> {
    let sql = format!("SELECT {BRIEFING_COLUMNS} FROM briefing_projection WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    if let Some(r) = rows.next()? {
        Ok(Some(read_briefing(r)?))
    } else {
        Ok(None)
    }
}

pub fn list_active_briefings(
    conn: &Connection,
    workspace_id: &str,
) -> rusqlite::Result<Vec<BriefingProjection>> {
    let sql = format!(
        "SELECT {BRIEFING_COLUMNS} FROM briefing_projection
         WHERE workspace_id = ?1 AND status = 'active'
         ORDER BY updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![workspace_id], read_briefing)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// All briefings currently flagged `is_generating = 1` for this workspace.
/// Used by the restart-recovery sweep on workspace activation: any row in
/// this list with no matching live in-memory entry is stale (the previous
/// process died mid-generation) and gets a synthetic
/// `BriefingGenerationFailed` so the UI clears the spinner.
pub fn list_generating_briefings(
    conn: &Connection,
    workspace_id: &str,
) -> rusqlite::Result<Vec<BriefingProjection>> {
    let sql = format!(
        "SELECT {BRIEFING_COLUMNS} FROM briefing_projection
         WHERE workspace_id = ?1 AND is_generating = 1
         ORDER BY updated_at ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![workspace_id], read_briefing)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::schema::apply_events_ddl;
    use crate::events::types::AppendedEvent;
    use rusqlite::Connection;
    use serde_json::json;

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

        let attempt = latest_merge_attempt_for_task(&conn, "task1")
            .unwrap()
            .unwrap();
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
    fn task_phase_config_changed_updates_only_named_phase() {
        let mut conn = db();
        // Seed the task with a non-empty phase_config containing entries for both
        // implementer and auditor — so we can verify the applier doesn't overwrite
        // the auditor entry when the user edits the implementer.
        conn.execute(
            "UPDATE task_projection
             SET phase_config = ?1, current_phase_config = ?1
             WHERE id = 'task1'",
            [r#"{
                "phases": ["implementer", "auditor"],
                "gate_overrides": null,
                "models": {
                    "implementer": {"provider": "claude", "model": "old-impl-model"},
                    "auditor": {"provider": "claude", "model": "auditor-model"}
                },
                "permission_modes": {
                    "implementer": "acceptEdits",
                    "auditor": "plan"
                }
            }"#],
        )
        .unwrap();

        let tx = conn.transaction().unwrap();
        let ev = task_event(
            1,
            "TaskPhaseConfigChanged",
            serde_json::json!({
                "phase": "implementer",
                "provider": "claude",
                "model": "new-impl-model",
                "permission_mode": "bypassPermissions",
            }),
        );
        apply_task_event(&tx, &ev).unwrap();
        tx.commit().unwrap();

        let task = get_task(&conn, "task1").unwrap().unwrap();
        let current = &task.current_phase_config;
        // Implementer entry was replaced.
        assert_eq!(
            current["models"]["implementer"]["model"].as_str(),
            Some("new-impl-model"),
        );
        assert_eq!(
            current["permission_modes"]["implementer"].as_str(),
            Some("bypassPermissions"),
        );
        // Auditor entry untouched.
        assert_eq!(
            current["models"]["auditor"]["model"].as_str(),
            Some("auditor-model"),
        );
        assert_eq!(
            current["permission_modes"]["auditor"].as_str(),
            Some("plan"),
        );
        // The original snapshot is preserved verbatim.
        assert_eq!(
            task.phase_config["models"]["implementer"]["model"].as_str(),
            Some("old-impl-model"),
        );
    }

    #[test]
    fn task_phase_config_changed_with_nulls_reverts_named_phase() {
        let mut conn = db();
        conn.execute(
            "UPDATE task_projection
             SET phase_config = ?1, current_phase_config = ?1
             WHERE id = 'task1'",
            [r#"{
                "phases": ["implementer", "auditor"],
                "gate_overrides": null,
                "models": {
                    "implementer": {"provider": "claude", "model": "custom"},
                    "auditor": {"provider": "claude", "model": "auditor-model"}
                },
                "permission_modes": {
                    "implementer": "bypassPermissions",
                    "auditor": "plan"
                }
            }"#],
        )
        .unwrap();

        let tx = conn.transaction().unwrap();
        let ev = task_event(
            1,
            "TaskPhaseConfigChanged",
            serde_json::json!({
                "phase": "implementer",
                "provider": serde_json::Value::Null,
                "model": serde_json::Value::Null,
                "permission_mode": serde_json::Value::Null,
            }),
        );
        apply_task_event(&tx, &ev).unwrap();
        tx.commit().unwrap();

        let task = get_task(&conn, "task1").unwrap().unwrap();
        let current = &task.current_phase_config;
        // Implementer per-phase entries removed entirely; resolver will fall through
        // to the workspace default.
        assert!(current["models"].get("implementer").is_none());
        assert!(current["permission_modes"].get("implementer").is_none());
        // Auditor untouched.
        assert_eq!(
            current["models"]["auditor"]["model"].as_str(),
            Some("auditor-model"),
        );
    }

    #[test]
    fn task_created_initializes_current_phase_config_equal_to_phase_config() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::events::schema::apply_events_ddl(&conn).unwrap();
        apply_workspace_db_projection_ddl(&conn).unwrap();
        // Seed a fresh plan (without a pre-existing task — we want to exercise the
        // TaskCreated applier directly).
        conn.execute(
            "INSERT INTO plan_projection
                (id, workspace_id, title, description, source, source_metadata, status,
                 task_count, running_task_count, done_task_count, failed_task_count,
                 created_at, updated_at)
             VALUES ('p1', 'ws', 't', '', 'manual', NULL, 'active', 0, 0, 0, 0, 0, 0)",
            [],
        )
        .unwrap();

        let tx = conn.transaction().unwrap();
        let ev = AppendedEvent {
            id: "ev1".into(),
            aggregate_type: "task".into(),
            aggregate_id: "task_new".into(),
            seq: 1,
            event_type: "TaskCreated".into(),
            version: 3,
            payload: serde_json::json!({
                "plan_id": "p1",
                "title": "demo",
                "spec_markdown": "",
                "phase_config": {
                    "phases": ["implementer", "auditor"],
                    "gate_overrides": null,
                    "models": {
                        "implementer": {"provider": "claude", "model": "sonnet"}
                    },
                    "permission_modes": null
                }
            })
            .to_string(),
            metadata: "{}".into(),
            created_at: 0,
        };
        apply_task_event(&tx, &ev).unwrap();
        tx.commit().unwrap();

        let task = get_task(&conn, "task_new").unwrap().unwrap();
        assert_eq!(task.phase_config, task.current_phase_config);
        assert_eq!(
            task.current_phase_config["models"]["implementer"]["model"].as_str(),
            Some("sonnet"),
        );
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

    // ------------------------------------------------------------------------
    // Briefing background-generation projection tests.
    // ------------------------------------------------------------------------

    fn briefing_event(seq: i64, event_type: &str, payload: serde_json::Value) -> AppendedEvent {
        AppendedEvent {
            id: format!("bev_{seq}"),
            aggregate_type: "briefing".into(),
            aggregate_id: "brf1".into(),
            seq,
            event_type: event_type.into(),
            version: 1,
            payload: payload.to_string(),
            metadata: "{}".into(),
            created_at: 100 * seq,
        }
    }

    fn apply_briefing_in_tx(conn: &mut Connection, ev: &AppendedEvent) {
        let tx = conn.transaction().unwrap();
        apply_briefing_event(&tx, ev).unwrap();
        tx.commit().unwrap();
    }

    fn seed_briefing(conn: &mut Connection) {
        apply_briefing_in_tx(
            conn,
            &briefing_event(
                1,
                "BriefingStarted",
                json!({
                    "workspace_id": "ws",
                    "initial_description": "ship it",
                    "provider": "claude",
                    "model": "sonnet",
                }),
            ),
        );
    }

    #[test]
    fn generation_started_flips_in_flight_flags() {
        let mut conn = db();
        seed_briefing(&mut conn);

        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(2, "BriefingGenerationStarted", json!({"kind": "initial"})),
        );

        let b = get_briefing(&conn, "brf1").unwrap().unwrap();
        assert!(b.is_generating);
        assert_eq!(b.generation_kind.as_deref(), Some("initial"));
        assert_eq!(b.last_generation_error, None);
        assert_eq!(b.generation_count, 0); // not incremented until DraftProduced
    }

    #[test]
    fn generation_started_clears_prior_failure() {
        let mut conn = db();
        seed_briefing(&mut conn);
        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(
                2,
                "BriefingGenerationFailed",
                json!({"reason": "subprocess died"}),
            ),
        );
        let b = get_briefing(&conn, "brf1").unwrap().unwrap();
        assert_eq!(b.last_generation_error.as_deref(), Some("subprocess died"));

        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(3, "BriefingGenerationStarted", json!({"kind": "refine"})),
        );

        let b = get_briefing(&conn, "brf1").unwrap().unwrap();
        assert!(b.is_generating);
        assert_eq!(b.generation_kind.as_deref(), Some("refine"));
        assert_eq!(b.last_generation_error, None);
    }

    #[test]
    fn draft_produced_clears_in_flight_and_increments_count() {
        let mut conn = db();
        seed_briefing(&mut conn);
        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(2, "BriefingGenerationStarted", json!({"kind": "initial"})),
        );

        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(
                3,
                "BriefingDraftProduced",
                json!({
                    "draft": {"title": "x", "description": "y", "tasks": []},
                    "generation_index": 1,
                    "validation_results": [],
                }),
            ),
        );

        let b = get_briefing(&conn, "brf1").unwrap().unwrap();
        assert!(!b.is_generating);
        assert_eq!(b.generation_kind, None);
        assert_eq!(b.last_generation_error, None);
        assert_eq!(b.generation_count, 1);
    }

    #[test]
    fn generation_failed_sets_error_and_clears_in_flight() {
        let mut conn = db();
        seed_briefing(&mut conn);
        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(2, "BriefingGenerationStarted", json!({"kind": "initial"})),
        );

        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(
                3,
                "BriefingGenerationFailed",
                json!({"reason": "model parse error"}),
            ),
        );

        let b = get_briefing(&conn, "brf1").unwrap().unwrap();
        assert!(!b.is_generating);
        assert_eq!(b.generation_kind, None);
        assert_eq!(
            b.last_generation_error.as_deref(),
            Some("model parse error")
        );
        assert_eq!(b.status, "active"); // briefing remains usable
    }

    #[test]
    fn generation_cancelled_clears_in_flight_without_error() {
        let mut conn = db();
        seed_briefing(&mut conn);
        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(2, "BriefingGenerationStarted", json!({"kind": "refine"})),
        );

        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(3, "BriefingGenerationCancelled", json!({})),
        );

        let b = get_briefing(&conn, "brf1").unwrap().unwrap();
        assert!(!b.is_generating);
        assert_eq!(b.generation_kind, None);
        // Cancelled is not a failure — no error banner.
        assert_eq!(b.last_generation_error, None);
        assert_eq!(b.status, "active");
    }

    #[test]
    fn briefing_cancelled_also_clears_in_flight() {
        let mut conn = db();
        seed_briefing(&mut conn);
        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(2, "BriefingGenerationStarted", json!({"kind": "initial"})),
        );

        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(3, "BriefingCancelled", json!({"reason": "user_cancelled"})),
        );

        let b = get_briefing(&conn, "brf1").unwrap().unwrap();
        assert!(!b.is_generating);
        assert_eq!(b.generation_kind, None);
        assert_eq!(b.status, "cancelled");
    }

    #[test]
    fn list_generating_briefings_filters_by_flag() {
        let mut conn = db();
        // Briefing 1: generating.
        seed_briefing(&mut conn);
        apply_briefing_in_tx(
            &mut conn,
            &briefing_event(2, "BriefingGenerationStarted", json!({"kind": "initial"})),
        );
        // Briefing 2: never generating.
        let mut ev2 = briefing_event(
            1,
            "BriefingStarted",
            json!({
                "workspace_id": "ws",
                "initial_description": "other",
                "provider": "claude",
                "model": "sonnet",
            }),
        );
        ev2.aggregate_id = "brf2".into();
        apply_briefing_in_tx(&mut conn, &ev2);

        let generating = list_generating_briefings(&conn, "ws").unwrap();
        assert_eq!(generating.len(), 1);
        assert_eq!(generating[0].id, "brf1");
    }
}
