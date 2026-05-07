export type DiffLineKind = "context" | "added" | "removed";

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export type DiffSource =
  | { kind: "worktree"; path: string }
  | { kind: "merged_from_history"; merge_commit: string }
  | { kind: "branch_only"; branch: string; branch_head: string }
  | { kind: "unavailable"; reason: string };

export type HighlightedDiffLine = {
  kind: DiffLineKind;
  old_lineno: number | null;
  new_lineno: number | null;
  /** Pre-rendered span sequence — already escaped, no `<pre>` wrapper. */
  html: string;
};

export type HighlightedDiffHunk = {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  header: string | null;
  lines: HighlightedDiffLine[];
};

export type HighlightedDiffFile = {
  path: string;
  old_path: string | null;
  status: FileStatus;
  is_binary: boolean;
  hunks: HighlightedDiffHunk[];
  new_lines_html: string[] | null;
  old_lines_html: string[] | null;
  language: string | null;
  additions: number;
  deletions: number;
};

export type HighlightedTaskDiff = {
  task_id: string;
  base_commit: string;
  head_commit: string;
  source: DiffSource;
  files: HighlightedDiffFile[];
  computed_at: number;
  additions: number;
  deletions: number;
};

export type AuditorAnchor = { path: string; line: number };

export type AuditorConcern = {
  category: string;
  severity: string;
  anchor: AuditorAnchor | null;
  rationale: string;
  reference_proposition_id: string | null;
};

export type AnchorMapping =
  | {
      kind: "on_diff_line";
      file_index: number;
      hunk_index: number;
      line_index: number;
    }
  | {
      kind: "on_unchanged_line";
      file_index: number;
      line_in_file: number;
      content: string;
    }
  | { kind: "file_not_in_diff"; path: string; line: number }
  | { kind: "unmapped" };

export type MappedConcern = {
  concern: AuditorConcern;
  mapping: AnchorMapping;
};

export type AuditorVerdictSummary = {
  phase_run_id: string;
  verdict: string;
  confidence: number;
  summary: string;
  created_at: number;
};

export type TaskDiffWithMappings = {
  diff: HighlightedTaskDiff;
  mapped_concerns: MappedConcern[];
  auditor_verdict: AuditorVerdictSummary | null;
  is_live: boolean;
};

export type UnchangedFileContent = {
  path: string;
  content: string;
  language: string | null;
};
