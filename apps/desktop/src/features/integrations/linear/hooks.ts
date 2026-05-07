import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { linearApi } from "./api";

export const linearKeys = {
  connection: () => ["integration", "linear", "connection"] as const,
};

export function useLinearConnectionStatus(enabled = true) {
  return useQuery({
    queryKey: linearKeys.connection(),
    queryFn: linearApi.connectionStatus,
    enabled,
    retry: false,
  });
}

export function useSaveLinearApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: linearApi.saveApiKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: linearKeys.connection() });
    },
  });
}

export function useDisconnectLinear() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: linearApi.disconnect,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: linearKeys.connection() });
    },
  });
}

export function useSearchLinearIssues() {
  return useMutation({
    mutationFn: linearApi.searchIssues,
  });
}
