import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { previewServerApi } from "./api";
import type { PreviewServerStatus } from "./types";

export const PREVIEW_SERVER_STATUS_KEY = ["preview_server", "status"] as const;

export function usePreviewServerStatus() {
  return useQuery<PreviewServerStatus>({
    queryKey: PREVIEW_SERVER_STATUS_KEY,
    queryFn: previewServerApi.status,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "starting" || state === "running" ? 2_000 : false;
    },
  });
}

export function useStartPreviewServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      routePath,
    }: {
      taskId: string;
      routePath: string;
    }) => previewServerApi.start(taskId, routePath),
    onSuccess: (status) => {
      qc.setQueryData(PREVIEW_SERVER_STATUS_KEY, status);
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: PREVIEW_SERVER_STATUS_KEY });
    },
  });
}

export function useStopPreviewServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: previewServerApi.stop,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PREVIEW_SERVER_STATUS_KEY });
    },
  });
}
