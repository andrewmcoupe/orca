import { invoke } from "@tauri-apps/api/core";
import type { EventDetail, RecentEvent } from "./types";

export const eventsApi = {
  listRecent: (limit: number) =>
    invoke<RecentEvent[]>("list_recent_events", { limit }),
  getById: (eventId: string) =>
    invoke<EventDetail | null>("get_event_by_id", { eventId }),
  rebuildProjections: () =>
    invoke<{ events_replayed: number; projections_rebuilt: string[] }>(
      "rebuild_projections",
    ),
};
