export type TaskStatus =
  | "draft"
  | "running"
  | "awaiting_review"
  | "merged"
  | "cancelled"
  | "archived"
  | "failed";

export type PhaseType = "test_author" | "implementer" | "auditor";

export type PhaseConfig = {
  phases: PhaseType[];
  gate_overrides: Record<string, string[]> | null;
};

export type Task = {
  id: string;
  workspace_id: string;
  plan_id: string;
  title: string;
  spec_markdown: string;
  status: TaskStatus | string;
  cancel_reason: string | null;
  approved_by: string | null;
  merged_commit_sha: string | null;
  merge_strategy: string | null;
  latest_phase_run_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  worktree_base_commit: string | null;
  worktree_status: string | null;
  worktree_removal_reason: string | null;
  phase_config: PhaseConfig;
  task_base_commit: string | null;
  created_at: number;
  updated_at: number;
};
