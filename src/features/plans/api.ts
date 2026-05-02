import { invoke } from "@tauri-apps/api/core";
import type { Plan, PlanSource } from "./types";

export type CreatePlanInput = {
  title: string;
  description: string;
  source: PlanSource;
  source_metadata?: Record<string, unknown> | null;
};

export type RevisePlanInput = {
  planId: string;
  title: string;
  description: string;
  reason?: string | null;
};

export const plansApi = {
  list: () => invoke<Plan[]>("list_plans"),
  get: (id: string) => invoke<Plan | null>("get_plan", { id }),
  create: (input: CreatePlanInput) =>
    invoke<Plan>("create_plan", {
      title: input.title,
      description: input.description,
      source: input.source,
      sourceMetadata: input.source_metadata ?? null,
    }),
  revise: (input: RevisePlanInput) =>
    invoke<Plan>("revise_plan", {
      planId: input.planId,
      title: input.title,
      description: input.description,
      reason: input.reason ?? null,
    }),
  pause: (planId: string, reason: string | null) =>
    invoke<void>("pause_plan", { planId, reason }),
  resume: (planId: string) => invoke<void>("resume_plan", { planId }),
  cancel: (planId: string, reason: string) =>
    invoke<void>("cancel_plan", { planId, reason }),
  archive: (planId: string) => invoke<void>("archive_plan", { planId }),
};
