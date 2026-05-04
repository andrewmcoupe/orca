import { invoke } from "@tauri-apps/api/core";
import type { StartTaskResult } from "@/features/tasks/types";
import type { PhaseRun, PhaseRunChunk } from "./types";

export const phaseRunsApi = {
  listForTask: (taskId: string) =>
    invoke<PhaseRun[]>("list_phase_runs", { taskId }),
  listOutput: (phaseRunId: string) =>
    invoke<PhaseRunChunk[]>("list_phase_run_output", { phaseRunId }),
  startFake: (taskId: string, phase: string) =>
    invoke<string>("start_fake_phase", { taskId, phase }),
  startReal: (params: {
    taskId: string;
    phase: string;
    providerId: string;
    options: Record<string, unknown>;
    isRetry?: boolean;
    retryContext?: string | null;
    isRetryOf?: string | null;
  }) => invoke<string>("start_real_phase", params),
  /** Pipeline entry point — starts the first phase from the task's phase_config,
   * or queues the task if blocked. Pass `forceRun: true` to bypass the queue
   * check (Brief 4: "Run anyway (ignore dependencies)" overflow option). */
  startTask: (taskId: string, forceRun?: boolean) =>
    invoke<StartTaskResult>("start_task", { taskId, forceRun: forceRun ?? false }),
  /** Dispatch a single phase using the task's resolved settings. Used for the
   *  toolbar's "Re-run auditor only" action so the user doesn't have to walk back
   *  through the prior phases. */
  startTaskPhase: (taskId: string, phase: string) =>
    invoke<string>("start_task_phase", { taskId, phase }),
  cancel: (phaseRunId: string) =>
    invoke<boolean>("cancel_phase_run", { phaseRunId }),
};
