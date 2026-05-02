import { invoke } from "@tauri-apps/api/core";
import type { PhaseConfig, Task } from "./types";

export type CreateTaskInput = {
  planId: string;
  title: string;
  specMarkdown: string;
  /** Optional override; if absent, the task inherits the workspace default. */
  phaseConfig?: PhaseConfig;
};

export const tasksApi = {
  listByPlan: (planId: string) =>
    invoke<Task[]>("list_tasks", { planId }),
  get: (id: string) => invoke<Task | null>("get_task", { id }),
  create: (input: CreateTaskInput) =>
    invoke<Task>("create_task", {
      planId: input.planId,
      title: input.title,
      specMarkdown: input.specMarkdown,
      phaseConfig: input.phaseConfig ?? null,
    }),
  markMerged: (taskId: string, commitSha: string, mergeStrategy: string) =>
    invoke<void>("mark_task_merged", {
      taskId,
      commitSha,
      mergeStrategy,
    }),
  cancel: (taskId: string, reason: string) =>
    invoke<void>("cancel_task", { taskId, reason }),
  deleteWorktree: (taskId: string, force: boolean) =>
    invoke<void>("delete_worktree", { taskId, force }),
};
