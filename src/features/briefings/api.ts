import { invoke } from "@tauri-apps/api/core";
import type { Plan } from "@/features/plans/types";
import type {
  Briefing,
  BriefingDraft,
  BriefingEdits,
  BriefingHistoryEntry,
} from "./types";

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
  generate: (briefingId: string) =>
    invoke<BriefingDraft>("generate_briefing_draft", { briefingId }),
  applyEdits: (briefingId: string, edits: BriefingEdits) =>
    invoke<void>("apply_briefing_edits", { briefingId, edits }),
  refine: (briefingId: string) =>
    invoke<BriefingDraft>("refine_briefing", { briefingId }),
  accept: (briefingId: string) =>
    invoke<Plan>("accept_briefing", { briefingId }),
  cancel: (briefingId: string) =>
    invoke<void>("cancel_briefing", { briefingId }),
  get: (briefingId: string) =>
    invoke<Briefing | null>("get_briefing", { briefingId }),
  listActive: () => invoke<Briefing[]>("list_active_briefings"),
  listHistory: (briefingId: string) =>
    invoke<BriefingHistoryEntry[]>("list_briefing_history", { briefingId }),
};
