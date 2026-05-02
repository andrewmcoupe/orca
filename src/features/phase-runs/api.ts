import { invoke } from "@tauri-apps/api/core";
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
  }) => invoke<string>("start_real_phase", params),
  cancel: (phaseRunId: string) =>
    invoke<boolean>("cancel_phase_run", { phaseRunId }),
};
