import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveWorkspaceInfo,
  Workspace,
  WorkspaceSettings,
} from "./types";

export const workspacesApi = {
  list: () => invoke<Workspace[]>("list_workspaces"),
  add: (path: string) => invoke<Workspace>("add_workspace", { path }),
  remove: (id: string) => invoke<void>("remove_workspace", { id }),
  setActive: (id: string) =>
    invoke<ActiveWorkspaceInfo>("set_active_workspace", { id }),
  getActive: () =>
    invoke<ActiveWorkspaceInfo | null>("get_active_workspace"),
  getSettings: (workspaceId: string) =>
    invoke<WorkspaceSettings>("get_workspace_settings", { workspaceId }),
  updateSettings: (workspaceId: string, settings: WorkspaceSettings) =>
    invoke<WorkspaceSettings>("update_workspace_settings", {
      workspaceId,
      settings,
    }),
};
