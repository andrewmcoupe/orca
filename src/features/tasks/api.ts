import { invoke } from "@tauri-apps/api/core";
import type { AuditorVerdict, PhaseConfig, Task } from "./types";

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
  passBackToImplementer: (taskId: string, userFeedback: string | null) =>
    invoke<string>("pass_back_to_implementer", {
      taskId,
      userFeedback,
    }),
  reject: (taskId: string) => invoke<void>("reject_task", { taskId }),
  approveAnyway: (taskId: string) =>
    invoke<void>("approve_task_anyway", { taskId }),
  getLatestAuditorVerdict: (taskId: string) =>
    invoke<AuditorVerdict | null>("get_latest_auditor_verdict_for_task", {
      taskId,
    }),
  openInEditor: (taskId: string, path: string, line: number) =>
    invoke<void>("open_in_editor", { taskId, path, line }),
};
