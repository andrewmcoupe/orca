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

export type BriefingDepth = "quick" | "guided" | "thorough" | "adversarial";

export type AmbiguityStatus = "unresolved" | "assumed" | "user_resolved";

export type RequestClassification = {
  complexity: "low" | "medium" | "high" | string;
  ambiguity: "low" | "medium" | "high" | string;
  risk: "low" | "medium" | "high" | string;
  likely_touched_areas: string[];
  recommended_depth: BriefingDepth | string;
  repo_scanning_needed: boolean;
  multi_model_critique_justified: boolean;
};

export type BriefingBudgetEstimate = {
  depth: BriefingDepth | string;
  cost_level: "low" | "medium" | "high" | string;
  risk_level: "low" | "medium" | "high" | string;
  confidence: number;
  token_strategy: string;
  expensive_steps: string[];
};

export type AmbiguityItem = {
  id: string;
  question: string;
  why_it_matters: string;
  risk_if_unanswered: string;
  recommended_default_assumption: string;
  user_input_required: boolean;
  status: AmbiguityStatus | string;
  user_answer?: string | null;
};

export type PersonaModelMapping = {
  persona: string;
  provider: string;
  model: string;
  fallback_used: boolean;
  warning?: string | null;
};

export type StructuredBrief = {
  goal: string;
  user_value: string;
  target_users: string[];
  non_goals: string[];
  codebase_context: string;
  relevant_files: RelevantFile[];
  required_behavior: string[];
  ux_requirements: string[];
  data_api_requirements: string[];
  permissions_security: string[];
  edge_cases: string[];
  tests_required: string[];
  risks: string[];
  approved_assumptions: string[];
  open_questions: string[];
  task_graph: string[];
  acceptance_criteria: string[];
};

export type BriefingReadinessStatus =
  | "ready_for_tasks"
  | "ready_with_assumptions"
  | "blocked_needs_user_input";

export type BriefingDraft = {
  title: string;
  description: string;
  tasks: DraftTask[];
  assumptions: DraftAssumption[];
  classification?: RequestClassification | null;
  budget_estimate?: BriefingBudgetEstimate | null;
  ambiguity_ledger?: AmbiguityItem[];
  structured_brief?: StructuredBrief | null;
  approved_assumptions?: string[];
  open_questions?: string[];
  persona_model_mapping?: PersonaModelMapping[];
  persona_artifacts?: Record<string, unknown>[];
  readiness_status?: BriefingReadinessStatus | string;
  confidence_score?: number | null;
  recommended_depth?: BriefingDepth | string | null;
};

export type ImportedBriefingSource = {
  provider: "linear" | "jira" | string;
  external_id: string;
  identifier: string;
  title: string;
  url: string;
  imported_at: number;
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

export type AmbiguityAnswer = {
  ambiguity_id: string;
  answer: string;
};

export type BriefingEdits = {
  title?: string | null;
  description?: string | null;
  task_edits: TaskEdit[];
  task_additions: DraftTask[];
  task_removals: string[];
  assumption_pushbacks: AssumptionPushback[];
  ambiguity_answers: AmbiguityAnswer[];
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
  imported_sources: ImportedBriefingSource[];
  provider: string;
  model: string;
  briefing_depth: BriefingDepth | string;
  persona_config: Record<string, unknown> | null;
  persona_artifacts: Record<string, unknown>[];
  active_persona: Record<string, unknown> | null;
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
  ambiguity_answers: [],
  general_notes: null,
});
