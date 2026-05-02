//! Git worktree primitives. Per-task worktrees live at
//! `<repo_root>/.orca/worktrees/<task_id>/` on a branch named `orca/<task_id>`.
//!
//! All git operations go through `git2` rather than shelling out to `git`.

use std::path::{Path, PathBuf};

use git2::{BranchType, Repository, WorktreeAddOptions, WorktreePruneOptions};
use thiserror::Error;

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: String,
    pub head_commit: String,
    pub is_locked: bool,
    pub has_uncommitted_changes: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeStatus {
    pub has_uncommitted_changes: bool,
    pub ahead_of_base: usize,
    pub behind_base: usize,
    pub files_changed: Vec<String>,
}

#[derive(Debug, Error)]
pub enum WorktreeError {
    #[error("worktree creation failed: {0}")]
    CreationFailed(String),
    #[error("worktree removal failed: {0}")]
    RemovalFailed(String),
    #[error("worktree not found at {0}")]
    WorktreeNotFound(PathBuf),
    #[error("worktree has uncommitted changes")]
    RepoNotClean,
    #[error("branch already exists: {0}")]
    BranchExists(String),
    #[error("git error: {0}")]
    GitError(String),
    #[error("io error: {0}")]
    IoError(String),
}

impl From<git2::Error> for WorktreeError {
    fn from(e: git2::Error) -> Self {
        WorktreeError::GitError(e.message().to_string())
    }
}

impl From<std::io::Error> for WorktreeError {
    fn from(e: std::io::Error) -> Self {
        WorktreeError::IoError(e.to_string())
    }
}

pub fn branch_name_for(task_id: &str) -> String {
    format!("orca/{}", task_id)
}

pub fn worktree_path_for(repo_root: &Path, task_id: &str) -> PathBuf {
    repo_root.join(".orca").join("worktrees").join(task_id)
}

fn worktree_internal_name(task_id: &str) -> String {
    // git2 stores worktrees under `.git/worktrees/<name>/`. Avoid `/` in the name.
    format!("orca-{}", task_id)
}

/// Create a worktree at `<repo_root>/.orca/worktrees/<task_id>/` on a new branch
/// `orca/<task_id>` cut from the current HEAD of `repo_root`.
pub fn create_worktree(
    repo_root: &Path,
    task_id: &str,
    _base_branch: &str,
) -> Result<WorktreeInfo, WorktreeError> {
    let repo = Repository::open(repo_root)
        .map_err(|e| WorktreeError::CreationFailed(format!("open repo: {}", e.message())))?;

    let head_commit = repo
        .head()
        .map_err(|e| WorktreeError::CreationFailed(format!("read HEAD: {}", e.message())))?
        .peel_to_commit()
        .map_err(|e| {
            WorktreeError::CreationFailed(format!("peel HEAD to commit: {}", e.message()))
        })?;
    let base_commit = head_commit.id().to_string();

    let branch_name = branch_name_for(task_id);
    if repo.find_branch(&branch_name, BranchType::Local).is_ok() {
        return Err(WorktreeError::BranchExists(branch_name));
    }
    let branch = repo
        .branch(&branch_name, &head_commit, false)
        .map_err(|e| WorktreeError::CreationFailed(format!("create branch: {}", e.message())))?;
    let reference = branch.into_reference();

    let worktree_dir = worktree_path_for(repo_root, task_id);
    if let Some(parent) = worktree_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            WorktreeError::CreationFailed(format!("create parent dir: {}", e))
        })?;
    }
    if worktree_dir.exists() {
        return Err(WorktreeError::CreationFailed(format!(
            "worktree path already exists: {}",
            worktree_dir.display()
        )));
    }

    let mut opts = WorktreeAddOptions::new();
    opts.reference(Some(&reference));

    let wt_name = worktree_internal_name(task_id);
    repo.worktree(&wt_name, &worktree_dir, Some(&opts))
        .map_err(|e| WorktreeError::CreationFailed(format!("git worktree add: {}", e.message())))?;

    Ok(WorktreeInfo {
        path: worktree_dir,
        branch: branch_name,
        head_commit: base_commit,
        is_locked: false,
        has_uncommitted_changes: false,
    })
}

/// Remove a worktree: delete its working directory and prune the registration. If `force`
/// is false and the worktree has uncommitted changes, returns `RepoNotClean`.
///
/// Also deletes the associated `orca/<task_id>` branch on success.
pub fn remove_worktree(
    repo_root: &Path,
    worktree_path: &Path,
    force: bool,
) -> Result<(), WorktreeError> {
    if !force && worktree_path.exists() {
        let dirty = match worktree_status(worktree_path) {
            Ok(s) => s.has_uncommitted_changes,
            Err(_) => false,
        };
        if dirty {
            return Err(WorktreeError::RepoNotClean);
        }
    }

    let repo = Repository::open(repo_root)
        .map_err(|e| WorktreeError::RemovalFailed(format!("open repo: {}", e.message())))?;

    // Find the worktree registration that points at this path, if any. macOS temp dirs
    // resolve through `/private`, so compare canonicalized forms to handle that.
    let target_canon = std::fs::canonicalize(worktree_path).ok();
    let mut found_name: Option<String> = None;
    let mut found_branch: Option<String> = None;
    if let Ok(worktrees) = repo.worktrees() {
        for name in worktrees.iter().flatten() {
            if let Ok(wt) = repo.find_worktree(name) {
                let same = wt.path() == worktree_path
                    || std::fs::canonicalize(wt.path())
                        .ok()
                        .zip(target_canon.as_ref())
                        .map(|(a, b)| &a == b)
                        .unwrap_or(false);
                if same {
                    found_name = Some(name.to_string());
                    // Try to discover the branch name from the worktree's HEAD.
                    if let Ok(wt_repo) = Repository::open_from_worktree(&wt) {
                        if let Ok(head) = wt_repo.head() {
                            if let Some(shorthand) = head.shorthand() {
                                found_branch = Some(shorthand.to_string());
                            }
                        }
                    }
                    break;
                }
            }
        }
    }

    if worktree_path.exists() {
        std::fs::remove_dir_all(worktree_path).map_err(|e| {
            WorktreeError::RemovalFailed(format!("remove dir: {}", e))
        })?;
    }

    if let Some(name) = found_name {
        if let Ok(wt) = repo.find_worktree(&name) {
            let mut opts = WorktreePruneOptions::new();
            opts.valid(true).working_tree(true);
            if let Err(e) = wt.prune(Some(&mut opts)) {
                return Err(WorktreeError::RemovalFailed(format!(
                    "prune registration: {}",
                    e.message()
                )));
            }
        }
    }

    if let Some(branch_name) = found_branch {
        if let Ok(mut b) = repo.find_branch(&branch_name, BranchType::Local) {
            let _ = b.delete();
        }
    }

    Ok(())
}

/// List all worktrees registered in `repo_root`.
pub fn list_worktrees(repo_root: &Path) -> Result<Vec<WorktreeInfo>, WorktreeError> {
    let repo = Repository::open(repo_root)?;
    let worktrees = repo.worktrees()?;
    let mut out = Vec::new();
    for name in worktrees.iter().flatten() {
        let wt = match repo.find_worktree(name) {
            Ok(wt) => wt,
            Err(_) => continue,
        };
        let path = wt.path().to_path_buf();
        let is_locked = wt
            .is_locked()
            .map(|l| !matches!(l, git2::WorktreeLockStatus::Unlocked))
            .unwrap_or(false);
        let (branch, head_commit, has_uncommitted) = match Repository::open_from_worktree(&wt) {
            Ok(wt_repo) => {
                let branch = wt_repo
                    .head()
                    .ok()
                    .and_then(|h| h.shorthand().map(|s| s.to_string()))
                    .unwrap_or_default();
                let head_commit = wt_repo
                    .head()
                    .ok()
                    .and_then(|h| h.peel_to_commit().ok())
                    .map(|c| c.id().to_string())
                    .unwrap_or_default();
                let dirty = repo_has_uncommitted(&wt_repo).unwrap_or(false);
                (branch, head_commit, dirty)
            }
            Err(_) => (String::new(), String::new(), false),
        };
        out.push(WorktreeInfo {
            path,
            branch,
            head_commit,
            is_locked,
            has_uncommitted_changes: has_uncommitted,
        });
    }
    Ok(out)
}

/// Status of a single worktree: whether it has uncommitted changes and which files differ.
/// `ahead_of_base`/`behind_base` are placeholders (0/0); per-phase diffing arrives later.
pub fn worktree_status(worktree_path: &Path) -> Result<WorktreeStatus, WorktreeError> {
    if !worktree_path.exists() {
        return Err(WorktreeError::WorktreeNotFound(worktree_path.to_path_buf()));
    }
    let repo = Repository::open(worktree_path)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    let mut files_changed = Vec::new();
    for entry in statuses.iter() {
        if let Some(p) = entry.path() {
            files_changed.push(p.to_string());
        }
    }
    Ok(WorktreeStatus {
        has_uncommitted_changes: !files_changed.is_empty(),
        ahead_of_base: 0,
        behind_base: 0,
        files_changed,
    })
}

fn repo_has_uncommitted(repo: &Repository) -> Result<bool, git2::Error> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(!statuses.is_empty())
}

/// Stage all changes in `worktree_path` and create a commit with `message`. If there are
/// no changes, returns the current HEAD without creating a commit. Returns the resulting
/// HEAD commit SHA either way.
pub fn commit_all(worktree_path: &Path, message: &str) -> Result<String, WorktreeError> {
    let repo = Repository::open(worktree_path)?;

    let mut index = repo.index()?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index.write()?;

    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let head = repo.head().ok();
    let parent_commit = head.as_ref().and_then(|h| h.peel_to_commit().ok());
    if let Some(parent) = &parent_commit {
        if parent.tree_id() == tree_id {
            return Ok(parent.id().to_string());
        }
    }

    let sig = repo
        .signature()
        .or_else(|_| git2::Signature::now("orca", "orca@local"))?;
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    Ok(oid.to_string())
}

/// Produce a unified-diff text of `base_commit_sha..HEAD` for the given worktree, in
/// `git diff` format. Returns the empty string if the trees are identical.
pub fn diff_against_base(
    worktree_path: &Path,
    base_commit_sha: &str,
) -> Result<String, WorktreeError> {
    let repo = Repository::open(worktree_path)?;

    let base_oid = git2::Oid::from_str(base_commit_sha)
        .map_err(|e| WorktreeError::GitError(format!("invalid base sha: {}", e)))?;
    let base_tree = repo.find_commit(base_oid)?.tree()?;
    let head_tree = repo
        .head()?
        .peel_to_commit()?
        .tree()?;

    let mut opts = git2::DiffOptions::new();
    opts.context_lines(3).include_untracked(false);
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;

    let mut out = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' | '-' | ' ' => out.push(line.origin()),
            _ => {}
        }
        if let Ok(s) = std::str::from_utf8(line.content()) {
            out.push_str(s);
        }
        true
    })?;
    Ok(out)
}

/// Truncate a diff at `max_bytes`, appending a note that points at the worktree command
/// to inspect the full diff. Returns the input unchanged if it's already small enough.
pub fn truncate_diff(diff: &str, max_bytes: usize, base_commit_sha: &str) -> String {
    if diff.len() <= max_bytes {
        return diff.to_string();
    }
    // Cut on a UTF-8 boundary to avoid producing invalid output.
    let mut cut = max_bytes;
    while cut > 0 && !diff.is_char_boundary(cut) {
        cut -= 1;
    }
    let total = diff.len();
    format!(
        "{}\n...diff truncated, {} bytes total. The full diff can be inspected by \
         running `git diff {}..HEAD` in the worktree.\n",
        &diff[..cut],
        total,
        base_commit_sha,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        let path = dir.path();
        Command::new("git").args(["init", "-b", "main"]).current_dir(path).output().unwrap();
        Command::new("git").args(["config", "user.email", "t@t"]).current_dir(path).output().unwrap();
        Command::new("git").args(["config", "user.name", "t"]).current_dir(path).output().unwrap();
        std::fs::write(path.join("README"), "hi").unwrap();
        Command::new("git").args(["add", "."]).current_dir(path).output().unwrap();
        Command::new("git").args(["commit", "-m", "init"]).current_dir(path).output().unwrap();
        dir
    }

    #[test]
    fn create_and_remove_worktree() {
        let repo = init_repo();
        let info = create_worktree(repo.path(), "01TASK", "main").unwrap();
        assert!(info.path.exists());
        assert_eq!(info.branch, "orca/01TASK");
        assert!(info.path.starts_with(repo.path().join(".orca/worktrees")));

        let canon = std::fs::canonicalize(&info.path).unwrap();
        let listed = list_worktrees(repo.path()).unwrap();
        assert!(listed
            .iter()
            .any(|w| std::fs::canonicalize(&w.path).map(|c| c == canon).unwrap_or(false)));

        remove_worktree(repo.path(), &info.path, false).unwrap();
        assert!(!info.path.exists());
        let after = list_worktrees(repo.path()).unwrap();
        assert!(!after.iter().any(|w| w.path == info.path));
    }

    #[test]
    fn duplicate_branch_fails() {
        let repo = init_repo();
        let _info = create_worktree(repo.path(), "01DUP", "main").unwrap();
        let err = create_worktree(repo.path(), "01DUP", "main").unwrap_err();
        assert!(matches!(err, WorktreeError::BranchExists(_)));
    }

    #[test]
    fn remove_blocked_by_uncommitted_unless_forced() {
        let repo = init_repo();
        let info = create_worktree(repo.path(), "01DIRTY", "main").unwrap();
        std::fs::write(info.path.join("new.txt"), "x").unwrap();
        let err = remove_worktree(repo.path(), &info.path, false).unwrap_err();
        assert!(matches!(err, WorktreeError::RepoNotClean));
        assert!(info.path.exists());
        remove_worktree(repo.path(), &info.path, true).unwrap();
        assert!(!info.path.exists());
    }

    #[test]
    fn status_reports_changes() {
        let repo = init_repo();
        let info = create_worktree(repo.path(), "01STAT", "main").unwrap();
        let s = worktree_status(&info.path).unwrap();
        assert!(!s.has_uncommitted_changes);
        std::fs::write(info.path.join("a.txt"), "a").unwrap();
        let s = worktree_status(&info.path).unwrap();
        assert!(s.has_uncommitted_changes);
        assert!(s.files_changed.iter().any(|p| p == "a.txt"));
    }

    #[test]
    fn commit_all_captures_changes() {
        let repo = init_repo();
        let info = create_worktree(repo.path(), "01COMMIT", "main").unwrap();
        let before = info.head_commit.clone();
        std::fs::write(info.path.join("file.txt"), "hello").unwrap();
        let after = commit_all(&info.path, "[phase: implementer] test").unwrap();
        assert_ne!(before, after);
        let s = worktree_status(&info.path).unwrap();
        assert!(!s.has_uncommitted_changes);
        // Idempotent when nothing changed.
        let after2 = commit_all(&info.path, "[phase: implementer] test").unwrap();
        assert_eq!(after, after2);
    }

    #[test]
    fn diff_against_base_shows_added_file() {
        let repo = init_repo();
        let info = create_worktree(repo.path(), "01DIFF", "main").unwrap();
        let base = info.head_commit.clone();
        std::fs::write(info.path.join("hello.txt"), "hi\n").unwrap();
        commit_all(&info.path, "[phase: test_author] add hello").unwrap();
        let diff = diff_against_base(&info.path, &base).unwrap();
        assert!(diff.contains("hello.txt"));
        assert!(diff.contains("+hi"));
    }

    #[test]
    fn diff_against_base_empty_when_unchanged() {
        let repo = init_repo();
        let info = create_worktree(repo.path(), "01NOP", "main").unwrap();
        let diff = diff_against_base(&info.path, &info.head_commit).unwrap();
        assert!(diff.is_empty());
    }

    #[test]
    fn truncate_diff_appends_marker_when_over_limit() {
        let big = "a".repeat(2000);
        let out = truncate_diff(&big, 100, "deadbeef");
        assert!(out.len() < big.len() + 200);
        assert!(out.contains("...diff truncated"));
        assert!(out.contains("git diff deadbeef..HEAD"));
        assert!(out.contains("2000 bytes total"));
    }

    #[test]
    fn truncate_diff_passthrough_when_under_limit() {
        let small = "tiny";
        let out = truncate_diff(small, 100, "x");
        assert_eq!(out, small);
    }
}
