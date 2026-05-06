import { invoke } from "@tauri-apps/api/core";
import type { TaskDiffWithMappings, UnchangedFileContent } from "./types";
import type { ThemeMode } from "@/lib/theme";

export const diffApi = {
  getTaskDiff: (taskId: string, theme: ThemeMode) =>
    invoke<TaskDiffWithMappings>("get_task_diff", { taskId, theme }),
  refreshTaskDiff: (taskId: string, theme: ThemeMode) =>
    invoke<TaskDiffWithMappings>("refresh_task_diff", { taskId, theme }),
  getUnchangedFileContent: (taskId: string, path: string) =>
    invoke<UnchangedFileContent>("get_unchanged_file_content", { taskId, path }),
};
