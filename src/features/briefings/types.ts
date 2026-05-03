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
};

export type PathValidationResult = {
  task_id: string;
  path: string;
  exists: boolean;
};

export type BriefingStatus = "active" | "completed" | "cancelled";

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
});
