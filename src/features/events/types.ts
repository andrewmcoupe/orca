export type RecentEvent = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  summary: string;
  created_at: number;
};

export type EventDetail = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  seq: number;
  event_type: string;
  version: number;
  payload: string;
  metadata: string;
  created_at: number;
};

export type ProjectionUpdated = {
  workspace_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
};
