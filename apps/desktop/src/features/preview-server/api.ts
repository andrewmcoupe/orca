import { invoke } from "@tauri-apps/api/core";
import type { PreviewServerStatus } from "./types";

export const previewServerApi = {
  start: (taskId: string, routePath: string) =>
    invoke<PreviewServerStatus>("start_preview_server", {
      taskId,
      routePath,
    }),
  status: () =>
    invoke<PreviewServerStatus>("get_preview_server_status"),
  stop: () => invoke<void>("stop_preview_server"),
};
