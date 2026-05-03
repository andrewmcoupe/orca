export type PlanSource =
  | "manual"
  | "prd_file"
  | "linear"
  | "github_issue"
  | "briefing";

export type PlanStatus =
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "archived";

export type Plan = {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  source: PlanSource;
  source_metadata: Record<string, unknown> | null;
  status: PlanStatus;
  pause_reason: string | null;
  cancel_reason: string | null;
  task_count: number;
  running_task_count: number;
  done_task_count: number;
  failed_task_count: number;
  created_at: number;
  updated_at: number;
};
