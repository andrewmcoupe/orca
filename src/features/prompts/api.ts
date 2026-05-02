import { invoke } from "@tauri-apps/api/core";

export type PhaseType = "test_author" | "implementer" | "auditor";

export type ResolvedPrompt = {
  phase: string;
  content: string;
  is_customised: boolean;
};

export const promptsApi = {
  get: (phase: PhaseType) =>
    invoke<ResolvedPrompt>("get_prompt", { phase }),
  save: (phase: PhaseType, content: string) =>
    invoke<void>("save_prompt", { phase, content }),
  reset: (phase: PhaseType) => invoke<void>("reset_prompt", { phase }),
};
