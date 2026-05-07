import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { promptsApi, type PhaseType, type ResolvedPrompt } from "./api";

export const promptKeys = {
  resolved: (workspaceId: string, phase: PhaseType) =>
    ["prompt", workspaceId, phase] as const,
};

export function usePrompt(
  workspaceId: string | undefined,
  phase: PhaseType,
) {
  return useQuery<ResolvedPrompt>({
    queryKey: workspaceId
      ? promptKeys.resolved(workspaceId, phase)
      : ["prompt", "__pending__", phase],
    queryFn: () => promptsApi.get(phase),
    enabled: !!workspaceId,
  });
}

export function useSavePrompt(workspaceId: string, phase: PhaseType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => promptsApi.save(phase, content),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: promptKeys.resolved(workspaceId, phase) }),
  });
}

export function useResetPrompt(workspaceId: string, phase: PhaseType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => promptsApi.reset(phase),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: promptKeys.resolved(workspaceId, phase) }),
  });
}
