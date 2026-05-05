//! Local git merge primitives. All git work goes through `git2` — no shelling out.
//!
//! Flow: callers run [`analyze_merge`] first to get a non-destructive read of what would
//! happen (target/source SHAs, diff summary, conflicts, already-merged short circuit). If
//! the analysis is clean, they call [`execute_squash_merge`] or [`execute_merge_commit`],
//! which both re-validate the world before touching anything on disk.

use std::path::Path;

use git2::{
    BranchType, Commit, ErrorCode, MergeOptions, Oid, Repository, Signature, StatusOptions,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffSummary {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitSummary {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeAnalysis {
    pub target_branch: String,
    pub target_head_sha: String,
    pub source_branch: String,
    pub source_head_sha: String,
    /// Commits on `source_branch` that are not yet ancestors of the target — what this
    /// merge would actually contribute. Ordered oldest-to-newest.
    pub source_commits: Vec<CommitSummary>,
    pub diff_summary: DiffSummary,
    /// File paths that conflict between the merge base and the target. Empty means clean.
    pub conflicts: Vec<String>,
    /// True when the source is already an ancestor of the target — nothing to do.
    pub already_merged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutedMerge {
    pub commit_sha: String,
    pub target_branch: String,
    pub source_branch: String,
    /// Commits that existed on the source branch before the merge, ordered
    /// oldest-to-newest. Recorded so the audit trail can reconstruct what went in.
    pub parent_commits: Vec<String>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "details")]
pub enum MergeError {
    #[error("main worktree HEAD is detached; check out a branch before merging")]
    DetachedHead,

    #[error("main worktree has uncommitted changes ({} files)", dirty_files.len())]
    WorkingTreeDirty { dirty_files: Vec<String> },

    #[error("source branch not found: {0}")]
    SourceBranchMissing(String),

    #[error("target branch not found: {0}")]
    TargetBranchMissing(String),

    #[error("conflicts prevent merge: {} files conflict", conflicts.len())]
    Conflicts { conflicts: Vec<String> },

    #[error("source is already merged into target at {commit_sha}")]
    AlreadyMerged { commit_sha: String },

    #[error("git error: {0}")]
    GitError(String),

    #[error("internal error: {0}")]
    InternalError(String),
}

impl From<git2::Error> for MergeError {
    fn from(e: git2::Error) -> Self {
        MergeError::GitError(e.message().to_string())
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Inspect what a merge would do without writing anything to disk. Resolves the target
/// (HEAD of `repo_root`) and `source_branch`, then runs `git2`'s in-memory merge to
/// detect conflicts and summarize the diff. Detached HEAD on the target is treated as a
/// hard error here — callers can't pick a branch to merge into.
pub fn analyze_merge(repo_root: &Path, source_branch: &str) -> Result<MergeAnalysis, MergeError> {
    let repo = Repository::open(repo_root)?;
    let target_branch = current_branch_shorthand(&repo)?;
    let target_commit = head_commit(&repo)?;
    let source_commit = resolve_source_commit(&repo, source_branch)?;

    let target_head_sha = target_commit.id().to_string();
    let source_head_sha = source_commit.id().to_string();

    // Already-merged check: source is an ancestor of target.
    if repo.graph_descendant_of(target_commit.id(), source_commit.id())?
        || target_commit.id() == source_commit.id()
    {
        return Ok(MergeAnalysis {
            target_branch,
            target_head_sha,
            source_branch: source_branch.to_string(),
            source_head_sha,
            source_commits: Vec::new(),
            diff_summary: DiffSummary {
                files_changed: 0,
                insertions: 0,
                deletions: 0,
            },
            conflicts: Vec::new(),
            already_merged: true,
        });
    }

    let merge_base = repo.merge_base(target_commit.id(), source_commit.id()).ok();

    let source_commits = collect_source_commits(&repo, &source_commit, merge_base)?;
    let diff_summary = compute_diff_summary(&repo, merge_base, &source_commit)?;

    // In-memory merge to detect conflicts. `merge_commits` does not touch the working
    // tree or the index — it returns a fresh in-memory `Index`.
    let opts = MergeOptions::new();
    let merged_index = repo.merge_commits(&target_commit, &source_commit, Some(&opts))?;
    let conflicts = collect_conflicts(&merged_index)?;

    Ok(MergeAnalysis {
        target_branch,
        target_head_sha,
        source_branch: source_branch.to_string(),
        source_head_sha,
        source_commits,
        diff_summary,
        conflicts,
        already_merged: false,
    })
}

/// Squash-merge `source_branch` into the current branch of `repo_root`. The resulting
/// commit has a single parent (the target's HEAD) and the merged tree applied as a
/// single combined diff. Re-checks dirty / detached / conflicts inside this call —
/// don't trust an earlier analysis.
pub fn execute_squash_merge(
    repo_root: &Path,
    source_branch: &str,
    commit_message: &str,
) -> Result<ExecutedMerge, MergeError> {
    execute_merge_inner(repo_root, source_branch, commit_message, MergeKind::Squash)
}

/// Standard merge commit: produces a commit with two parents (target HEAD and source
/// HEAD). Same re-validation discipline as [`execute_squash_merge`].
pub fn execute_merge_commit(
    repo_root: &Path,
    source_branch: &str,
    commit_message: &str,
) -> Result<ExecutedMerge, MergeError> {
    execute_merge_inner(repo_root, source_branch, commit_message, MergeKind::Merge)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum MergeKind {
    Squash,
    Merge,
}

fn execute_merge_inner(
    repo_root: &Path,
    source_branch: &str,
    commit_message: &str,
    kind: MergeKind,
) -> Result<ExecutedMerge, MergeError> {
    let repo = Repository::open(repo_root)?;
    require_clean_worktree(&repo)?;

    let target_branch_name = current_branch_shorthand(&repo)?;
    let target_commit = head_commit(&repo)?;
    let source_commit = resolve_source_commit(&repo, source_branch)?;

    // Already-merged: don't fabricate a new commit; report the existing target SHA so
    // the caller can surface "already merged" cleanly.
    if repo.graph_descendant_of(target_commit.id(), source_commit.id())?
        || target_commit.id() == source_commit.id()
    {
        return Err(MergeError::AlreadyMerged {
            commit_sha: target_commit.id().to_string(),
        });
    }

    let merge_base = repo.merge_base(target_commit.id(), source_commit.id()).ok();

    let parent_commits = collect_source_commits(&repo, &source_commit, merge_base)?
        .into_iter()
        .map(|c| c.sha)
        .collect();

    // Build the merge tree in memory. If anything conflicts, bail before mutating disk.
    let opts = MergeOptions::new();
    let merged_index = repo.merge_commits(&target_commit, &source_commit, Some(&opts))?;
    let conflicts = collect_conflicts(&merged_index)?;
    if !conflicts.is_empty() {
        return Err(MergeError::Conflicts { conflicts });
    }

    // `Index::write_tree_to` requires a non-conflicted index, which we just verified.
    let mut writable_index = merged_index;
    let tree_oid = writable_index.write_tree_to(&repo)?;
    let tree = repo.find_tree(tree_oid)?;

    let signature = author_signature(&repo)?;
    let parents: Vec<&Commit> = match kind {
        MergeKind::Squash => vec![&target_commit],
        MergeKind::Merge => vec![&target_commit, &source_commit],
    };

    // Commit on the target branch ref directly so the branch advances atomically.
    let head_ref = repo.head()?;
    let ref_name = head_ref
        .name()
        .ok_or_else(|| MergeError::InternalError("HEAD reference has no name".into()))?
        .to_string();

    let new_oid = repo.commit(
        Some(&ref_name),
        &signature,
        &signature,
        commit_message,
        &tree,
        &parents,
    )?;

    // Update working tree + index to match the new commit. We use `force` because the
    // commit we just produced supersedes the previous HEAD's tree wholesale; we already
    // validated the worktree was clean above so there is nothing legitimate to clobber.
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    repo.checkout_head(Some(&mut checkout))?;

    Ok(ExecutedMerge {
        commit_sha: new_oid.to_string(),
        target_branch: target_branch_name,
        source_branch: source_branch.to_string(),
        parent_commits,
    })
}

fn current_branch_shorthand(repo: &Repository) -> Result<String, MergeError> {
    let head = match repo.head() {
        Ok(h) => h,
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            return Err(MergeError::TargetBranchMissing(
                "HEAD points at an unborn branch".into(),
            ))
        }
        Err(e) => return Err(e.into()),
    };
    if !head.is_branch() {
        return Err(MergeError::DetachedHead);
    }
    head.shorthand()
        .map(|s| s.to_string())
        .ok_or_else(|| MergeError::InternalError("HEAD has no shorthand".into()))
}

fn head_commit(repo: &Repository) -> Result<Commit<'_>, MergeError> {
    Ok(repo.head()?.peel_to_commit()?)
}

fn resolve_source_commit<'r>(
    repo: &'r Repository,
    source_branch: &str,
) -> Result<Commit<'r>, MergeError> {
    let branch = repo
        .find_branch(source_branch, BranchType::Local)
        .map_err(|_| MergeError::SourceBranchMissing(source_branch.to_string()))?;
    let reference = branch.into_reference();
    Ok(reference.peel_to_commit()?)
}

fn require_clean_worktree(repo: &Repository) -> Result<(), MergeError> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;
    let mut dirty_files: Vec<String> = Vec::new();
    for entry in statuses.iter() {
        // Skip entries that are purely ignored (defensive — `include_ignored=false`
        // should already exclude them).
        if entry.status().is_ignored() && !entry.status().is_wt_new() {
            continue;
        }
        if let Some(p) = entry.path() {
            dirty_files.push(p.to_string());
        }
    }
    if !dirty_files.is_empty() {
        return Err(MergeError::WorkingTreeDirty { dirty_files });
    }
    Ok(())
}

fn collect_conflicts(index: &git2::Index) -> Result<Vec<String>, MergeError> {
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    let conflicts = index.conflicts()?;
    for c in conflicts.flatten() {
        // Prefer the "our" side path, fall back to "their" or "ancestor" — at least one
        // is always present per git2 docs.
        let entry = c.our.as_ref().or(c.their.as_ref()).or(c.ancestor.as_ref());
        if let Some(e) = entry {
            if let Ok(s) = std::str::from_utf8(&e.path) {
                paths.push(s.to_string());
            }
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn collect_source_commits(
    repo: &Repository,
    source_commit: &Commit,
    merge_base: Option<Oid>,
) -> Result<Vec<CommitSummary>, MergeError> {
    let mut walk = repo.revwalk()?;
    walk.push(source_commit.id())?;
    if let Some(base) = merge_base {
        walk.hide(base)?;
    }
    let mut out = Vec::new();
    for oid in walk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        out.push(CommitSummary {
            sha: oid.to_string(),
            message: commit.summary().unwrap_or("").to_string(),
            author: commit
                .author()
                .name()
                .map(|s| s.to_string())
                .unwrap_or_default(),
            timestamp: commit.time().seconds(),
        });
    }
    // revwalk yields newest-first; flip so callers see oldest-first.
    out.reverse();
    Ok(out)
}

fn compute_diff_summary(
    repo: &Repository,
    merge_base: Option<Oid>,
    source_commit: &Commit,
) -> Result<DiffSummary, MergeError> {
    let source_tree = source_commit.tree()?;
    let base_tree = match merge_base {
        Some(oid) => Some(repo.find_commit(oid)?.tree()?),
        None => None,
    };
    let diff = repo.diff_tree_to_tree(base_tree.as_ref(), Some(&source_tree), None)?;
    let stats = diff.stats()?;
    Ok(DiffSummary {
        files_changed: stats.files_changed(),
        insertions: stats.insertions(),
        deletions: stats.deletions(),
    })
}

fn author_signature(repo: &Repository) -> Result<Signature<'static>, MergeError> {
    // Prefer the repo / user's configured identity. Fall back to a deterministic local
    // identity if none is set — the merge should still succeed on a fresh dev machine.
    let sig = repo
        .signature()
        .or_else(|_| Signature::now("orca", "orca@local"))?;
    // git2's `Signature` borrows from the repo config; clone to a 'static lifetime.
    Ok(Signature::now(
        sig.name().unwrap_or("orca"),
        sig.email().unwrap_or("orca@local"),
    )?)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use tempfile::TempDir;

    fn sh(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    /// Initialise a repo on `main` with a single committed file, then create a feature
    /// branch (`orca/feature`) with two additional commits adding `feature.txt`.
    fn setup_repo() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let p = dir.path().to_path_buf();
        sh(&p, &["init", "-b", "main"]);
        sh(&p, &["config", "user.email", "t@t"]);
        sh(&p, &["config", "user.name", "t"]);
        sh(&p, &["config", "commit.gpgsign", "false"]);
        write(&p.join("README"), "hi\n");
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-m", "init"]);

        sh(&p, &["checkout", "-b", "orca/feature"]);
        write(&p.join("feature.txt"), "alpha\n");
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-m", "add feature alpha"]);
        write(&p.join("feature.txt"), "alpha\nbeta\n");
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-m", "extend feature"]);

        sh(&p, &["checkout", "main"]);
        (dir, p)
    }

    #[test]
    fn analyze_clean_merge_reports_diff_and_no_conflicts() {
        let (_g, p) = setup_repo();
        let a = analyze_merge(&p, "orca/feature").unwrap();
        assert_eq!(a.target_branch, "main");
        assert_eq!(a.source_branch, "orca/feature");
        assert!(!a.already_merged);
        assert!(a.conflicts.is_empty());
        assert_eq!(a.diff_summary.files_changed, 1);
        assert!(a.diff_summary.insertions >= 2);
        assert_eq!(a.source_commits.len(), 2);
        // Oldest-first ordering.
        assert!(a.source_commits[0].message.contains("alpha"));
        assert!(a.source_commits[1].message.contains("extend"));
    }

    #[test]
    fn analyze_detects_conflicts_with_overlapping_change() {
        let (_g, p) = setup_repo();
        // Conflict: change feature.txt on main differently from the source branch.
        sh(&p, &["checkout", "-b", "main_alt"]); // can't commit on protected? main is fine
        sh(&p, &["checkout", "main"]);
        write(&p.join("feature.txt"), "main-version\n");
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-m", "main adds feature.txt"]);

        let a = analyze_merge(&p, "orca/feature").unwrap();
        assert!(!a.already_merged);
        assert_eq!(a.conflicts, vec!["feature.txt".to_string()]);
    }

    #[test]
    fn analyze_marks_already_merged_when_source_is_ancestor() {
        let (_g, p) = setup_repo();
        // Fast-forward merge via shell git, then re-analyze.
        sh(&p, &["merge", "--ff-only", "orca/feature"]);
        let a = analyze_merge(&p, "orca/feature").unwrap();
        assert!(a.already_merged);
        assert!(a.conflicts.is_empty());
    }

    #[test]
    fn squash_merge_produces_single_parent_commit() {
        let (_g, p) = setup_repo();
        let result =
            execute_squash_merge(&p, "orca/feature", "[task] feature\n\nTask-ID: t1").unwrap();
        assert_eq!(result.target_branch, "main");
        assert_eq!(result.source_branch, "orca/feature");
        assert_eq!(result.parent_commits.len(), 2);

        let repo = Repository::open(&p).unwrap();
        let new_commit = repo
            .find_commit(Oid::from_str(&result.commit_sha).unwrap())
            .unwrap();
        assert_eq!(new_commit.parent_count(), 1, "squash → single parent");
        assert!(new_commit.message().unwrap().contains("Task-ID: t1"));
        assert!(p.join("feature.txt").exists());
    }

    #[test]
    fn merge_commit_produces_two_parent_commit() {
        let (_g, p) = setup_repo();
        let result = execute_merge_commit(&p, "orca/feature", "merge feature").unwrap();
        let repo = Repository::open(&p).unwrap();
        let new_commit = repo
            .find_commit(Oid::from_str(&result.commit_sha).unwrap())
            .unwrap();
        assert_eq!(new_commit.parent_count(), 2);
        // Second parent is the source HEAD.
        let second = new_commit.parent_id(1).unwrap();
        let source_head = repo
            .find_branch("orca/feature", BranchType::Local)
            .unwrap()
            .into_reference()
            .peel_to_commit()
            .unwrap()
            .id();
        assert_eq!(second, source_head);
    }

    #[test]
    fn detached_head_is_rejected_for_execute() {
        let (_g, p) = setup_repo();
        // Detach HEAD on main.
        let head_sha = {
            let repo = Repository::open(&p).unwrap();
            let sha = repo
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id()
                .to_string();
            sha
        };
        sh(&p, &["checkout", "--detach", &head_sha]);
        let err = execute_squash_merge(&p, "orca/feature", "msg").unwrap_err();
        assert!(matches!(err, MergeError::DetachedHead), "got {:?}", err);
        // analyze_merge also rejects detached HEAD — the UI never gets that far.
        let err = analyze_merge(&p, "orca/feature").unwrap_err();
        assert!(matches!(err, MergeError::DetachedHead));
    }

    #[test]
    fn dirty_worktree_is_rejected_for_execute() {
        let (_g, p) = setup_repo();
        write(&p.join("dirt.txt"), "uncommitted\n");
        let err = execute_squash_merge(&p, "orca/feature", "msg").unwrap_err();
        match err {
            MergeError::WorkingTreeDirty { dirty_files } => {
                assert!(dirty_files.iter().any(|f| f == "dirt.txt"));
            }
            other => panic!("expected WorkingTreeDirty, got {:?}", other),
        }
    }

    #[test]
    fn missing_source_branch_is_typed_error() {
        let (_g, p) = setup_repo();
        let err = analyze_merge(&p, "orca/no-such-branch").unwrap_err();
        assert!(matches!(err, MergeError::SourceBranchMissing(_)));
    }

    #[test]
    fn execute_rejects_when_source_already_merged() {
        let (_g, p) = setup_repo();
        sh(&p, &["merge", "--ff-only", "orca/feature"]);
        let err = execute_merge_commit(&p, "orca/feature", "noop").unwrap_err();
        assert!(matches!(err, MergeError::AlreadyMerged { .. }));
    }
}
