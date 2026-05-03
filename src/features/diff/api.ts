import { invoke } from "@tauri-apps/api/core";
import type { TaskDiffWithMappings, UnchangedFileContent } from "./types";

export const diffApi = {
  getTaskDiff: (taskId: string) =>
    invoke<TaskDiffWithMappings>("get_task_diff", { taskId }),
  refreshTaskDiff: (taskId: string) =>
    invoke<TaskDiffWithMappings>("refresh_task_diff", { taskId }),
  getUnchangedFileContent: (taskId: string, path: string) =>
    invoke<UnchangedFileContent>("get_unchanged_file_content", { taskId, path }),
};
