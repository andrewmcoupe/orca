import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { linearApi } from "./api";

export const linearKeys = {
  connection: (workspaceId: string | undefined) =>
    ["integration", "linear", "connection", workspaceId ?? "__active__"] as const,
};

export function useLinearConnectionStatus(
  workspaceId?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: linearKeys.connection(workspaceId),
    queryFn: linearApi.connectionStatus,
    enabled,
    retry: false,
  });
}

export function useSaveLinearApiKey(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: linearApi.saveApiKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: linearKeys.connection(workspaceId) });
    },
  });
}

export function useDisconnectLinear(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: linearApi.disconnect,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: linearKeys.connection(workspaceId) });
    },
  });
}

export function useSearchLinearIssues() {
  return useMutation({
    mutationFn: linearApi.searchIssues,
  });
}
