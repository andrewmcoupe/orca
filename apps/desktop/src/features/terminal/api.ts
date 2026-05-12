import { invoke } from "@tauri-apps/api/core";
import type { TerminalAttachInfo, TerminalSessionInfo } from "./types";

export const terminalApi = {
  create: (taskId: string, cols: number, rows: number) =>
    invoke<TerminalSessionInfo>("create_terminal", {
      taskId,
      cols,
      rows,
    }),
  listForTask: (workspaceId: string, taskId: string) =>
    invoke<TerminalSessionInfo[]>("list_terminals_for_task", {
      workspaceId,
      taskId,
    }),
  attach: (terminalId: string) =>
    invoke<TerminalAttachInfo>("attach_terminal", {
      terminalId,
    }),
  write: (terminalId: string, data: string) =>
    invoke<void>("write_terminal", {
      terminalId,
      data,
    }),
  resize: (terminalId: string, cols: number, rows: number) =>
    invoke<void>("resize_terminal", {
      terminalId,
      cols,
      rows,
    }),
  close: (terminalId: string) =>
    invoke<void>("close_terminal", {
      terminalId,
    }),
};
