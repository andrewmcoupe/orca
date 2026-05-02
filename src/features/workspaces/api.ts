import { invoke } from "@tauri-apps/api/core";
import type { ActiveWorkspaceInfo, Workspace } from "./types";

export const workspacesApi = {
  list: () => invoke<Workspace[]>("list_workspaces"),
  add: (path: string) => invoke<Workspace>("add_workspace", { path }),
  remove: (id: string) => invoke<void>("remove_workspace", { id }),
  setActive: (id: string) =>
    invoke<ActiveWorkspaceInfo>("set_active_workspace", { id }),
  getActive: () =>
    invoke<ActiveWorkspaceInfo | null>("get_active_workspace"),
};
