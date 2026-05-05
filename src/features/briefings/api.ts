import { invoke } from "@tauri-apps/api/core";
import type { Plan } from "@/features/plans/types";
import type {
  Briefing,
  BriefingEdits,
  BriefingHistoryEntry,
} from "./types";

/**
 * Tauri command shims for the briefing flow. Generation is fire-and-forget
 * (see `generate` / `refine` below): the command returns the post-Started
 * `Briefing` projection so React Query can flip to the "generating" state
 * immediately, but the work itself completes in the background and is
 * observed via the global `projection_updated` listener invalidating the
 * briefing's detail query.
 */
export const briefingsApi = {
  start: (input: {
    initial_description: string;
    provider: string;
    model: string;
  }) =>
    invoke<Briefing>("start_briefing", {
      initialDescription: input.initial_description,
      provider: input.provider,
      model: input.model,
    }),
  /**
   * Kick off the initial draft. Returns the briefing projection with
   * `is_generating: true` set; the eventual `BriefingDraftProduced` /
   * `…Failed` / `…Cancelled` event lands asynchronously and triggers a
   * cache invalidation through the live-updates provider.
   */
  generate: (briefingId: string) =>
    invoke<Briefing>("generate_briefing_draft", { briefingId }),
  applyEdits: (briefingId: string, edits: BriefingEdits) =>
    invoke<void>("apply_briefing_edits", { briefingId, edits }),
  /** Same fire-and-forget contract as `generate`, but for subsequent drafts. */
  refine: (briefingId: string) =>
    invoke<Briefing>("refine_briefing", { briefingId }),
  accept: (briefingId: string) =>
    invoke<Plan>("accept_briefing", { briefingId }),
  /**
   * Cancel only the in-flight generation. The briefing remains active and
   * can be regenerated. Idempotent: succeeds silently if nothing is running.
   */
  cancelGeneration: (briefingId: string) =>
    invoke<void>("cancel_briefing_generation", { briefingId }),
  /**
   * Hard-cancel the entire briefing (status -> cancelled). Also implicitly
   * cancels any in-flight generation.
   */
  cancel: (briefingId: string) =>
    invoke<void>("cancel_briefing", { briefingId }),
  get: (briefingId: string) =>
    invoke<Briefing | null>("get_briefing", { briefingId }),
  listActive: () => invoke<Briefing[]>("list_active_briefings"),
  listHistory: (briefingId: string) =>
    invoke<BriefingHistoryEntry[]>("list_briefing_history", { briefingId }),
};
