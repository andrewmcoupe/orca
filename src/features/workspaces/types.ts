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

export type PhaseType = "test_author" | "implementer" | "auditor";

export type ModelChoice = {
  provider: string;
  model: string;
};

export type PhaseConfig = {
  phases: PhaseType[];
  gate_overrides: Record<string, string[]> | null;
  models?: Record<string, ModelChoice> | null;
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

export type WorkspaceSettings = {
  default_phase_config: PhaseConfig;
  gates: Record<string, GateConfig>;
  phase_gates: Record<string, string[]>;
  default_models: Record<string, ModelChoice>;
  worktree_init?: WorktreeInitSettings;
  phase_timeouts?: PhaseTimeoutSettings;
  subprocess?: SubprocessSettings;
};

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
