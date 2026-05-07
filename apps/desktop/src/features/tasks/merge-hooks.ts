import { useMutation, useQuery } from "@tanstack/react-query";
import {
  mergeApi,
  type MergeAttempt,
  type MergeStrategy,
} from "./merge-api";

export const mergeKeys = {
  latestAttempt: (taskId: string) =>
    ["task", taskId, "latestMergeAttempt"] as const,
};

/**
 * Fire `analyze_task_merge`. The backend may emit `TaskMergeAttempted` (on conflict)
 * or `TaskMerged` (when already-merged short-circuits) — projection invalidation is
 * handled globally by the existing `projection_updated` listener, so callers don't
 * need to invalidate here.
 */
export function useAnalyzeTaskMerge() {
  return useMutation({
    mutationFn: (taskId: string) => mergeApi.analyze(taskId),
  });
}

export function useExecuteTaskMerge() {
  return useMutation({
    mutationFn: (input: {
      taskId: string;
      strategy: MergeStrategy;
      commitMessage: string;
    }) =>
      mergeApi.execute(input.taskId, input.strategy, input.commitMessage),
  });
}

export function useLatestMergeAttempt(taskId: string | undefined) {
  return useQuery<MergeAttempt | null>({
    queryKey: taskId
      ? mergeKeys.latestAttempt(taskId)
      : ["task", "__pending__", "latestMergeAttempt"],
    queryFn: () => mergeApi.latestAttempt(taskId!),
    enabled: !!taskId,
  });
}
