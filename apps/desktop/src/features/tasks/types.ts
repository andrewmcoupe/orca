export type TaskStatus =
  | "draft"
  | "running"
  | "awaiting_review"
  | "approved"
  | "merged"
  | "cancelled"
  | "archived"
  | "failed";

export type TaskCatchUpState = "none" | "clean" | "dirty" | "colliding";

export type PhaseType = "test_author" | "implementer" | "auditor";

export type ModelChoice = {
  provider: string;
  model: string;
};

export type PermissionMode = "plan" | "acceptEdits" | "bypassPermissions";

export type PhaseConfig = {
  phases: PhaseType[];
  gate_overrides: Record<string, string[]> | null;
  models?: Record<string, ModelChoice> | null;
  permission_modes?: Record<string, PermissionMode> | null;
};

export type PipelineSnapshotStatus =
  | "idle"
  | "running"
  | "blocked"
  | "failed"
  | "awaiting_review"
  | "complete";

export type PipelineItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "passed";

export type PipelinePhaseItem = {
  kind: "phase";
  id: string;
  phase: PhaseType;
  status: PipelineItemStatus;
  phase_run_id: string | null;
  provider: string | null;
  model: string | null;
  permission_mode: PermissionMode;
  started_at: number | null;
  completed_at: number | null;
};

export type PipelineGateItem = {
  kind: "gate";
  id: string;
  after_phase: PhaseType;
  name: string;
  command: string;
  timeout_seconds: number;
  status: PipelineItemStatus;
  phase_run_id: string | null;
  event_id: string | null;
  started_at: number | null;
  completed_at: number | null;
};

export type PipelineItem = PipelinePhaseItem | PipelineGateItem;

export type TaskPipelineSnapshot = {
  task_id: string;
  config_version: number;
  status: PipelineSnapshotStatus;
  active_item_id: string | null;
  items: PipelineItem[];
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
  /** 'initialized' (success or user-skipped) | 'failed' | null (not yet run). */
  worktree_init_status: string | null;
  worktree_init_command: string | null;
  worktree_init_exit_code: number | null;
  worktree_init_duration_ms: number | null;
  /** Mirrors the `detection_kind` field on the init events. */
  worktree_init_detection_kind: string | null;
  worktree_init_output: string | null;
  /** Original snapshot from `TaskCreated`. Immutable after the fact. */
  phase_config: PhaseConfig;
  /** Latest effective config — original snapshot plus any per-task edits. The
   * pipeline resolves against this; the UI compares it to the workspace default
   * to surface the customisation indicator on phase cards. */
  current_phase_config: PhaseConfig;
  task_base_commit: string | null;
  catch_up_state: TaskCatchUpState | string;
  catch_up_checked_at: number | null;
  catch_up_target_sha: string | null;
  catch_up_conflicts: string[];
  /** Brief 4: task dependency declarations (other task IDs in the same plan). */
  depends_on: string[];
  /** Computed by the backend: any dep not in `merged` state. */
  is_blocked: boolean;
  /** User clicked Run while blocked; queue manager auto-starts when unblocked. */
  is_queued: boolean;
  /** Unix millis at which the queue manager unblocked this task. Display-only. */
  unblocked_at: number | null;
  last_unblocking_task_id: string | null;
  created_at: number;
  updated_at: number;
};

/** Pre-start file-overlap detection — see `detectTaskFileOverlap`. */
export type FileOverlap = {
  other_task_id: string;
  other_task_title: string;
  overlapping_files: string[];
};

/** Discriminated result from `start_task` — either we started the first phase
 * or the task is blocked and got queued for auto-start. */
export type StartTaskResult =
  | { kind: "started"; phase_run_id: string }
  | { kind: "queued"; task_id: string };

/** Typed errors returned by `update_task_dependencies` / `create_task` when
 * dep validation fails. The backend serialises `DependencyError` as JSON
 * inside the error string; we parse it on the frontend so the UI can render
 * inline messages keyed off `kind`. Falls back to a free-form message when
 * the string isn't JSON. */
export type DependencyValidationError =
  | { kind: "NotFound"; details: string[] }
  | { kind: "CrossPlan"; details: { offending_task_ids: string[]; own_plan_id: string } }
  | { kind: "Cycle"; details: { path: string[] } }
  | { kind: "SelfDependency"; details?: undefined }
  | { kind: "Duplicate"; details: string[] }
  | { kind: "Db"; details: string };

export function parseDependencyError(
  err: unknown,
): DependencyValidationError | null {
  if (typeof err !== "string") return null;
  try {
    const parsed = JSON.parse(err);
    if (parsed && typeof parsed === "object" && "kind" in parsed) {
      return parsed as DependencyValidationError;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}
