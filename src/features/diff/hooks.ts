import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { diffApi } from "./api";
import type { TaskDiffWithMappings, UnchangedFileContent } from "./types";

type ProjectionUpdated = {
  workspace_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
};

export const diffKeys = {
  byTask: (taskId: string) => ["task-diff", taskId] as const,
  unchangedFile: (taskId: string, path: string) =>
    ["task-diff", taskId, "file", path] as const,
};

/**
 * The diff query is invalidated by the global `projection_updated` listener (it
 * matches `["task", taskId]`), so we keep `staleTime: Infinity` here — react
 * shouldn't be refetching on remount or focus changes, only on explicit
 * invalidation. The live-update polling below adds a safety net.
 */
export function useTaskDiff(taskId: string | undefined) {
  return useQuery<TaskDiffWithMappings>({
    queryKey: taskId
      ? diffKeys.byTask(taskId)
      : ["task-diff", "__pending__"],
    queryFn: () => diffApi.getTaskDiff(taskId!),
    enabled: !!taskId,
    staleTime: Infinity,
  });
}

export function useRefreshTaskDiff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => diffApi.refreshTaskDiff(taskId),
    onSuccess: (data, taskId) => {
      qc.setQueryData(diffKeys.byTask(taskId), data);
    },
  });
}

export function useUnchangedFileContent(
  taskId: string | undefined,
  path: string | undefined,
  enabled = true,
) {
  return useQuery<UnchangedFileContent>({
    queryKey:
      taskId && path
        ? diffKeys.unchangedFile(taskId, path)
        : ["task-diff", "__pending__"],
    queryFn: () => diffApi.getUnchangedFileContent(taskId!, path!),
    enabled: !!taskId && !!path && enabled,
    staleTime: 60_000,
  });
}

/**
 * Live-update plumbing.
 *
 * Two channels:
 *
 * 1. `projection_updated` listener — debounced 500ms. Catches every commit, phase
 *    transition, verdict landing, etc. that involves this task or one of its
 *    phase_runs. We invalidate the diff query rather than calling `refresh_*`
 *    directly so that the cache layer in Rust still gets a chance to short-circuit
 *    when the head commit hasn't moved.
 * 2. 3-second safety poll while `is_live` is true — covers the rare case where an
 *    event slips through (e.g. an external commit to the worktree).
 *
 * The hook does nothing while `is_live` is false; idle tasks have a stable diff
 * and don't need either channel.
 */
export function useTaskDiffLiveUpdates(
  taskId: string | undefined,
  isLive: boolean,
) {
  const qc = useQueryClient();
  const debouncedRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);

  // Channel 1: debounced projection_updated.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    const unlistenP = listen<ProjectionUpdated>(
      "projection_updated",
      (ev) => {
        if (cancelled) return;
        // Trigger on either the task aggregate itself or one of its phase_runs.
        // The phase_run aggregate is keyed by phase_run_id, not task_id, so we
        // accept all phase_run updates and let the cache short-circuit if
        // nothing actually changed for our task. Conservative is fine — the
        // cache makes the no-op cheap.
        const a = ev.payload.aggregate_type;
        const id = ev.payload.aggregate_id;
        if (!(a === "task" && id === taskId) && a !== "phase_run") return;
        if (debouncedRef.current != null) {
          window.clearTimeout(debouncedRef.current);
        }
        debouncedRef.current = window.setTimeout(() => {
          qc.invalidateQueries({ queryKey: diffKeys.byTask(taskId) });
          debouncedRef.current = null;
        }, 500);
      },
    );
    return () => {
      cancelled = true;
      unlistenP.then((fn) => fn());
      if (debouncedRef.current != null) {
        window.clearTimeout(debouncedRef.current);
        debouncedRef.current = null;
      }
    };
  }, [taskId, qc]);

  // Channel 2: safety poll while live.
  useEffect(() => {
    if (!taskId || !isLive) return;
    const id = window.setInterval(() => {
      qc.invalidateQueries({ queryKey: diffKeys.byTask(taskId) });
    }, 3_000);
    pollRef.current = id;
    return () => {
      window.clearInterval(id);
      pollRef.current = null;
    };
  }, [taskId, isLive, qc]);
}
