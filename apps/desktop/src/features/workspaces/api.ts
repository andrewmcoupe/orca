import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveWorkspaceInfo,
  Workspace,
  WorkspaceHomeDispatch,
  WorkspaceStats,
  WorkspaceSettings,
} from "./types";

export const workspacesApi = {
  getAppSettings: () => invoke<WorkspaceSettings>("get_app_settings"),
  updateAppSettings: (settings: WorkspaceSettings) =>
    invoke<WorkspaceSettings>("update_app_settings", { settings }),
  list: () => invoke<Workspace[]>("list_workspaces"),
  listStats: () => invoke<WorkspaceStats[]>("list_workspace_stats"),
  getHomeDispatch: () =>
    invoke<WorkspaceHomeDispatch>("get_workspace_home_dispatch"),
  add: (path: string) => invoke<Workspace>("add_workspace", { path }),
  remove: (id: string) => invoke<void>("remove_workspace", { id }),
  setActive: (id: string) =>
    invoke<ActiveWorkspaceInfo>("set_active_workspace", { id }),
  getActive: () =>
    invoke<ActiveWorkspaceInfo | null>("get_active_workspace"),
  clearActive: () => invoke<void>("clear_active_workspace"),
  getBranch: (path: string) =>
    invoke<string | null>("get_workspace_branch", { path }),
  getSettings: (workspaceId: string) =>
    invoke<WorkspaceSettings>("get_workspace_settings", { workspaceId }),
  updateSettings: (workspaceId: string, settings: WorkspaceSettings) =>
    invoke<WorkspaceSettings>("update_workspace_settings", {
      workspaceId,
      settings,
    }),
};
