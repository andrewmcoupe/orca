import { useMutation, useQuery } from "@tanstack/react-query";
import { phaseRunsApi } from "./api";
import type { PhaseRun, PhaseRunChunk } from "./types";

export const phaseRunKeys = {
  list: (workspaceId: string, taskId: string) =>
    ["phase_run", "list", workspaceId, taskId] as const,
  output: (phaseRunId: string) =>
    ["phase_run", phaseRunId, "output"] as const,
};

export function usePhaseRuns(workspaceId: string, taskId: string | undefined) {
  return useQuery<PhaseRun[]>({
    queryKey: taskId
      ? phaseRunKeys.list(workspaceId, taskId)
      : ["phase_run", "list", "__pending__"],
    queryFn: () => phaseRunsApi.listForTask(taskId!),
    enabled: !!taskId,
  });
}

export function usePhaseRunOutput(phaseRunId: string) {
  return useQuery<PhaseRunChunk[]>({
    queryKey: phaseRunKeys.output(phaseRunId),
    queryFn: () => phaseRunsApi.listOutput(phaseRunId),
  });
}

export function useStartFakePhase() {
  return useMutation({
    mutationFn: ({ taskId, phase }: { taskId: string; phase: string }) =>
      phaseRunsApi.startFake(taskId, phase),
  });
}

export function useStartRealPhase() {
  return useMutation({
    mutationFn: (vars: {
      taskId: string;
      phase: string;
      providerId: string;
      options: Record<string, unknown>;
    }) => phaseRunsApi.startReal(vars),
  });
}

export function useStartTask() {
  return useMutation({
    mutationFn: (taskId: string) => phaseRunsApi.startTask(taskId),
  });
}

export function useStartTaskPhase() {
  return useMutation({
    mutationFn: ({ taskId, phase }: { taskId: string; phase: string }) =>
      phaseRunsApi.startTaskPhase(taskId, phase),
  });
}

export function useCancelPhaseRun() {
  return useMutation({
    mutationFn: (phaseRunId: string) => phaseRunsApi.cancel(phaseRunId),
  });
}
