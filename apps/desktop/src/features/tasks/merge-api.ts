import { invoke } from "@tauri-apps/api/core";

export type MergeStrategy = "squash" | "merge";

export type CommitSummary = {
  sha: string;
  message: string;
  author: string;
  timestamp: number;
};

export type DiffSummary = {
  files_changed: number;
  insertions: number;
  deletions: number;
};

export type MergeAnalysis = {
  target_branch: string;
  target_head_sha: string;
  source_branch: string;
  source_head_sha: string;
  source_commits: CommitSummary[];
  diff_summary: DiffSummary;
  conflicts: string[];
  already_merged: boolean;
};

export type ExecutedMerge = {
  commit_sha: string;
  target_branch: string;
  source_branch: string;
  parent_commits: string[];
};

export type MergeAttempt = {
  task_id: string;
  attempted_at: number;
  target_branch: string;
  source_branch: string;
  target_head_sha: string;
  conflicts: string[];
};

/**
 * Errors returned from the analyze/execute commands. The Rust side serializes via
 * `#[serde(tag = "kind", content = "details")]` so the discriminator lives on `kind`
 * and any structured payload on `details`.
 */
export type MergeCommandError =
  | { kind: "NoActiveWorkspace" }
  | { kind: "TaskNotFound" }
  | { kind: "TaskNotApproved" }
  | { kind: "PhaseRunning" }
  | { kind: "NoWorktreeBranch" }
  | { kind: "InvalidStrategy"; details: string }
  | { kind: "DetachedHead" }
  | { kind: "WorkingTreeDirty"; details: { dirty_files: string[] } }
  | { kind: "SourceBranchMissing"; details: string }
  | { kind: "TargetBranchMissing"; details: string }
  | { kind: "Conflicts"; details: { conflicts: string[] } }
  | {
      kind: "AlreadyMerged";
      details: { commit_sha: string; target_branch: string };
    }
  | { kind: "GitError"; details: string }
  | { kind: "InternalError"; details: string };

export function isMergeCommandError(value: unknown): value is MergeCommandError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown };
  return typeof v.kind === "string";
}

export const mergeApi = {
  analyze: (taskId: string) =>
    invoke<MergeAnalysis>("analyze_task_merge", { taskId }),
  execute: (
    taskId: string,
    strategy: MergeStrategy,
    commitMessage: string,
  ) =>
    invoke<ExecutedMerge>("execute_task_merge", {
      taskId,
      strategy,
      commitMessage,
    }),
  latestAttempt: (taskId: string) =>
    invoke<MergeAttempt | null>("get_latest_merge_attempt_for_task", {
      taskId,
    }),
};
