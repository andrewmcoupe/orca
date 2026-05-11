export type Workspace = {
  id: string;
  path: string;
  name: string;
  archived: boolean;
  archived_reason: string | null;
  created_at: number;
  updated_at: number;
};

export type ActiveWorkspaceInfo = {
  id: string;
  path: string;
};

export type WorkspaceStats = {
  workspace_id: string;
  plan_count: number;
  active_plan_count: number;
  paused_plan_count: number;
  completed_plan_count: number;
  task_count: number;
  running_task_count: number;
  awaiting_review_task_count: number;
  queued_task_count: number;
  blocked_task_count: number;
  merged_task_count: number;
  failed_task_count: number;
  updated_at: number | null;
  error: string | null;
};

export type WorkspaceHomeTask = {
  workspace_id: string;
  workspace_name: string;
  workspace_path: string;
  plan_id: string;
  plan_title: string;
  task_id: string;
  task_title: string;
  task_status: string;
  updated_at: number;
  attention_kind: "auditor_approved" | "auditor_returned" | "phase_failed" | string | null;
  verdict: "approve" | "revise" | "reject" | string | null;
  phase: PhaseType | string | null;
  phase_status: "running" | "completed" | "failed" | string | null;
  phase_run_id: string | null;
  phase_started_at: number | null;
  phase_updated_at: number | null;
  error_message: string | null;
};

export type WorkspaceHomeWorkspace = {
  workspace_id: string;
  name: string;
  path: string;
  last_activity_at: number;
  awaiting_review_count: number;
  in_flight_count: number;
  failed_count: number;
  merged_count: number;
  error: string | null;
};

export type WorkspaceHomeDispatch = {
  workspace_count: number;
  plan_count: number;
  in_flight_count: number;
  failed_count: number;
  merged_count: number;
  awaiting_review_count: number;
  awaiting_review_workspace_count: number;
  most_recent_workspace_id: string | null;
  needs_attention: WorkspaceHomeTask[];
  in_flight: WorkspaceHomeTask[];
  recent_activity: WorkspaceHomeTask[];
  workspaces: WorkspaceHomeWorkspace[];
};

export type PhaseType = "test_author" | "implementer" | "auditor";

export type ModelChoice = {
  provider: string;
  model: string;
};

export type BriefingDepth = "quick" | "guided" | "thorough" | "adversarial";

export type BriefingPersona =
  | "intent_extractor"
  | "codebase_cartographer"
  | "ambiguity_hunter"
  | "implementation_planner"
  | "skeptic"
  | "final_synthesizer";

export type BriefingPersonaConfig = {
  global_default?: ModelChoice | null;
  personas?: Record<string, ModelChoice | null>;
};

export type PermissionMode = "plan" | "acceptEdits" | "bypassPermissions";

/** Modes the UI is allowed to surface for each phase. The auditor never sees
 * `bypassPermissions` (verification phase shouldn't get full trust). `plan` is
 * unavailable for every phase — the model can call ExitPlanMode and stall waiting
 * for an approval our closed-stdin subprocess can't deliver. The literal stays in
 * the `PermissionMode` union for back-compat with stored values; the resolver and
 * UI both filter it out. */
export const PERMISSION_MODES_FOR_PHASE: Record<PhaseType, PermissionMode[]> = {
  test_author: ["acceptEdits", "bypassPermissions"],
  implementer: ["acceptEdits", "bypassPermissions"],
  auditor: ["acceptEdits"],
};

export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  plan: "Plan (read-only)",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass permissions",
};

export const PERMISSION_MODE_HELP: Record<PermissionMode, string> = {
  plan: "Read-only. The agent can analyse but cannot modify files or run commands.",
  acceptEdits:
    "Auto-accepts file edits within the working directory. Shell commands still prompt — but our subprocess harness denies prompts non-interactively, so unsafe shells fail fast.",
  bypassPermissions:
    "Full trust: the agent runs anything without prompting. Use only when you've decided to trust the agent for this run.",
};

export function bundledDefaultPermissionMode(_phase: PhaseType): PermissionMode {
  return "acceptEdits";
}

export type DefaultPhaseSetting = {
  model?: ModelChoice | null;
  permission_mode?: PermissionMode | null;
};

export type PhaseConfig = {
  phases: PhaseType[];
  gate_overrides: Record<string, string[]> | null;
  models?: Record<string, ModelChoice> | null;
  permission_modes?: Record<string, PermissionMode> | null;
};

export type GateConfig = {
  command: string;
  timeout_seconds: number;
};

export type WorktreeInitSettings = {
  enabled: boolean;
  detection_enabled: boolean;
  user_command: string | null;
  timeout_seconds: number;
};

export type PhaseTimeoutSettings = {
  silence_timeout_seconds: number;
  wall_clock_timeout_seconds: number;
};

export type SubprocessSettings = {
  additional_env: Record<string, string>;
};

export type PreviewServerSettings = {
  enabled: boolean;
  command: string | null;
  base_url: string;
  health_path: string;
  default_route_path: string;
  startup_timeout_seconds: number;
};

export type WorkspaceSettings = {
  default_phase_config: PhaseConfig;
  gates: Record<string, GateConfig>;
  phase_gates: Record<string, string[]>;
  /** Legacy field kept for back-compat; prefer `default_phase_settings[phase].model`. */
  default_models: Record<string, ModelChoice>;
  /** Per-phase model + permission mode defaults. Tasks inherit these on creation. */
  default_phase_settings?: Record<string, DefaultPhaseSetting>;
  /** When true, ⌘N quick-task skips the per-phase preview screen. Default false. */
  skip_preview_for_quick_tasks?: boolean;
  worktree_init?: WorktreeInitSettings;
  phase_timeouts?: PhaseTimeoutSettings;
  subprocess?: SubprocessSettings;
  preview_server?: PreviewServerSettings;
  briefing_personas?: BriefingPersonaConfig;
};

/**
 * Resolve the (model, permission_mode) for a phase using the same precedence as the
 * backend: task `phase_config` overrides > workspace `default_phase_settings` >
 * legacy `default_models` > bundled fallback. Mirrors `settings::resolve_phase_settings`
 * in Rust; if you change the order there, change it here too.
 */
export function resolvePhaseSettings(
  workspace: WorkspaceSettings,
  taskPhaseConfig: PhaseConfig,
  phase: PhaseType,
): { model: ModelChoice | null; permission_mode: PermissionMode } {
  const allowed = PERMISSION_MODES_FOR_PHASE[phase];
  const taskMode = taskPhaseConfig.permission_modes?.[phase];
  const wsSetting = workspace.default_phase_settings?.[phase];
  const wsMode = wsSetting?.permission_mode;
  const candidate =
    (taskMode && allowed.includes(taskMode) && taskMode) ||
    (wsMode && allowed.includes(wsMode) && wsMode) ||
    bundledDefaultPermissionMode(phase);

  const taskModel = taskPhaseConfig.models?.[phase] ?? null;
  const wsModelNew = wsSetting?.model ?? null;
  const wsModelLegacy = workspace.default_models?.[phase] ?? null;
  const model = taskModel ?? wsModelNew ?? wsModelLegacy ?? null;

  return { model, permission_mode: candidate };
}

export const DEFAULT_WORKTREE_INIT: WorktreeInitSettings = {
  enabled: true,
  detection_enabled: true,
  user_command: null,
  timeout_seconds: 600,
};

export const DEFAULT_PHASE_TIMEOUTS: PhaseTimeoutSettings = {
  silence_timeout_seconds: 300,
  wall_clock_timeout_seconds: 1800,
};

export const DEFAULT_SUBPROCESS_SETTINGS: SubprocessSettings = {
  additional_env: {},
};

export const DEFAULT_PREVIEW_SERVER_SETTINGS: PreviewServerSettings = {
  enabled: false,
  command: null,
  base_url: "http://127.0.0.1:5173",
  health_path: "/",
  default_route_path: "/",
  startup_timeout_seconds: 60,
};
