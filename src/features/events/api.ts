import { invoke } from "@tauri-apps/api/core";
import type { RecentEvent } from "./types";

export const eventsApi = {
  listRecent: (limit: number) =>
    invoke<RecentEvent[]>("list_recent_events", { limit }),
  rebuildProjections: () =>
    invoke<{ events_replayed: number; projections_rebuilt: string[] }>(
      "rebuild_projections",
    ),
};
