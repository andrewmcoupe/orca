export type PhaseRun = {
  id: string;
  task_id: string;
  phase: string;
  provider: string;
  model: string;
  status: "running" | "completed" | "failed" | "cancelled" | string;
  summary: string | null;
  exit_code: number | null;
  error_kind: string | null;
  error_message: string | null;
  files_changed: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: number;
  completed_at: number | null;
  updated_at: number;
};

export type PhaseRunChunk = {
  chunk_seq: number;
  chunk: string;
  created_at: number;
};
