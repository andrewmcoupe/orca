//! Per-task diff cache + Tauri command handlers.
//!
//! The cache is keyed on `task_id` and validated against `head_commit`. When the
//! caller asks for a task's diff, we compute the structured diff (cheap — git2 in
//! memory) and check whether the cached entry's head commit matches; if so, we
//! return the cached *highlighted* diff (which is the expensive part to produce).
//! Otherwise we re-highlight and replace the entry.
//!
//! Concerns are *not* cached — they're cheap to map and the verdict can change
//! independently of the head commit (e.g. when the auditor re-runs after a
//! pass-back). The mapping pass runs on every read.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::diff::{
    self, AuditorConcern, DiffSource, HighlightTheme, HighlightedTaskDiff, MappedConcern, TaskDiff,
    TaskDiffInputs,
};
use crate::events::projections;
use crate::ActiveWorkspaceState;

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CacheEntry {
    /// The head commit the cached highlight was produced from. We re-derive the
    /// current head commit on every read and only reuse the cache if it matches.
    head_commit: String,
    /// The theme the cached html was rendered for. Re-highlight on theme flip
    /// — html is theme-specific because syntect inlines colours into spans.
    theme: HighlightTheme,
    highlighted: HighlightedTaskDiff,
}

pub struct DiffCache(Mutex<HashMap<String, CacheEntry>>);

impl DiffCache {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    fn get(&self, task_id: &str) -> Option<CacheEntry> {
        self.0.lock().ok().and_then(|g| g.get(task_id).cloned())
    }

    fn put(&self, task_id: &str, entry: CacheEntry) {
        if let Ok(mut g) = self.0.lock() {
            g.insert(task_id.to_string(), entry);
        }
    }

    fn invalidate(&self, task_id: &str) {
        if let Ok(mut g) = self.0.lock() {
            g.remove(task_id);
        }
    }
}

// ---------------------------------------------------------------------------
// Wire types (returned over Tauri)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditorVerdictSummary {
    pub phase_run_id: String,
    pub verdict: String,
    pub confidence: f64,
    pub summary: String,
    pub criterion_mappings: serde_json::Value,
    pub unmapped_hunks: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDiffWithMappings {
    pub diff: HighlightedTaskDiff,
    /// Concerns from the *latest* auditor verdict, mapped onto this diff. Empty
    /// when there's no verdict yet.
    pub mapped_concerns: Vec<MappedConcern>,
    pub auditor_verdict: Option<AuditorVerdictSummary>,
    /// True when at least one phase_run for this task is currently `running`. The
    /// frontend uses this to drive the live indicator and the polling fallback.
    pub is_live: bool,
}

// ---------------------------------------------------------------------------
// Service entry points (callable from anywhere with ActiveWorkspace + cache)
// ---------------------------------------------------------------------------

fn build_inputs<'a>(
    repo_root: &'a Path,
    task_id: &'a str,
    task: &'a projections::TaskProjection,
    worktree_path_buf: &'a Option<PathBuf>,
) -> TaskDiffInputs<'a> {
    TaskDiffInputs {
        repo_root,
        task_id,
        task_base_commit: task
            .task_base_commit
            .as_deref()
            .or(task.worktree_base_commit.as_deref()),
        worktree_path: worktree_path_buf.as_deref(),
        merged_commit: task.merged_commit_sha.as_deref(),
    }
}

fn parse_concerns(raw: &serde_json::Value) -> Vec<AuditorConcern> {
    // The verdict event stores concerns as an arbitrary JSON array. Be liberal
    // about parsing — drop entries that don't fit the shape rather than failing
    // the whole call.
    raw.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<AuditorConcern>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn usable_worktree_path(path: &Path) -> bool {
    path.exists() && git2::Repository::open(path).is_ok()
}

fn task_is_live(conn: &rusqlite::Connection, task_id: &str) -> bool {
    projections::list_phase_runs_for_task(conn, task_id)
        .map(|runs| runs.iter().any(|r| r.status == "running"))
        .unwrap_or(false)
}

/// Compute (or fetch from cache) the highlighted diff and map the latest auditor
/// concerns onto it. `force_refresh` invalidates the cache before computing.
fn produce(
    cache: &DiffCache,
    workspace_path: &Path,
    task_id: &str,
    conn: &rusqlite::Connection,
    force_refresh: bool,
    theme: HighlightTheme,
) -> Result<TaskDiffWithMappings, String> {
    let task = projections::get_task(conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task not found: {}", task_id))?;

    // Derive the worktree path on disk (only if the projection still has one and
    // it actually exists — a stale `worktree_path` value is fine; the diff layer
    // checks `path.exists()` itself).
    let worktree_path_buf: Option<PathBuf> = task
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| usable_worktree_path(p));

    let inputs = build_inputs(workspace_path, task_id, &task, &worktree_path_buf);
    let diff: TaskDiff = diff::compute_task_diff(inputs).map_err(|e| e.to_string())?;

    if force_refresh {
        cache.invalidate(task_id);
    }

    // Reuse cached highlight when the head commit hasn't moved AND the theme is
    // the same (syntect inlines theme-specific colours into the HTML, so a flip
    // means the cache is no longer valid). `Unavailable` and missing-base diffs
    // have empty head_commit; we still cache them so we don't re-do the (cheap,
    // but pointless) work.
    let highlighted: HighlightedTaskDiff = match cache.get(task_id) {
        Some(entry)
            if entry.head_commit == diff.head_commit
                && !entry.head_commit.is_empty()
                && entry.theme == theme =>
        {
            entry.highlighted
        }
        _ => {
            let h = diff::highlight_diff(&diff, theme);
            cache.put(
                task_id,
                CacheEntry {
                    head_commit: diff.head_commit.clone(),
                    theme,
                    highlighted: h.clone(),
                },
            );
            h
        }
    };

    // Latest verdict + mapping. We always re-run the mapping against the freshly
    // computed structured diff (which we still have in `diff`), since the mapping
    // is per-line and would invalidate if we tried to keep it in the cache.
    let latest_verdict = projections::list_auditor_verdicts_for_task(conn, task_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .next();

    let (mapped_concerns, summary) = match latest_verdict {
        Some(v) => {
            let concerns = parse_concerns(&v.concerns);
            let mapped = diff::map_concerns_to_diff(&diff, &concerns);
            (
                mapped,
                Some(AuditorVerdictSummary {
                    phase_run_id: v.phase_run_id,
                    verdict: v.verdict,
                    confidence: v.confidence,
                    summary: v.summary,
                    criterion_mappings: v.criterion_mappings,
                    unmapped_hunks: v.unmapped_hunks,
                    created_at: v.created_at,
                }),
            )
        }
        None => (Vec::new(), None),
    };

    Ok(TaskDiffWithMappings {
        diff: highlighted,
        mapped_concerns,
        auditor_verdict: summary,
        is_live: task_is_live(conn, task_id),
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_task_diff(
    task_id: String,
    theme: String,
    active: State<'_, ActiveWorkspaceState>,
    cache: State<'_, DiffCache>,
) -> Result<TaskDiffWithMappings, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard
        .as_mut()
        .ok_or_else(|| "no active workspace".to_string())?;
    let workspace_path = PathBuf::from(&aw.path);
    produce(
        &cache,
        &workspace_path,
        &task_id,
        &aw.conn,
        false,
        HighlightTheme::from_str(&theme),
    )
}

#[tauri::command]
pub fn refresh_task_diff(
    task_id: String,
    theme: String,
    active: State<'_, ActiveWorkspaceState>,
    cache: State<'_, DiffCache>,
) -> Result<TaskDiffWithMappings, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard
        .as_mut()
        .ok_or_else(|| "no active workspace".to_string())?;
    let workspace_path = PathBuf::from(&aw.path);
    produce(
        &cache,
        &workspace_path,
        &task_id,
        &aw.conn,
        true,
        HighlightTheme::from_str(&theme),
    )
}

#[tauri::command]
pub fn get_unchanged_file_content(
    task_id: String,
    path: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<UnchangedFileContent, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard
        .as_mut()
        .ok_or_else(|| "no active workspace".to_string())?;
    let workspace_path = PathBuf::from(&aw.path);
    let task = projections::get_task(&aw.conn, &task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task not found: {}", task_id))?;

    let worktree_path_buf: Option<PathBuf> = task
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| usable_worktree_path(p));

    let inputs = build_inputs(&workspace_path, &task_id, &task, &worktree_path_buf);
    let diff = diff::compute_task_diff(inputs).map_err(|e| e.to_string())?;

    if matches!(diff.source, DiffSource::Unavailable { .. }) {
        return Err("diff is unavailable for this task".to_string());
    }

    let content =
        diff::read_file_at_head(&diff, &workspace_path, &path).map_err(|e| e.to_string())?;
    let language = diff::detect_language(&path);
    Ok(UnchangedFileContent {
        path,
        content,
        language,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnchangedFileContent {
    pub path: String,
    pub content: String,
    pub language: Option<String>,
}
