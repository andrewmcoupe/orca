export type LinearConnectionStatus = {
  connected: boolean;
  workspace_id: string;
};

export type LinearUser = {
  id: string;
  name: string | null;
  display_name: string | null;
};

export type LinearIssueComment = {
  id: string;
  body: string;
  user_name: string | null;
  created_at: string | null;
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  state: string | null;
  state_type: string | null;
  team_key: string | null;
  team_name: string | null;
  assignee: string | null;
  labels: string[];
  comments: LinearIssueComment[];
  created_at: string | null;
  updated_at: string | null;
};

export type LinearSearchResult = {
  issues: LinearIssue[];
};
