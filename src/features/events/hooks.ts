import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { eventsApi } from "./api";
import type { EventDetail, ProjectionUpdated, RecentEvent } from "./types";

/**
 * Listens for backend `projection_updated` events and invalidates the matching
 * react-query keys. Mount once at the app shell — every component reads through
 * react-query, so a single global listener keeps every view live.
 */
export function useProjectionInvalidation() {
  const qc = useQueryClient();
  useEffect(() => {
    const unlisten = listen<ProjectionUpdated>(
      "projection_updated",
      (event) => {
        const { aggregate_type, aggregate_id, workspace_id } = event.payload;
        if (aggregate_id === "*") {
          qc.invalidateQueries();
          return;
        }
        qc.invalidateQueries({ queryKey: [aggregate_type, aggregate_id] });
        qc.invalidateQueries({
          queryKey: [aggregate_type, "list", workspace_id],
        });
        if (aggregate_type !== "recent_events") {
          qc.invalidateQueries({ queryKey: ["recent_events", workspace_id] });
        } else {
          qc.invalidateQueries({ queryKey: ["recent_events"] });
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [qc]);
}

export function useRecentEvents(workspaceId: string | null, limit = 100) {
  return useQuery<RecentEvent[]>({
    queryKey: ["recent_events", workspaceId],
    queryFn: () => eventsApi.listRecent(limit),
    enabled: !!workspaceId,
  });
}

export function useEventDetail(eventId: string | null) {
  return useQuery<EventDetail | null>({
    queryKey: ["event_detail", eventId],
    queryFn: () => eventsApi.getById(eventId!),
    enabled: !!eventId,
  });
}
