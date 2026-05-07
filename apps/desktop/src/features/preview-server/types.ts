export type PreviewServerStatus = {
  state: "idle" | "starting" | "running" | "failed";
  task_id: string | null;
  worktree_path: string | null;
  base_url: string | null;
  route_path: string | null;
  open_url: string | null;
  started_at: number | null;
  last_error: string | null;
  logs: string[];
};
