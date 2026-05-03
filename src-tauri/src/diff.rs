//! Structured task-scoped diffs and auditor anchor mapping.
//!
//! Every task has a `task_base_commit` (recorded at worktree creation). The diff this
//! module produces is always `task_base_commit..head`, where `head` depends on the
//! task's lifecycle stage:
//!
//! - **Live (worktree exists):** HEAD of the per-task worktree.
//! - **Merged:** the recorded `merged_commit_sha` in the main repo.
//! - **Branch-only (worktree gone, branch retained):** the tip of `orca/<task_id>`.
//! - **Otherwise:** `DiffSource::Unavailable` — the diff cannot be reconstructed.
//!
//! The output is fully self-contained: structured hunks plus the full pre/post file
//! contents (so the modal's side-by-side view doesn't need a second round-trip).
//!
//! Anchor mapping is a separate pass: it takes the auditor's concerns (each carrying
//! `{ path, line }` referring to the post-change file) and resolves where each one
//! lands relative to the diff structure — on a diff line, on an unchanged-context
//! line within a changed file, on a file that wasn't touched, or unmappable.
//!
//! All git operations go through `git2`.

use std::path::{Path, PathBuf};

use git2::{BranchType, Delta, DiffFindOptions, DiffOptions, Oid, Patch, Repository};
use serde::{Deserialize, Serialize};
use thiserror::Error;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDiff {
    pub task_id: String,
    pub base_commit: String,
    pub head_commit: String,
    pub source: DiffSource,
    pub files: Vec<DiffFile>,
    /// Unix millis. Used by the cache layer above for invalidation; the diff itself
    /// is otherwise immutable for a fixed (base, head) pair.
    pub computed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffSource {
    /// Live worktree at `path` exists; diffed against `task_base_commit`.
    Worktree { path: String },
    /// Worktree gone but the task was merged; diff reconstructed from the merge commit.
    MergedFromHistory { merge_commit: String },
    /// Worktree gone, no merge, but the task branch still exists.
    BranchOnly { branch: String, branch_head: String },
    /// Cannot produce a diff — branch was removed, base commit unknown, etc.
    Unavailable { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffFile {
    pub path: String,
    /// Set when the file was renamed; the pre-image path.
    pub old_path: Option<String>,
    pub status: FileStatus,
    /// True when git treats this file as binary; `hunks` will be empty and the content
    /// fields will be `None`. The frontend renders a "binary file" placeholder.
    pub is_binary: bool,
    pub hunks: Vec<DiffHunk>,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    /// Detected from extension (e.g. `"typescript"`, `"rust"`). `None` if unknown.
    pub language: Option<String>,
    /// Convenience tallies — frontend uses these for the per-file `+N -M` summary
    /// without having to walk hunks.
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    /// Optional hunk header (the text after `@@ ... @@`); useful for the UI to show
    /// the enclosing function name when git provides one.
    pub header: Option<String>,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_lineno: Option<usize>,
    pub new_lineno: Option<usize>,
    pub content: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

// ---------------------------------------------------------------------------
// Auditor concern shape (parsed from the verdict event's `concerns_json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditorConcern {
    pub category: String,
    pub severity: String,
    #[serde(default)]
    pub anchor: Option<AuditorAnchor>,
    pub rationale: String,
    #[serde(default)]
    pub reference_proposition_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditorAnchor {
    pub path: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappedConcern {
    pub concern: AuditorConcern,
    pub mapping: AnchorMapping,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AnchorMapping {
    /// The anchor falls on a line that's part of a hunk in the diff. Indices point at
    /// the line within `diff.files[file_index].hunks[hunk_index].lines[line_index]`.
    OnDiffLine {
        file_index: usize,
        hunk_index: usize,
        line_index: usize,
    },
    /// The anchor's file is in the diff, but the anchor line is outside any hunk —
    /// the auditor is calling out a line of context, not a change. `content` is the
    /// raw line text from the post-change file, for previewing in the UI.
    OnUnchangedLine {
        file_index: usize,
        line_in_file: usize,
        content: String,
    },
    /// The anchor's file isn't in the diff at all. The frontend can request the file's
    /// content separately (see `read_file_at_head`) for a contextual snippet.
    FileNotInDiff { path: String, line: usize },
    /// The concern had no anchor, or the anchor's path/line was nonsense (e.g. line 0,
    /// or a path that resolves to neither a diff entry nor an existing file).
    Unmapped,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum DiffError {
    #[error("git error: {0}")]
    Git(String),
    #[error("worktree missing at {0}")]
    WorktreeMissing(PathBuf),
    #[error("commit not found: {0}")]
    CommitNotFound(String),
    #[error("io error: {0}")]
    Io(String),
}

impl From<git2::Error> for DiffError {
    fn from(e: git2::Error) -> Self {
        DiffError::Git(e.message().to_string())
    }
}

impl From<std::io::Error> for DiffError {
    fn from(e: std::io::Error) -> Self {
        DiffError::Io(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Inputs / source resolution
// ---------------------------------------------------------------------------

/// All the per-task fields the diff layer needs. The Tauri command builds this from
/// the task projection; tests construct it directly.
pub struct TaskDiffInputs<'a> {
    pub repo_root: &'a Path,
    pub task_id: &'a str,
    /// May be `None` if the task never had a base commit recorded — surfaces as
    /// `DiffSource::Unavailable`.
    pub task_base_commit: Option<&'a str>,
    /// `Some` if the worktree currently exists on disk.
    pub worktree_path: Option<&'a Path>,
    /// `Some` for merged tasks — the SHA recorded on `TaskMerged`.
    pub merged_commit: Option<&'a str>,
}

/// Compute the task-scoped diff. Picks the right source automatically:
///
/// 1. If a live worktree exists, diff `task_base_commit..worktree_HEAD` from it.
/// 2. Else if a merge commit is recorded, diff `task_base_commit..merge_commit`
///    from the main repo. (For squash merges the merge commit *is* the change; for
///    merge commits, walking from the base captures everything reachable.)
/// 3. Else if the task branch `orca/<task_id>` still exists, diff against its tip.
/// 4. Else return `DiffSource::Unavailable` with a human-readable reason.
pub fn compute_task_diff(inputs: TaskDiffInputs<'_>) -> Result<TaskDiff, DiffError> {
    let now = unix_millis();
    let task_id = inputs.task_id.to_string();

    let base_commit_str = match inputs.task_base_commit {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return Ok(TaskDiff {
                task_id,
                base_commit: String::new(),
                head_commit: String::new(),
                source: DiffSource::Unavailable {
                    reason: "task has no base commit recorded".into(),
                },
                files: vec![],
                computed_at: now,
            });
        }
    };

    // 1. Live worktree.
    if let Some(wt) = inputs.worktree_path {
        if wt.exists() {
            let repo = Repository::open(wt)
                .map_err(|e| DiffError::Git(format!("open worktree {}: {}", wt.display(), e.message())))?;
            let head_oid = repo
                .head()?
                .peel_to_commit()?
                .id();
            let base_oid = parse_oid(&base_commit_str)?;
            let files = build_files(&repo, base_oid, head_oid)?;
            return Ok(TaskDiff {
                task_id,
                base_commit: base_commit_str,
                head_commit: head_oid.to_string(),
                source: DiffSource::Worktree {
                    path: wt.to_string_lossy().into_owned(),
                },
                files,
                computed_at: now,
            });
        }
    }

    // 2. Merged: reconstruct from the merge commit in the main repo.
    if let Some(merge_sha) = inputs.merged_commit {
        let repo = Repository::open(inputs.repo_root)?;
        let merge_oid = parse_oid(merge_sha)?;
        let base_oid = parse_oid(&base_commit_str)?;
        // Validate both commits exist before diffing — better error than git2's
        // generic "object not found" further down.
        repo.find_commit(merge_oid)
            .map_err(|_| DiffError::CommitNotFound(merge_sha.into()))?;
        repo.find_commit(base_oid)
            .map_err(|_| DiffError::CommitNotFound(base_commit_str.clone()))?;
        let files = build_files(&repo, base_oid, merge_oid)?;
        return Ok(TaskDiff {
            task_id,
            base_commit: base_commit_str,
            head_commit: merge_oid.to_string(),
            source: DiffSource::MergedFromHistory {
                merge_commit: merge_oid.to_string(),
            },
            files,
            computed_at: now,
        });
    }

    // 3. Branch-only: worktree is gone, but the branch tip is still around.
    let repo = Repository::open(inputs.repo_root)?;
    let branch_name = format!("orca/{}", inputs.task_id);
    if let Ok(branch) = repo.find_branch(&branch_name, BranchType::Local) {
        if let Ok(commit) = branch.get().peel_to_commit() {
            let head_oid = commit.id();
            let base_oid = parse_oid(&base_commit_str)?;
            let files = build_files(&repo, base_oid, head_oid)?;
            return Ok(TaskDiff {
                task_id,
                base_commit: base_commit_str,
                head_commit: head_oid.to_string(),
                source: DiffSource::BranchOnly {
                    branch: branch_name,
                    branch_head: head_oid.to_string(),
                },
                files,
                computed_at: now,
            });
        }
    }

    // 4. Nothing left to diff against.
    Ok(TaskDiff {
        task_id,
        base_commit: base_commit_str,
        head_commit: String::new(),
        source: DiffSource::Unavailable {
            reason: "no worktree, no merge commit, no branch".into(),
        },
        files: vec![],
        computed_at: now,
    })
}

// ---------------------------------------------------------------------------
// Diff -> structured files
// ---------------------------------------------------------------------------

fn build_files(repo: &Repository, base: Oid, head: Oid) -> Result<Vec<DiffFile>, DiffError> {
    let base_tree = repo.find_commit(base)?.tree()?;
    let head_tree = repo.find_commit(head)?.tree()?;

    let mut opts = DiffOptions::new();
    opts.context_lines(3)
        .interhunk_lines(1)
        .include_untracked(false)
        // We want to see whitespace changes — auditor pointers can land on them.
        .ignore_whitespace(false);

    let mut diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;

    // Rename / copy detection — without this, a rename shows as delete + add and the
    // "unchanged content within a renamed file" anchor case can't be expressed.
    let mut find_opts = DiffFindOptions::new();
    find_opts.renames(true).copies(false);
    diff.find_similar(Some(&mut find_opts))?;

    let mut files = Vec::with_capacity(diff.deltas().len());
    for idx in 0..diff.deltas().len() {
        let delta = match diff.get_delta(idx) {
            Some(d) => d,
            None => continue,
        };

        let new_path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().into_owned());
        let old_path_raw = delta
            .old_file()
            .path()
            .map(|p| p.to_string_lossy().into_owned());

        // Use the new path as the canonical path; for deletions there's no new path,
        // so fall back to the old path.
        let path = new_path
            .clone()
            .or_else(|| old_path_raw.clone())
            .unwrap_or_default();
        let old_path = match (delta.status(), &old_path_raw, &new_path) {
            (Delta::Renamed, Some(old), Some(new)) if old != new => Some(old.clone()),
            _ => None,
        };

        let status = match delta.status() {
            Delta::Added | Delta::Untracked => FileStatus::Added,
            Delta::Deleted => FileStatus::Deleted,
            Delta::Renamed => FileStatus::Renamed,
            Delta::Copied => FileStatus::Added,
            _ => FileStatus::Modified,
        };

        let is_binary = delta.old_file().is_binary() || delta.new_file().is_binary();

        let mut hunks: Vec<DiffHunk> = Vec::new();
        let mut additions: usize = 0;
        let mut deletions: usize = 0;

        if !is_binary {
            // `Patch::from_diff` is per-delta. Returns Ok(None) for binary entries (we
            // already short-circuited via `is_binary` above) or for empty patches.
            match Patch::from_diff(&diff, idx)? {
                Some(mut patch) => {
                    let nh = patch.num_hunks();
                    for h in 0..nh {
                        let (hunk, line_count) = patch.hunk(h)?;
                        let header = std::str::from_utf8(hunk.header())
                            .ok()
                            .map(|s| s.trim_end_matches('\n').to_string());
                        let mut lines = Vec::with_capacity(line_count);
                        for l in 0..line_count {
                            let line = patch.line_in_hunk(h, l)?;
                            let kind = match line.origin() {
                                '+' => {
                                    additions += 1;
                                    DiffLineKind::Added
                                }
                                '-' => {
                                    deletions += 1;
                                    DiffLineKind::Removed
                                }
                                _ => DiffLineKind::Context,
                            };
                            // Lines from git2 may or may not have a trailing newline;
                            // we keep whatever git provides so the rendered diff round-
                            // trips. The frontend strips a single trailing `\n` per line
                            // when laying out.
                            let content = String::from_utf8_lossy(line.content()).into_owned();
                            lines.push(DiffLine {
                                kind,
                                old_lineno: line.old_lineno().map(|n| n as usize),
                                new_lineno: line.new_lineno().map(|n| n as usize),
                                content,
                            });
                        }
                        hunks.push(DiffHunk {
                            old_start: hunk.old_start() as usize,
                            old_lines: hunk.old_lines() as usize,
                            new_start: hunk.new_start() as usize,
                            new_lines: hunk.new_lines() as usize,
                            header,
                            lines,
                        });
                    }
                }
                None => {}
            }
        }

        let (old_content, new_content) = if is_binary {
            (None, None)
        } else {
            let old = match status {
                FileStatus::Added => Some(String::new()),
                _ => read_blob_utf8(repo, delta.old_file().id()).ok(),
            };
            let new = match status {
                FileStatus::Deleted => Some(String::new()),
                _ => read_blob_utf8(repo, delta.new_file().id()).ok(),
            };
            (old, new)
        };

        let language = detect_language(&path);

        files.push(DiffFile {
            path,
            old_path,
            status,
            is_binary,
            hunks,
            old_content,
            new_content,
            language,
            additions,
            deletions,
        });
    }

    Ok(files)
}

fn read_blob_utf8(repo: &Repository, oid: Oid) -> Result<String, DiffError> {
    if oid.is_zero() {
        return Ok(String::new());
    }
    let blob = repo.find_blob(oid)?;
    Ok(String::from_utf8_lossy(blob.content()).into_owned())
}

fn parse_oid(s: &str) -> Result<Oid, DiffError> {
    Oid::from_str(s).map_err(|e| DiffError::Git(format!("invalid sha {:?}: {}", s, e.message())))
}

fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/// Map a file path's extension to a stable language tag. The tag is what the
/// syntect bridge consumes to pick a syntax. Returns `None` for unknown extensions.
pub fn detect_language(path: &str) -> Option<String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())?
        .to_lowercase();
    let tag = match ext.as_str() {
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" | "pyi" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "sh" | "bash" | "zsh" => "shell",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "md" | "markdown" => "markdown",
        "sql" => "sql",
        "xml" => "xml",
        _ => return None,
    };
    Some(tag.to_string())
}

// ---------------------------------------------------------------------------
// Anchor mapping
// ---------------------------------------------------------------------------

/// Map every concern to a position relative to the diff. The result has the same
/// length as `concerns` and preserves their order — concerns and mappings line up
/// 1:1 so the frontend can render them in either direction.
pub fn map_concerns_to_diff(diff: &TaskDiff, concerns: &[AuditorConcern]) -> Vec<MappedConcern> {
    concerns
        .iter()
        .map(|c| MappedConcern {
            concern: c.clone(),
            mapping: map_one(diff, c),
        })
        .collect()
}

fn map_one(diff: &TaskDiff, concern: &AuditorConcern) -> AnchorMapping {
    let anchor = match &concern.anchor {
        Some(a) if !a.path.is_empty() && a.line > 0 => a,
        _ => return AnchorMapping::Unmapped,
    };

    // 1. Find the file. Match new path first, then old path (so anchors against
    //    pre-rename names still resolve).
    let file_index = diff.files.iter().position(|f| {
        f.path == anchor.path || f.old_path.as_deref() == Some(anchor.path.as_str())
    });

    match file_index {
        Some(idx) => {
            let file = &diff.files[idx];

            // 2. Try to land on a hunk line.
            for (h_idx, hunk) in file.hunks.iter().enumerate() {
                for (l_idx, line) in hunk.lines.iter().enumerate() {
                    // Anchor lines refer to the post-change file → match new_lineno.
                    // Removed lines have no new_lineno, so they can't match — that's
                    // fine: the anchor came from the new file.
                    if line.new_lineno == Some(anchor.line) {
                        return AnchorMapping::OnDiffLine {
                            file_index: idx,
                            hunk_index: h_idx,
                            line_index: l_idx,
                        };
                    }
                }
            }

            // 3. The file is in the diff but the line is outside any hunk. Pull the
            //    referenced line from the post-change content if we have it.
            let content = file
                .new_content
                .as_deref()
                .and_then(|c| nth_line(c, anchor.line))
                .unwrap_or_default();
            AnchorMapping::OnUnchangedLine {
                file_index: idx,
                line_in_file: anchor.line,
                content,
            }
        }
        None => AnchorMapping::FileNotInDiff {
            path: anchor.path.clone(),
            line: anchor.line,
        },
    }
}

/// 1-indexed line lookup — returns `None` if the file has fewer than `n` lines.
fn nth_line(content: &str, n: usize) -> Option<String> {
    if n == 0 {
        return None;
    }
    content.lines().nth(n - 1).map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// On-demand file content (for `FileNotInDiff` previews)
// ---------------------------------------------------------------------------

/// Read the contents of `relative_path` at the diff's head commit. Used by the
/// `get_unchanged_file_content` Tauri command when the user expands a file that
/// has concerns but isn't part of the diff.
pub fn read_file_at_head(diff: &TaskDiff, repo_root: &Path, relative_path: &str) -> Result<String, DiffError> {
    match &diff.source {
        DiffSource::Worktree { path } => {
            // The worktree is a checkout — just read the file off disk. Avoids needing
            // to walk the tree and works regardless of whether the file is tracked.
            let p = Path::new(path).join(relative_path);
            std::fs::read_to_string(&p).map_err(|e| DiffError::Io(format!("{}: {}", p.display(), e)))
        }
        DiffSource::MergedFromHistory { merge_commit } => {
            read_blob_at_path(repo_root, merge_commit, relative_path)
        }
        DiffSource::BranchOnly { branch_head, .. } => {
            read_blob_at_path(repo_root, branch_head, relative_path)
        }
        DiffSource::Unavailable { reason } => Err(DiffError::Git(format!(
            "cannot read file from unavailable diff: {}",
            reason
        ))),
    }
}

fn read_blob_at_path(repo_root: &Path, commit_sha: &str, relative_path: &str) -> Result<String, DiffError> {
    let repo = Repository::open(repo_root)?;
    let oid = parse_oid(commit_sha)?;
    let tree = repo.find_commit(oid)?.tree()?;
    let entry = tree
        .get_path(Path::new(relative_path))
        .map_err(|_| DiffError::Git(format!("{} not in tree {}", relative_path, commit_sha)))?;
    let object = entry.to_object(&repo)?;
    let blob = object
        .as_blob()
        .ok_or_else(|| DiffError::Git(format!("{} is not a blob", relative_path)))?;
    Ok(String::from_utf8_lossy(blob.content()).into_owned())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn sh(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git invocation");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        let p = dir.path();
        sh(p, &["init", "-q", "-b", "main"]);
        sh(p, &["config", "user.email", "t@t"]);
        sh(p, &["config", "user.name", "t"]);
        std::fs::write(p.join("README.md"), "hello\n").unwrap();
        sh(p, &["add", "."]);
        sh(p, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn head_sha(p: &Path) -> String {
        let out = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(p)
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn worktree_source_added_file() {
        let dir = init_repo();
        let repo = dir.path();
        let base = head_sha(repo);
        std::fs::write(repo.join("hello.ts"), "export const x = 1;\n").unwrap();
        sh(repo, &["add", "."]);
        sh(repo, &["commit", "-q", "-m", "add"]);

        let inputs = TaskDiffInputs {
            repo_root: repo,
            task_id: "T1",
            task_base_commit: Some(&base),
            worktree_path: Some(repo),
            merged_commit: None,
        };
        let diff = compute_task_diff(inputs).unwrap();
        assert!(matches!(diff.source, DiffSource::Worktree { .. }));
        assert_eq!(diff.files.len(), 1);
        let f = &diff.files[0];
        assert_eq!(f.path, "hello.ts");
        assert_eq!(f.status, FileStatus::Added);
        assert_eq!(f.language.as_deref(), Some("typescript"));
        assert_eq!(f.additions, 1);
        assert_eq!(f.deletions, 0);
        assert_eq!(f.hunks.len(), 1);
        assert_eq!(f.new_content.as_deref(), Some("export const x = 1;\n"));
        assert_eq!(f.old_content.as_deref(), Some(""));
    }

    #[test]
    fn modified_file_with_context() {
        let dir = init_repo();
        let repo = dir.path();
        std::fs::write(
            repo.join("src.rs"),
            "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\nfn e() {}\nfn f() {}\nfn g() {}\n",
        )
        .unwrap();
        sh(repo, &["add", "."]);
        sh(repo, &["commit", "-q", "-m", "seed"]);
        let base = head_sha(repo);

        std::fs::write(
            repo.join("src.rs"),
            "fn a() {}\nfn b() {}\nfn c() {}\nfn D() {}\nfn e() {}\nfn f() {}\nfn g() {}\n",
        )
        .unwrap();
        sh(repo, &["add", "."]);
        sh(repo, &["commit", "-q", "-m", "tweak"]);

        let inputs = TaskDiffInputs {
            repo_root: repo,
            task_id: "T2",
            task_base_commit: Some(&base),
            worktree_path: Some(repo),
            merged_commit: None,
        };
        let diff = compute_task_diff(inputs).unwrap();
        assert_eq!(diff.files.len(), 1);
        let f = &diff.files[0];
        assert_eq!(f.status, FileStatus::Modified);
        assert_eq!(f.additions, 1);
        assert_eq!(f.deletions, 1);
        let hunk = &f.hunks[0];
        // 3 context + 1 added + 1 removed + 3 context (clamped to file edges)
        assert!(hunk.lines.iter().any(|l| l.kind == DiffLineKind::Added));
        assert!(hunk.lines.iter().any(|l| l.kind == DiffLineKind::Removed));
    }

    #[test]
    fn rename_detected() {
        let dir = init_repo();
        let repo = dir.path();
        let body = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\n";
        std::fs::write(repo.join("orig.txt"), body).unwrap();
        sh(repo, &["add", "."]);
        sh(repo, &["commit", "-q", "-m", "seed"]);
        let base = head_sha(repo);

        sh(repo, &["mv", "orig.txt", "renamed.txt"]);
        sh(repo, &["commit", "-q", "-m", "rename"]);

        let inputs = TaskDiffInputs {
            repo_root: repo,
            task_id: "T3",
            task_base_commit: Some(&base),
            worktree_path: Some(repo),
            merged_commit: None,
        };
        let diff = compute_task_diff(inputs).unwrap();
        // Rename detection should collapse to a single entry.
        assert_eq!(diff.files.len(), 1, "{:#?}", diff.files);
        let f = &diff.files[0];
        assert_eq!(f.status, FileStatus::Renamed);
        assert_eq!(f.path, "renamed.txt");
        assert_eq!(f.old_path.as_deref(), Some("orig.txt"));
    }

    #[test]
    fn deleted_file() {
        let dir = init_repo();
        let repo = dir.path();
        std::fs::write(repo.join("doomed.txt"), "bye\n").unwrap();
        sh(repo, &["add", "."]);
        sh(repo, &["commit", "-q", "-m", "add"]);
        let base = head_sha(repo);

        std::fs::remove_file(repo.join("doomed.txt")).unwrap();
        sh(repo, &["add", "."]);
        sh(repo, &["commit", "-q", "-m", "remove"]);

        let inputs = TaskDiffInputs {
            repo_root: repo,
            task_id: "T4",
            task_base_commit: Some(&base),
            worktree_path: Some(repo),
            merged_commit: None,
        };
        let diff = compute_task_diff(inputs).unwrap();
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].status, FileStatus::Deleted);
        assert_eq!(diff.files[0].new_content.as_deref(), Some(""));
    }

    #[test]
    fn merged_source_when_worktree_gone() {
        let dir = init_repo();
        let repo = dir.path();
        let base = head_sha(repo);
        std::fs::write(repo.join("merged.py"), "x = 1\n").unwrap();
        sh(repo, &["add", "."]);
        sh(repo, &["commit", "-q", "-m", "merge candidate"]);
        let merge_sha = head_sha(repo);

        let inputs = TaskDiffInputs {
            repo_root: repo,
            task_id: "T5",
            task_base_commit: Some(&base),
            worktree_path: None,
            merged_commit: Some(&merge_sha),
        };
        let diff = compute_task_diff(inputs).unwrap();
        match &diff.source {
            DiffSource::MergedFromHistory { merge_commit } => assert_eq!(merge_commit, &merge_sha),
            other => panic!("expected merged source, got {:?}", other),
        }
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, "merged.py");
    }

    #[test]
    fn unavailable_when_no_branch_no_merge_no_worktree() {
        let dir = init_repo();
        let repo = dir.path();
        let base = head_sha(repo);
        let inputs = TaskDiffInputs {
            repo_root: repo,
            task_id: "T_GONE",
            task_base_commit: Some(&base),
            worktree_path: None,
            merged_commit: None,
        };
        let diff = compute_task_diff(inputs).unwrap();
        assert!(matches!(diff.source, DiffSource::Unavailable { .. }));
        assert!(diff.files.is_empty());
    }

    #[test]
    fn unavailable_when_no_base_commit() {
        let dir = init_repo();
        let repo = dir.path();
        let inputs = TaskDiffInputs {
            repo_root: repo,
            task_id: "T_NB",
            task_base_commit: None,
            worktree_path: Some(repo),
            merged_commit: None,
        };
        let diff = compute_task_diff(inputs).unwrap();
        assert!(matches!(diff.source, DiffSource::Unavailable { .. }));
    }

    // -----------------------------------------------------------------
    // Anchor mapping
    // -----------------------------------------------------------------

    fn concern_at(path: &str, line: usize) -> AuditorConcern {
        AuditorConcern {
            category: "correctness".into(),
            severity: "blocking".into(),
            anchor: Some(AuditorAnchor {
                path: path.into(),
                line,
            }),
            rationale: "test".into(),
            reference_proposition_id: None,
        }
    }

    fn build_diff_for_modified() -> TaskDiff {
        let dir = init_repo();
        let repo = dir.path();
        std::fs::write(
            repo.join("file.ts"),
            "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n",
        )
        .unwrap();
        sh(repo, &["add", "."]);
        sh(repo, &["commit", "-q", "-m", "seed"]);
        let base = head_sha(repo);

        // Modify line 5 only — context lines remain unchanged so we can land an anchor
        // on either a hunk line (5) or an unchanged line (10) in the same file.
        std::fs::write(
            repo.join("file.ts"),
            "line1\nline2\nline3\nline4\nLINE5\nline6\nline7\nline8\nline9\nline10\n",
        )
        .unwrap();
        sh(repo, &["add", "."]);
        sh(repo, &["commit", "-q", "-m", "tweak"]);

        let inputs = TaskDiffInputs {
            repo_root: repo,
            task_id: "T_MAP",
            task_base_commit: Some(&base),
            worktree_path: Some(repo),
            merged_commit: None,
        };
        // Must keep the temp dir alive for blob lookups; leak it for the duration of
        // the test — TempDir cleans up on drop, so we let the process exit clean it.
        let diff = compute_task_diff(inputs).unwrap();
        std::mem::forget(dir);
        diff
    }

    #[test]
    fn anchor_on_diff_line() {
        let diff = build_diff_for_modified();
        let mappings = map_concerns_to_diff(&diff, &[concern_at("file.ts", 5)]);
        match &mappings[0].mapping {
            AnchorMapping::OnDiffLine { file_index, hunk_index, line_index } => {
                let line = &diff.files[*file_index].hunks[*hunk_index].lines[*line_index];
                assert_eq!(line.new_lineno, Some(5));
                assert_eq!(line.kind, DiffLineKind::Added);
                assert!(line.content.contains("LINE5"));
            }
            other => panic!("expected OnDiffLine, got {:?}", other),
        }
    }

    #[test]
    fn anchor_on_context_line_within_hunk_resolves_to_diff_line() {
        // Line 4 is a context line *inside* the hunk — it should still map to
        // OnDiffLine because the line *is* part of the hunk's printed lines.
        let diff = build_diff_for_modified();
        let mappings = map_concerns_to_diff(&diff, &[concern_at("file.ts", 4)]);
        assert!(matches!(mappings[0].mapping, AnchorMapping::OnDiffLine { .. }));
    }

    #[test]
    fn anchor_on_unchanged_line_outside_hunk() {
        // Line 10 is well past the hunk's 3-line context window.
        let diff = build_diff_for_modified();
        let mappings = map_concerns_to_diff(&diff, &[concern_at("file.ts", 10)]);
        match &mappings[0].mapping {
            AnchorMapping::OnUnchangedLine { line_in_file, content, .. } => {
                assert_eq!(*line_in_file, 10);
                assert_eq!(content, "line10");
            }
            other => panic!("expected OnUnchangedLine, got {:?}", other),
        }
    }

    #[test]
    fn anchor_file_not_in_diff() {
        let diff = build_diff_for_modified();
        let mappings = map_concerns_to_diff(&diff, &[concern_at("other.ts", 3)]);
        assert!(matches!(mappings[0].mapping, AnchorMapping::FileNotInDiff { .. }));
    }

    #[test]
    fn anchor_unmapped_when_missing_or_invalid() {
        let diff = build_diff_for_modified();
        let no_anchor = AuditorConcern {
            category: "x".into(),
            severity: "advisory".into(),
            anchor: None,
            rationale: "no anchor".into(),
            reference_proposition_id: None,
        };
        let zero_line = concern_at("file.ts", 0);
        let mappings = map_concerns_to_diff(&diff, &[no_anchor, zero_line]);
        assert!(matches!(mappings[0].mapping, AnchorMapping::Unmapped));
        assert!(matches!(mappings[1].mapping, AnchorMapping::Unmapped));
    }
}
