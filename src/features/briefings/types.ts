export type FileCertainty = "Confirmed" | "Candidate";

export type RelevantFile = {
  path: string;
  certainty: FileCertainty;
  reason: string;
};

export type DraftTask = {
  id: string;
  title: string;
  spec_markdown: string;
  relevant_files: RelevantFile[];
};

export type DraftAssumption = {
  id: string;
  statement: string;
};

export type BriefingDraft = {
  title: string;
  description: string;
  tasks: DraftTask[];
  assumptions: DraftAssumption[];
};

export type TaskEdit = {
  task_id: string;
  title?: string | null;
  spec_markdown?: string | null;
  file_additions: RelevantFile[];
  file_removals: string[];
};

export type AssumptionPushback = {
  assumption_id: string;
  pushback: string;
};

export type BriefingEdits = {
  title?: string | null;
  description?: string | null;
  task_edits: TaskEdit[];
  task_additions: DraftTask[];
  task_removals: string[];
  assumption_pushbacks: AssumptionPushback[];
  /** Freeform "anything else" notes for the next refinement. Optional. */
  general_notes?: string | null;
};

export type PathValidationResult = {
  task_id: string;
  path: string;
  exists: boolean;
};

export type BriefingStatus = "active" | "completed" | "cancelled";

/**
 * Background-generation kind. `"initial"` is the first draft for a freshly
 * started briefing; `"refine"` is every subsequent regeneration triggered
 * by the user (typically after applying edits or pushbacks). The kind is
 * surfaced on the `Briefing` projection while a generation is in flight so
 * the UI can label the spinner appropriately ("Drafting…" vs "Refining…").
 */
export type GenerationKind = "initial" | "refine";

export type Briefing = {
  id: string;
  workspace_id: string;
  status: BriefingStatus;
  initial_description: string;
  provider: string;
  model: string;
  current_draft: BriefingDraft | null;
  pending_edits: BriefingEdits | null;
  validation_results: PathValidationResult[] | null;
  generation_count: number;
  /**
   * True between a `BriefingGenerationStarted` event and its terminal
   * counterpart (`BriefingDraftProduced`, `BriefingGenerationFailed`,
   * `BriefingGenerationCancelled`, or `BriefingCancelled`). Drives the
   * spinner on the briefing detail page and the in-flight indicator in
   * the workspace chrome. Mutating commands (start, cancel) trust this as
   * the disable signal rather than tracking their own pending state.
   */
  is_generating: boolean;
  /** `null` when not generating. */
  generation_kind: GenerationKind | null;
  /**
   * Reason for the most recent `BriefingGenerationFailed`. Cleared when a
   * new generation starts or a draft is produced. The briefing detail page
   * surfaces this as a banner with a retry button.
   */
  last_generation_error: string | null;
  final_plan_id: string | null;
  cancel_reason: string | null;
  created_at: number;
  updated_at: number;
};

export type BriefingEventType =
  | "BriefingStarted"
  | "BriefingDraftProduced"
  | "BriefingDraftEdited"
  | "BriefingPushedBack"
  | "BriefingRefineRequested"
  | "BriefingGenerationStarted"
  | "BriefingGenerationFailed"
  | "BriefingGenerationCancelled"
  | "BriefingCompleted"
  | "BriefingCancelled";

export type BriefingHistoryEntry = {
  id: string;
  seq: number;
  event_type: BriefingEventType | string;
  version: number;
  payload: Record<string, unknown>;
  created_at: number;
};

export const emptyEdits = (): BriefingEdits => ({
  title: null,
  description: null,
  task_edits: [],
  task_additions: [],
  task_removals: [],
  assumption_pushbacks: [],
  general_notes: null,
});
