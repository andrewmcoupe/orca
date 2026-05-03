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

export type WorkspaceSettings = {
  default_phase_config: PhaseConfig;
  gates: Record<string, GateConfig>;
  phase_gates: Record<string, string[]>;
  default_models: Record<string, ModelChoice>;
};
