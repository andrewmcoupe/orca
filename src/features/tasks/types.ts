export type TaskStatus =
  | "draft"
  | "running"
  | "awaiting_review"
  | "approved"
  | "merged"
  | "cancelled"
  | "archived"
  | "failed";

export type PhaseType = "test_author" | "implementer" | "auditor";

export type ModelChoice = {
  provider: string;
  model: string;
};

export type PhaseConfig = {
  phases: PhaseType[];
  gate_overrides: Record<string, string[]> | null;
  models?: Record<string, ModelChoice> | null;
};

export type AuditorVerdictKind = "approve" | "revise" | "reject";

export type AuditorConcernAnchor = {
  path: string;
  line: number;
};

export type AuditorConcern = {
  category: string;
  severity: "blocking" | "advisory" | string;
  anchor: AuditorConcernAnchor | null;
  rationale: string;
  reference_proposition_id: string | null;
};

export type AuditorVerdict = {
  phase_run_id: string;
  task_id: string;
  verdict: AuditorVerdictKind | string;
  confidence: number;
  summary: string;
  concerns: AuditorConcern[];
  created_at: number;
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
  merge_target_branch: string | null;
  merged_at: number | null;
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
