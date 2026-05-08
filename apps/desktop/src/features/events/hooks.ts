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
        if (
          aggregate_type === "workspace" ||
          aggregate_type === "plan" ||
          aggregate_type === "task"
        ) {
          qc.invalidateQueries({ queryKey: ["workspace_stats"] });
        }
        if (
          aggregate_type === "workspace" ||
          aggregate_type === "plan" ||
          aggregate_type === "task" ||
          aggregate_type === "phase_run" ||
          aggregate_type === "briefing" ||
          aggregate_type === "recent_events"
        ) {
          qc.invalidateQueries({ queryKey: ["workspace_home_dispatch"] });
        }
        // List queries are keyed inconsistently (plans by workspace, tasks by
        // plan, etc), so invalidate by prefix — react-query matches any
        // queryKey starting with [aggregate_type, "list"]. Without this, a
        // TaskMerged event would invalidate ["task", "list", workspace_id]
        // while the actual list lives under ["task", "list", plan_id] and
        // never refreshes.
        qc.invalidateQueries({ queryKey: [aggregate_type, "list"] });
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
  // `limit` is part of the cache key so consumers asking for different sizes
  // (e.g. the status bar's single-row peek vs the events drawer's full buffer)
  // don't poison each other. Invalidation by prefix `["recent_events", id]`
  // still catches every limit variant.
  return useQuery<RecentEvent[]>({
    queryKey: ["recent_events", workspaceId, limit],
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
