import type { PhaseRun } from "@/features/phase-runs/types";
import type { Task, TaskStatus } from "./types";

export type TaskReviewState =
  | "drafting"
  | "under_review"
  | "approved"
  | "ready_to_land"
  | "landed"
  | "rejected"
  | "failed";

type PhaseRunLike = Pick<PhaseRun, "phase" | "status">;

export type TaskStateInput = {
  task: Pick<Task, "status" | "worktree_status" | "worktree_init_status">;
  activeRun?: PhaseRunLike | null;
  latestRun?: PhaseRunLike | null;
};

export const TASK_REVIEW_STATE_LABELS: Record<TaskReviewState, string> = {
  drafting: "Drafting",
  under_review: "Under review",
  approved: "Approved",
  ready_to_land: "Ready to land",
  landed: "Landed",
  rejected: "Rejected",
  failed: "Failed",
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  draft: "Drafting",
  running: "Drafting",
  awaiting_review: "Under review",
  approved: "Approved",
  merged: "Landed",
  cancelled: "Rejected",
  archived: "Archived",
  failed: "Failed",
};

export const TASK_REVIEW_STATE_STYLES: Record<TaskReviewState, string> = {
  drafting: "bg-blue-500/10 text-blue-900 border-blue-500/30 dark:text-blue-200",
  under_review:
    "bg-warning/15 text-warning border-warning/40 dark:text-warning",
  approved: "bg-success/15 text-success border-success/40",
  ready_to_land: "bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-300",
  landed: "bg-primary/10 text-primary border-primary/30",
  rejected: "bg-muted text-muted-foreground border-border",
  failed: "bg-destructive/15 text-destructive border-destructive/40",
};

export function deriveTaskReviewState({
  task,
  activeRun,
  latestRun,
}: TaskStateInput): TaskReviewState {
  if (task.status === "merged") return "landed";
  if (task.status === "cancelled" || task.status === "archived") {
    return "rejected";
  }
  if (task.status === "failed") return "failed";
  if (task.worktree_init_status === "running") return "drafting";
  if (activeRun) {
    return activeRun.phase === "auditor" ? "under_review" : "drafting";
  }
  if (task.status === "approved") {
    return task.worktree_status === "active" ? "ready_to_land" : "approved";
  }
  if (
    task.status === "awaiting_review" ||
    (latestRun?.phase === "auditor" && latestRun.status === "completed")
  ) {
    return "under_review";
  }
  return "drafting";
}

export function displayTaskStatus(status: TaskStatus | string): string {
  return (
    (TASK_STATUS_LABELS as Record<string, string>)[status] ??
    status.replace(/_/g, " ")
  );
}

