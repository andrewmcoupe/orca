import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tasksApi, type CreateTaskInput } from "./api";
import type { AuditorVerdict, Task } from "./types";

export const taskKeys = {
  list: (planId: string) => ["task", "list", planId] as const,
  detail: (taskId: string) => ["task", taskId] as const,
  latestVerdict: (taskId: string) =>
    ["task", taskId, "latestAuditorVerdict"] as const,
};

export function useLatestAuditorVerdict(taskId: string | undefined) {
  return useQuery<AuditorVerdict | null>({
    queryKey: taskId
      ? taskKeys.latestVerdict(taskId)
      : ["task", "__pending__", "latestAuditorVerdict"],
    queryFn: () => tasksApi.getLatestAuditorVerdict(taskId!),
    enabled: !!taskId,
  });
}

export function usePassBackToImplementer() {
  return useMutation({
    mutationFn: ({
      taskId,
      userFeedback,
    }: {
      taskId: string;
      userFeedback: string | null;
    }) => tasksApi.passBackToImplementer(taskId, userFeedback),
  });
}

export function useRejectTask() {
  return useMutation({
    mutationFn: (taskId: string) => tasksApi.reject(taskId),
  });
}

export function useApproveTaskAnyway() {
  return useMutation({
    mutationFn: (taskId: string) => tasksApi.approveAnyway(taskId),
  });
}

export function useTasksInPlan(planId: string | undefined) {
  return useQuery<Task[]>({
    queryKey: planId ? taskKeys.list(planId) : ["task", "list", "__pending__"],
    queryFn: () => tasksApi.listByPlan(planId!),
    enabled: !!planId,
  });
}

export function useTask(taskId: string | undefined) {
  return useQuery<Task | null>({
    queryKey: taskId ? taskKeys.detail(taskId) : ["task", "__pending__"],
    queryFn: () => tasksApi.get(taskId!),
    enabled: !!taskId,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => tasksApi.create(input),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: taskKeys.list(task.plan_id) });
      qc.invalidateQueries({ queryKey: ["plan"] });
    },
  });
}

export function useDeleteWorktree() {
  return useMutation({
    mutationFn: ({ taskId, force }: { taskId: string; force: boolean }) =>
      tasksApi.deleteWorktree(taskId, force),
  });
}
