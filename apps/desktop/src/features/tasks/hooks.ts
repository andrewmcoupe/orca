import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  tasksApi,
  type CreateTaskInput,
  type UpdateTaskPhaseConfigInput,
} from "./api";
import type { AuditorVerdict, PhaseType, Task } from "./types";

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

export function useRetryWorktreeInit() {
  return useMutation({
    mutationFn: (taskId: string) => tasksApi.retryWorktreeInit(taskId),
  });
}

export function useSkipWorktreeInit() {
  return useMutation({
    mutationFn: (taskId: string) => tasksApi.skipWorktreeInit(taskId),
  });
}

/**
 * Mutation: change provider/model/permission mode for one phase of one task.
 * Invalidates the task detail query on success so phase cards re-render with the
 * new resolved config.
 */
export function useUpdateTaskPhaseConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskPhaseConfigInput) =>
      tasksApi.updatePhaseConfig(input),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: taskKeys.detail(task.id) });
    },
  });
}

/** Revert one phase of one task to the workspace default. */
export function useResetTaskPhaseConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, phase }: { taskId: string; phase: PhaseType }) =>
      tasksApi.resetPhaseConfig(taskId, phase),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: taskKeys.detail(task.id) });
    },
  });
}

/** Replace a task's `depends_on` list. Validation errors (cycle, cross-plan,
 * missing) come back JSON-encoded as the error string — see
 * `parseDependencyError` in types.ts to decode for inline UI. */
export function useUpdateTaskDependencies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      dependsOn,
    }: {
      taskId: string;
      dependsOn: string[];
    }) => tasksApi.updateDependencies(taskId, dependsOn),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: taskKeys.detail(task.id) });
      qc.invalidateQueries({ queryKey: taskKeys.list(task.plan_id) });
    },
  });
}

/** Cancel a queued task's queued state. */
export function useUnqueueTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => tasksApi.unqueue(taskId),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: taskKeys.detail(task.id) });
    },
  });
}
