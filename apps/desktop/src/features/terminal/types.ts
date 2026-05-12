export type TerminalSessionInfo = {
  terminal_id: string;
  workspace_id: string;
  task_id: string;
  cwd: string;
  shell: string;
  label: string;
  exited: boolean;
};

export type TerminalAttachInfo = TerminalSessionInfo & {
  scrollback: string[];
};

export type TerminalOutputEvent = {
  terminal_id: string;
  data: string;
};

export type TerminalExitEvent = {
  terminal_id: string;
  exit_code: number | null;
};

export type TerminalLabelEvent = {
  terminal_id: string;
  label: string;
};
