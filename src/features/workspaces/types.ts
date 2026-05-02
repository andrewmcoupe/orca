export type Workspace = {
  id: string;
  path: string;
  name: string;
  archived: boolean;
  archived_reason: string | null;
  created_at: number;
  updated_at: number;
};

export type ActiveWorkspaceInfo = {
  id: string;
  path: string;
};
