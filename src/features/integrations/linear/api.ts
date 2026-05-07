import { invoke } from "@tauri-apps/api/core";
import type {
  LinearConnectionStatus,
  LinearIssue,
  LinearSearchResult,
  LinearUser,
} from "./types";

export const linearApi = {
  connectionStatus: () =>
    invoke<LinearConnectionStatus>("linear_connection_status"),
  saveApiKey: (apiKey: string) =>
    invoke<LinearUser>("linear_save_api_key", { apiKey }),
  disconnect: () => invoke<void>("linear_disconnect"),
  testConnection: () => invoke<LinearUser>("linear_test_connection"),
  getIssue: (input: { issueId: string; includeComments?: boolean }) =>
    invoke<LinearIssue | null>("linear_get_issue", {
      issueId: input.issueId,
      includeComments: input.includeComments ?? true,
    }),
  searchIssues: (input: {
    query: string;
    limit?: number;
    includeComments?: boolean;
  }) =>
    invoke<LinearSearchResult>("linear_search_issues", {
      query: input.query,
      limit: input.limit ?? 10,
      includeComments: input.includeComments ?? true,
    }),
};
