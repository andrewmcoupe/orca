//! Task dependency graph: cycle detection, same-plan validation, and the
//! projection-level helpers that drive the `is_blocked` flag.
//!
//! Dependencies are declared on a Task aggregate via `TaskCreated.depends_on`
//! (set at creation) and mutated by `TaskDependenciesChanged` (user edits via
//! the UI). The Task aggregate owns the list; cycle detection runs at the
//! command layer so we reject bad inputs before the event ever lands.
//!
//! Cycles are checked by building the dependency graph from the workspace's
//! `task_projection` table, overlaying the proposed edges, and DFS-ing from
//! the candidate task. The graph is small (one workspace, dozens to low-
//! hundreds of tasks), so the naive in-memory walk is plenty fast and lets
//! us return the exact cycle path for the user-facing error message.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Serialize;
use thiserror::Error;

/// One task's worth of dependency-graph data. Loaded in bulk by
/// [`load_workspace_graph`] and consulted by both the cycle check and
/// the same-plan validator.
#[derive(Debug, Clone)]
struct TaskNode {
    plan_id: String,
    status: String,
    depends_on: Vec<String>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "details")]
pub enum DependencyError {
    /// A `task_id` referenced by a `depends_on` declaration doesn't exist in
    /// the workspace. We list the missing IDs verbatim so the UI can call
    /// out exactly which references are broken.
    #[error("dependency task not found: {0:?}")]
    NotFound(Vec<String>),

    /// Same-plan rule violation: at least one referenced task lives in a
    /// different plan from the task being edited. Cross-plan dependencies
    /// are deferred per the v1 brief — single-plan keeps the queue manager's
    /// invariants simple.
    #[error("dependencies must be within the same plan as the task")]
    CrossPlan {
        offending_task_ids: Vec<String>,
        own_plan_id: String,
    },

    /// Direct or indirect cycle. The path is given oldest→newest, ending
    /// with the node that closes the loop (the `task_id` we DFS-d from).
    #[error("dependency cycle: {}", .path.join(" → "))]
    Cycle { path: Vec<String> },

    /// A task can't depend on itself.
    #[error("a task cannot depend on itself")]
    SelfDependency,

    /// Duplicate IDs in the same `depends_on` list — surfaced as a
    /// validation error rather than silently de-duped, because the UI
    /// shouldn't be producing them.
    #[error("duplicate dependency ids: {0:?}")]
    Duplicate(Vec<String>),

    /// Underlying database error. Thiserror's transparent passthrough so
    /// the caller gets a useful message rather than a generic wrapper.
    #[error("database error: {0}")]
    Db(String),
}

impl From<rusqlite::Error> for DependencyError {
    fn from(e: rusqlite::Error) -> Self {
        DependencyError::Db(e.to_string())
    }
}

/// Scan the workspace's `task_projection` for dependency-graph data.
/// `task_id`'s own row is included in the map so callers (including the
/// cycle check) can read its own `plan_id` without a second query.
fn load_workspace_graph(conn: &Connection) -> Result<HashMap<String, TaskNode>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, plan_id, status, depends_on FROM task_projection",
    )?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        let plan_id: String = r.get(1)?;
        let status: String = r.get(2)?;
        let depends_on_str: String = r.get(3)?;
        Ok((id, plan_id, status, depends_on_str))
    })?;
    let mut out = HashMap::new();
    for r in rows {
        let (id, plan_id, status, deps_str) = r?;
        let deps: Vec<String> = serde_json::from_str(&deps_str).unwrap_or_default();
        out.insert(
            id,
            TaskNode {
                plan_id,
                status,
                depends_on: deps,
            },
        );
    }
    Ok(out)
}

/// Detect a cycle by DFS. We walk forward along `depends_on` edges starting
/// from `start`. The brief's wording is "DFS from `task_id`; if we reach
/// `task_id` again, return the cycle path." Note this only catches cycles
/// that *include* `start`; that's exactly what we want, because the rest
/// of the graph is the existing committed state which is invariant-by-
/// induction (every prior `update_task_dependencies` ran the same check).
///
/// Returns the path [start, …, start] when a cycle is found. Returns
/// `None` when none reachable cycle exists.
fn find_cycle(
    graph: &HashMap<String, Vec<String>>,
    start: &str,
) -> Option<Vec<String>> {
    let mut stack: Vec<(String, usize)> = vec![(start.to_string(), 0)];
    let mut path: Vec<String> = vec![start.to_string()];
    let mut on_path: HashSet<String> = HashSet::new();
    on_path.insert(start.to_string());

    while let Some((node, idx)) = stack.last().cloned() {
        let neighbours = graph.get(&node).cloned().unwrap_or_default();
        if idx >= neighbours.len() {
            // Done with this node; backtrack.
            stack.pop();
            path.pop();
            on_path.remove(&node);
            if let Some(last) = stack.last_mut() {
                last.1 += 1;
            }
            continue;
        }
        let next = neighbours[idx].clone();
        if next == start {
            // Closed the loop back to where we started.
            let mut cycle = path.clone();
            cycle.push(start.to_string());
            return Some(cycle);
        }
        if on_path.contains(&next) {
            // Stumbled onto a node that's currently on our DFS path but
            // isn't `start`. That's a cycle in the existing graph — not
            // one we caused, but report it anyway so the user can fix it
            // rather than silently accepting an invalid graph. Build the
            // sub-path that closes the loop.
            let mut cycle = path
                .iter()
                .cloned()
                .skip_while(|n| n != &next)
                .collect::<Vec<_>>();
            cycle.push(next);
            return Some(cycle);
        }
        // Descend.
        stack.push((next.clone(), 0));
        path.push(next.clone());
        on_path.insert(next);
    }
    None
}

/// Validate a proposed `depends_on` for `task_id`. Runs the same checks
/// for both `create_task` and `update_task_dependencies`:
///
/// 1. No `task_id` in its own list (self-loop).
/// 2. No duplicate ids in the proposed list.
/// 3. Every referenced id exists in the workspace.
/// 4. Every referenced id is in the same plan.
/// 5. The proposed edges introduce no cycle.
///
/// `task_id` doesn't need to already exist for `create_task` (the row
/// won't be there yet). The graph load excludes it; we add a synthetic
/// node with the proposed edges before running the cycle check.
pub fn validate_dependencies(
    conn: &Connection,
    task_id: &str,
    own_plan_id: &str,
    proposed_deps: &[String],
) -> Result<(), DependencyError> {
    if proposed_deps.iter().any(|id| id == task_id) {
        return Err(DependencyError::SelfDependency);
    }

    // Duplicate detection. Brief says reject rather than dedupe; UI should
    // never produce these so a hard error surfaces the bug clearly.
    let mut seen = HashSet::new();
    let dups: Vec<String> = proposed_deps
        .iter()
        .filter(|id| !seen.insert((*id).clone()))
        .cloned()
        .collect();
    if !dups.is_empty() {
        return Err(DependencyError::Duplicate(dups));
    }

    let graph = load_workspace_graph(conn)?;

    // Existence + same-plan checks happen against the *workspace* projection,
    // not the brief's "same plan" narrowing — we want to report missing IDs
    // distinctly from cross-plan IDs.
    let mut missing = Vec::new();
    let mut cross_plan = Vec::new();
    for dep in proposed_deps {
        match graph.get(dep) {
            None => missing.push(dep.clone()),
            Some(node) if node.plan_id != own_plan_id => cross_plan.push(dep.clone()),
            _ => {}
        }
    }
    if !missing.is_empty() {
        return Err(DependencyError::NotFound(missing));
    }
    if !cross_plan.is_empty() {
        return Err(DependencyError::CrossPlan {
            offending_task_ids: cross_plan,
            own_plan_id: own_plan_id.to_string(),
        });
    }

    // Build adjacency map and overlay the proposed edges on `task_id`.
    // (We replace, not extend — TaskDependenciesChanged is a wholesale
    // replacement.)
    let mut adj: HashMap<String, Vec<String>> = graph
        .iter()
        .map(|(k, v)| (k.clone(), v.depends_on.clone()))
        .collect();
    adj.insert(task_id.to_string(), proposed_deps.to_vec());

    if let Some(path) = find_cycle(&adj, task_id) {
        return Err(DependencyError::Cycle { path });
    }
    Ok(())
}

/// Compute whether a task with the given `depends_on` list is currently
/// blocked. A task is blocked when any dependency hasn't reached `merged`
/// — terminal-but-not-merged states (`cancelled`, `archived`) count as
/// blocking, since the dependent's premise is "the dependency's output
/// landed on the target branch." If the user wants to ignore a cancelled
/// dependency they can edit the deps list to remove it.
///
/// Returns `Ok(false)` when `depends_on` is empty — the common, fast path.
pub fn compute_is_blocked(
    conn: &Connection,
    depends_on: &[String],
) -> Result<bool, rusqlite::Error> {
    if depends_on.is_empty() {
        return Ok(false);
    }
    // Build a `?,?,?` placeholder list. `IN (?)` won't accept a slice in
    // rusqlite without `array` bundle; we'd rather not depend on that.
    let placeholders = std::iter::repeat("?")
        .take(depends_on.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT COUNT(*) FROM task_projection
         WHERE id IN ({placeholders}) AND status = 'merged'"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> =
        depends_on.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let merged_count: i64 = stmt.query_row(params_vec.as_slice(), |r| r.get(0))?;
    Ok((merged_count as usize) < depends_on.len())
}

/// Look up the task IDs (in the same workspace) whose `depends_on`
/// includes `merged_task_id` AND whose own dependencies are *all* in
/// `merged` state — i.e. they're now fully unblocked. Used by the queue
/// manager hook to decide which queued tasks to auto-start after a merge.
///
/// The same query also returns the task's `is_queued` flag so the caller
/// can decide whether to dispatch (queued + unblocked) or just clear the
/// blocked flag (un-queued + unblocked).
pub fn find_newly_unblocked(
    conn: &Connection,
    workspace_id: &str,
    merged_task_id: &str,
) -> Result<Vec<UnblockedTask>, rusqlite::Error> {
    // First pass: every task in the workspace that lists `merged_task_id`
    // as a dependency. JSON1's `json_each` would let us push the test into
    // SQL, but we can't rely on JSON1 being compiled in across all SQLite
    // builds. The graph is small; filter in Rust.
    let mut stmt = conn.prepare(
        "SELECT id, depends_on, is_queued, status
         FROM task_projection
         WHERE workspace_id = ?1",
    )?;
    let rows = stmt.query_map(params![workspace_id], |r| {
        let id: String = r.get(0)?;
        let deps_str: String = r.get(1)?;
        let is_queued: i64 = r.get(2)?;
        let status: String = r.get(3)?;
        Ok((id, deps_str, is_queued != 0, status))
    })?;

    let mut all_tasks: HashMap<String, (Vec<String>, bool, String)> = HashMap::new();
    for r in rows {
        let (id, deps_str, is_queued, status) = r?;
        let deps: Vec<String> = serde_json::from_str(&deps_str).unwrap_or_default();
        all_tasks.insert(id, (deps, is_queued, status));
    }

    let mut out = Vec::new();
    for (id, (deps, is_queued, status)) in &all_tasks {
        if !deps.iter().any(|d| d == merged_task_id) {
            continue;
        }
        // Skip terminal-state tasks — auto-starting a cancelled/merged/archived
        // task would be incorrect. The brief defines unblocking only for
        // active tasks that the user has actually queued.
        if matches!(status.as_str(), "cancelled" | "merged" | "archived") {
            continue;
        }
        // All deps merged?
        let all_merged = deps.iter().all(|d| {
            all_tasks
                .get(d)
                .map(|(_, _, s)| s == "merged")
                .unwrap_or(false)
        });
        if !all_merged {
            continue;
        }
        out.push(UnblockedTask {
            task_id: id.clone(),
            is_queued: *is_queued,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct UnblockedTask {
    pub task_id: String,
    pub is_queued: bool,
}

/// Compute the intersection of `relevant_files` paths between the starting
/// task and each currently in-flight task in the same workspace. "In-flight"
/// means the task has at least one phase run started but no terminal status
/// (cancelled/merged/archived) — we use the projection's `latest_phase_run_id`
/// + `phase_run_projection.status = 'running'` join.
///
/// Returns one entry per overlapping in-flight task; empty when no overlap
/// exists, which is the common case.
pub fn detect_file_overlap(
    conn: &Connection,
    starting_task_id: &str,
    workspace_id: &str,
) -> Result<Vec<FileOverlap>, rusqlite::Error> {
    // Pull starting task's relevant_files. If the task has none, no possible
    // overlap — return empty fast.
    let starting_files: Vec<String> = {
        let s: Option<String> = conn
            .query_row(
                "SELECT relevant_files FROM task_projection WHERE id = ?1",
                params![starting_task_id],
                |r| r.get(0),
            )
            .ok();
        match s {
            Some(s) => paths_from_relevant_files(&s),
            None => return Ok(Vec::new()),
        }
    };
    if starting_files.is_empty() {
        return Ok(Vec::new());
    }
    let starting_set: HashSet<&String> = starting_files.iter().collect();

    // Candidate in-flight tasks: same workspace, not terminal, has a running
    // phase run. We deliberately don't include "scheduled-but-not-yet-started"
    // queued tasks — those don't write files yet so their relevant_files
    // can't conflict in real time.
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.relevant_files
         FROM task_projection t
         JOIN phase_run_projection pr ON pr.task_id = t.id AND pr.status = 'running'
         WHERE t.workspace_id = ?1
           AND t.id <> ?2
           AND t.status NOT IN ('cancelled', 'merged', 'archived')",
    )?;
    let rows = stmt.query_map(params![workspace_id, starting_task_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;

    let mut by_task: HashMap<String, (String, Vec<String>)> = HashMap::new();
    for r in rows {
        let (id, title, files_json) = r?;
        let files = paths_from_relevant_files(&files_json);
        // A task may have multiple running phase runs (rare, but possible
        // mid-handoff). The projection JOIN can produce duplicate rows;
        // collapse on task_id.
        by_task.entry(id).or_insert((title, files));
    }

    let mut out = Vec::new();
    for (other_id, (other_title, other_files)) in by_task {
        let overlap: Vec<String> = other_files
            .into_iter()
            .filter(|p| starting_set.contains(p))
            .collect();
        if overlap.is_empty() {
            continue;
        }
        out.push(FileOverlap {
            other_task_id: other_id,
            other_task_title: other_title,
            overlapping_files: overlap,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct FileOverlap {
    pub other_task_id: String,
    pub other_task_title: String,
    pub overlapping_files: Vec<String>,
}

/// Pull the `path` field out of each `RelevantFile` in a stored JSON array.
/// Tolerant: silently returns empty on parse failure (the column stores
/// well-formed JSON in normal operation; if it doesn't, the worst that
/// happens is we miss an overlap warning, which the user can override).
fn paths_from_relevant_files(json: &str) -> Vec<String> {
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match value.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|item| {
            item.get("path")
                .and_then(|p| p.as_str())
                .map(|s| s.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph_from(edges: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        edges
            .iter()
            .map(|(node, neighbours)| {
                (
                    (*node).to_string(),
                    neighbours.iter().map(|s| (*s).to_string()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn no_cycle_in_a_dag() {
        // a -> b -> c
        let g = graph_from(&[("a", &["b"]), ("b", &["c"]), ("c", &[])]);
        assert!(find_cycle(&g, "a").is_none());
    }

    #[test]
    fn detects_self_loop() {
        let g = graph_from(&[("a", &["a"])]);
        let cycle = find_cycle(&g, "a").unwrap();
        assert_eq!(cycle, vec!["a", "a"]);
    }

    #[test]
    fn detects_direct_two_node_cycle() {
        // a <-> b
        let g = graph_from(&[("a", &["b"]), ("b", &["a"])]);
        let cycle = find_cycle(&g, "a").unwrap();
        assert_eq!(cycle.first().unwrap(), "a");
        assert_eq!(cycle.last().unwrap(), "a");
        // Path includes both nodes plus the closing repeat.
        assert!(cycle.contains(&"b".to_string()));
    }

    #[test]
    fn detects_indirect_cycle() {
        // a -> b -> c -> a
        let g = graph_from(&[("a", &["b"]), ("b", &["c"]), ("c", &["a"])]);
        let cycle = find_cycle(&g, "a").unwrap();
        assert_eq!(cycle.first().unwrap(), "a");
        assert_eq!(cycle.last().unwrap(), "a");
    }

    #[test]
    fn diamond_dag_is_not_a_cycle() {
        // a -> b, a -> c, b -> d, c -> d  — classic diamond, no cycle
        let g = graph_from(&[
            ("a", &["b", "c"]),
            ("b", &["d"]),
            ("c", &["d"]),
            ("d", &[]),
        ]);
        assert!(find_cycle(&g, "a").is_none());
    }

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE task_projection (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                depends_on TEXT NOT NULL DEFAULT '[]',
                is_queued INTEGER NOT NULL DEFAULT 0,
                relevant_files TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE phase_run_projection (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                status TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn insert_task(
        conn: &Connection,
        id: &str,
        plan_id: &str,
        status: &str,
        deps: &[&str],
    ) {
        let deps_json = serde_json::to_string(&deps).unwrap();
        conn.execute(
            "INSERT INTO task_projection (id, workspace_id, plan_id, status, depends_on)
             VALUES (?1, 'ws1', ?2, ?3, ?4)",
            params![id, plan_id, status, deps_json],
        )
        .unwrap();
    }

    #[test]
    fn validate_rejects_self_dependency() {
        let conn = setup_db();
        insert_task(&conn, "t1", "p1", "created", &[]);
        let err = validate_dependencies(&conn, "t1", "p1", &["t1".into()]).unwrap_err();
        assert!(matches!(err, DependencyError::SelfDependency));
    }

    #[test]
    fn validate_rejects_duplicate_deps() {
        let conn = setup_db();
        insert_task(&conn, "t1", "p1", "created", &[]);
        insert_task(&conn, "t2", "p1", "created", &[]);
        let err = validate_dependencies(
            &conn,
            "t1",
            "p1",
            &["t2".into(), "t2".into()],
        )
        .unwrap_err();
        assert!(matches!(err, DependencyError::Duplicate(_)));
    }

    #[test]
    fn validate_rejects_missing_dep() {
        let conn = setup_db();
        insert_task(&conn, "t1", "p1", "created", &[]);
        let err =
            validate_dependencies(&conn, "t1", "p1", &["ghost".into()]).unwrap_err();
        match err {
            DependencyError::NotFound(missing) => assert_eq!(missing, vec!["ghost"]),
            other => panic!("expected NotFound, got {:?}", other),
        }
    }

    #[test]
    fn validate_rejects_cross_plan_dep() {
        let conn = setup_db();
        insert_task(&conn, "t1", "p1", "created", &[]);
        insert_task(&conn, "t2", "p2", "created", &[]);
        let err =
            validate_dependencies(&conn, "t1", "p1", &["t2".into()]).unwrap_err();
        assert!(matches!(err, DependencyError::CrossPlan { .. }));
    }

    #[test]
    fn validate_rejects_indirect_cycle() {
        // existing graph: t2 -> t3 -> t1 (so t1 is depended on by t3)
        // proposed:       t1 -> t2 — creates cycle t1 -> t2 -> t3 -> t1
        let conn = setup_db();
        insert_task(&conn, "t1", "p1", "created", &[]);
        insert_task(&conn, "t2", "p1", "created", &["t3"]);
        insert_task(&conn, "t3", "p1", "created", &["t1"]);

        let err =
            validate_dependencies(&conn, "t1", "p1", &["t2".into()]).unwrap_err();
        match err {
            DependencyError::Cycle { path } => {
                assert_eq!(path.first().unwrap(), "t1");
                assert_eq!(path.last().unwrap(), "t1");
            }
            other => panic!("expected Cycle, got {:?}", other),
        }
    }

    #[test]
    fn validate_accepts_valid_dag() {
        let conn = setup_db();
        insert_task(&conn, "t1", "p1", "created", &[]);
        insert_task(&conn, "t2", "p1", "created", &[]);
        insert_task(&conn, "t3", "p1", "created", &[]);
        // t3 depends on t1 and t2 — a fan-in, perfectly valid.
        validate_dependencies(&conn, "t3", "p1", &["t1".into(), "t2".into()]).unwrap();
    }

    #[test]
    fn compute_is_blocked_empty_is_unblocked() {
        let conn = setup_db();
        assert!(!compute_is_blocked(&conn, &[]).unwrap());
    }

    #[test]
    fn compute_is_blocked_partial_merge() {
        let conn = setup_db();
        insert_task(&conn, "a", "p1", "merged", &[]);
        insert_task(&conn, "b", "p1", "created", &[]);
        // One merged, one not -> blocked.
        assert!(compute_is_blocked(&conn, &["a".into(), "b".into()]).unwrap());
    }

    #[test]
    fn compute_is_blocked_all_merged() {
        let conn = setup_db();
        insert_task(&conn, "a", "p1", "merged", &[]);
        insert_task(&conn, "b", "p1", "merged", &[]);
        assert!(!compute_is_blocked(&conn, &["a".into(), "b".into()]).unwrap());
    }

    #[test]
    fn compute_is_blocked_cancelled_dep_blocks() {
        // A cancelled dep never produces output, so the dependent stays
        // blocked. The user resolves by editing the deps list.
        let conn = setup_db();
        insert_task(&conn, "a", "p1", "cancelled", &[]);
        assert!(compute_is_blocked(&conn, &["a".into()]).unwrap());
    }

    #[test]
    fn newly_unblocked_only_when_all_deps_merged() {
        let conn = setup_db();
        // t1 depends on t2 + t3; both merged -> t1 is unblocked.
        insert_task(&conn, "t2", "p1", "merged", &[]);
        insert_task(&conn, "t3", "p1", "merged", &[]);
        conn.execute(
            "INSERT INTO task_projection (id, workspace_id, plan_id, status, depends_on, is_queued)
             VALUES ('t1', 'ws1', 'p1', 'created', '[\"t2\",\"t3\"]', 1)",
            [],
        )
        .unwrap();
        let unblocked = find_newly_unblocked(&conn, "ws1", "t3").unwrap();
        assert_eq!(unblocked.len(), 1);
        assert_eq!(unblocked[0].task_id, "t1");
        assert!(unblocked[0].is_queued);
    }

    #[test]
    fn newly_unblocked_skips_when_other_dep_unmerged() {
        let conn = setup_db();
        insert_task(&conn, "t2", "p1", "merged", &[]);
        insert_task(&conn, "t3", "p1", "created", &[]);
        conn.execute(
            "INSERT INTO task_projection (id, workspace_id, plan_id, status, depends_on, is_queued)
             VALUES ('t1', 'ws1', 'p1', 'created', '[\"t2\",\"t3\"]', 1)",
            [],
        )
        .unwrap();
        let unblocked = find_newly_unblocked(&conn, "ws1", "t2").unwrap();
        assert!(unblocked.is_empty(), "t3 hasn't merged so t1 stays blocked");
    }

    #[test]
    fn detect_file_overlap_finds_running_overlap() {
        let conn = setup_db();
        // Starting task: t1 with files a.rs, b.rs
        conn.execute(
            "INSERT INTO task_projection (id, workspace_id, plan_id, status, relevant_files)
             VALUES ('t1', 'ws1', 'p1', 'created', ?)",
            params![r#"[{"path":"a.rs","certainty":"Confirmed","reason":""},{"path":"b.rs","certainty":"Candidate","reason":""}]"#],
        )
        .unwrap();
        // In-flight task t2 touching b.rs and c.rs
        conn.execute(
            "INSERT INTO task_projection (id, workspace_id, plan_id, status, relevant_files)
             VALUES ('t2', 'ws1', 'p1', 'created', ?)",
            params![r#"[{"path":"b.rs","certainty":"Confirmed","reason":""},{"path":"c.rs","certainty":"Candidate","reason":""}]"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO phase_run_projection (id, task_id, status)
             VALUES ('pr1', 't2', 'running')",
            [],
        )
        .unwrap();
        let overlaps = detect_file_overlap(&conn, "t1", "ws1").unwrap();
        assert_eq!(overlaps.len(), 1);
        assert_eq!(overlaps[0].other_task_id, "t2");
        assert_eq!(overlaps[0].overlapping_files, vec!["b.rs"]);
    }

    #[test]
    fn detect_file_overlap_ignores_non_running_phase_runs() {
        let conn = setup_db();
        conn.execute(
            "INSERT INTO task_projection (id, workspace_id, plan_id, status, relevant_files)
             VALUES ('t1', 'ws1', 'p1', 'created', ?)",
            params![r#"[{"path":"a.rs","certainty":"Confirmed","reason":""}]"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_projection (id, workspace_id, plan_id, status, relevant_files)
             VALUES ('t2', 'ws1', 'p1', 'created', ?)",
            params![r#"[{"path":"a.rs","certainty":"Confirmed","reason":""}]"#],
        )
        .unwrap();
        // Phase run is completed, not running — shouldn't surface as overlap.
        conn.execute(
            "INSERT INTO phase_run_projection (id, task_id, status)
             VALUES ('pr1', 't2', 'completed')",
            [],
        )
        .unwrap();
        let overlaps = detect_file_overlap(&conn, "t1", "ws1").unwrap();
        assert!(overlaps.is_empty());
    }
}
