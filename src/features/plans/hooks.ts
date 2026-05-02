import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { plansApi, type CreatePlanInput, type RevisePlanInput } from "./api";
import type { Plan } from "./types";

export const planKeys = {
  list: (workspaceId: string | null | undefined) =>
    ["plan", "list", workspaceId ?? null] as const,
  detail: (planId: string) => ["plan", planId] as const,
};

export function usePlans(workspaceId: string | null | undefined) {
  return useQuery<Plan[]>({
    queryKey: planKeys.list(workspaceId),
    queryFn: plansApi.list,
    enabled: !!workspaceId,
  });
}

export function usePlan(planId: string | undefined) {
  return useQuery<Plan | null>({
    queryKey: planId ? planKeys.detail(planId) : ["plan", "__pending__"],
    queryFn: () => plansApi.get(planId!),
    enabled: !!planId,
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePlanInput) => plansApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plan"] }),
  });
}

export function useRevisePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RevisePlanInput) => plansApi.revise(input),
    onSuccess: (plan) => {
      qc.invalidateQueries({ queryKey: planKeys.detail(plan.id) });
      qc.invalidateQueries({ queryKey: ["plan", "list"] });
    },
  });
}

export function usePausePlan() {
  return useMutation({
    mutationFn: ({ planId, reason }: { planId: string; reason: string | null }) =>
      plansApi.pause(planId, reason),
  });
}

export function useResumePlan() {
  return useMutation({
    mutationFn: (planId: string) => plansApi.resume(planId),
  });
}

export function useCancelPlan() {
  return useMutation({
    mutationFn: ({ planId, reason }: { planId: string; reason: string }) =>
      plansApi.cancel(planId, reason),
  });
}

export function useArchivePlan() {
  return useMutation({
    mutationFn: (planId: string) => plansApi.archive(planId),
  });
}
