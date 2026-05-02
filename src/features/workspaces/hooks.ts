import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { workspacesApi } from "./api";
import type { ActiveWorkspaceInfo, Workspace } from "./types";

const WORKSPACE_LIST_KEY = ["workspace", "list", null] as const;
const ACTIVE_WORKSPACE_KEY = ["active_workspace"] as const;

export function useWorkspaces() {
  return useQuery<Workspace[]>({
    queryKey: WORKSPACE_LIST_KEY,
    queryFn: workspacesApi.list,
  });
}

export function useActiveWorkspace() {
  return useQuery<ActiveWorkspaceInfo | null>({
    queryKey: ACTIVE_WORKSPACE_KEY,
    queryFn: workspacesApi.getActive,
  });
}

export function useAddWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: workspacesApi.add,
    onSuccess: () => qc.invalidateQueries({ queryKey: WORKSPACE_LIST_KEY }),
  });
}

export function useRemoveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: workspacesApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: WORKSPACE_LIST_KEY });
      qc.invalidateQueries({ queryKey: ACTIVE_WORKSPACE_KEY });
    },
  });
}

export function useSetActiveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: workspacesApi.setActive,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACTIVE_WORKSPACE_KEY });
    },
  });
}

/**
 * Ensures the backend's active workspace matches the route param.
 * The route param is the source of truth — switching routes must rebind
 * the per-workspace event store before queries fire.
 */
export function useActivateWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  const setActive = useSetActiveWorkspace();
  useEffect(() => {
    if (!workspaceId) return;
    const current = qc.getQueryData<ActiveWorkspaceInfo | null>(
      ACTIVE_WORKSPACE_KEY,
    );
    if (current?.id === workspaceId) return;
    setActive.mutate(workspaceId, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["plan"] });
        qc.invalidateQueries({ queryKey: ["task"] });
        qc.invalidateQueries({ queryKey: ["phase_run"] });
        qc.invalidateQueries({ queryKey: ["recent_events"] });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
}
