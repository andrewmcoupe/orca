import { invoke } from "@tauri-apps/api/core";
import type {
  AuditorVerdict,
  FileOverlap,
  PermissionMode,
  PhaseConfig,
  PhaseType,
  Task,
} from "./types";

export type UpdateTaskPhaseConfigInput = {
  taskId: string;
  phase: PhaseType;
  provider: string;
  model: string;
  permissionMode: PermissionMode;
};

export type CreateTaskInput = {
  planId: string;
  title: string;
  specMarkdown: string;
  /** Optional override; if absent, the task inherits the workspace default. */
  phaseConfig?: PhaseConfig;
  /** Optional: declared dependencies on other tasks in the same plan. */
  dependsOn?: string[];
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
      dependsOn: input.dependsOn ?? null,
    }),
  updateDependencies: (taskId: string, dependsOn: string[]) =>
    invoke<Task>("update_task_dependencies", { taskId, dependsOn }),
  unqueue: (taskId: string) => invoke<Task>("unqueue_task", { taskId }),
  detectFileOverlap: (taskId: string) =>
    invoke<FileOverlap[]>("detect_task_file_overlap", { taskId }),
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
  retryWorktreeInit: (taskId: string) =>
    invoke<void>("retry_worktree_init", { taskId }),
  skipWorktreeInit: (taskId: string) =>
    invoke<void>("skip_worktree_init", { taskId }),
  updatePhaseConfig: (input: UpdateTaskPhaseConfigInput) =>
    invoke<Task>("update_task_phase_config", {
      taskId: input.taskId,
      phase: input.phase,
      provider: input.provider,
      model: input.model,
      permissionMode: input.permissionMode,
    }),
  resetPhaseConfig: (taskId: string, phase: PhaseType) =>
    invoke<Task>("reset_task_phase_config", { taskId, phase }),
};
