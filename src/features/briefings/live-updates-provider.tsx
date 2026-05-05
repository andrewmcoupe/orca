import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { briefingKeys } from "./hooks";

type ProjectionUpdatedPayload = {
  workspace_id?: string | null;
  aggregate_type: string;
  aggregate_id: string;
};

/**
 * Workspace-level provider that keeps briefing query caches fresh while the
 * user is anywhere inside the workspace, not just the briefing pages. This
 * is what makes "leave the briefing tab while it's drafting" work end to
 * end:
 *
 * - the spawned generation task continues regardless of the UI,
 * - whenever it lands an event (DraftProduced, GenerationFailed, …) the
 *   backend emits `projection_updated`,
 * - this listener invalidates the affected briefing's detail query and the
 *   global active list, so coming back to the briefing page (or glancing
 *   at the chrome indicator) shows current state with no manual refresh.
 *
 * The previous per-component listener (in `useBriefingLiveUpdates`) tore
 * down on unmount, which dropped exactly the events we care about most.
 *
 * Mounted once in the workspace layout — render it as a sibling, it has no
 * children. Unmounted when the user leaves the workspace, which is the
 * correct scope: events for *other* workspaces shouldn't invalidate this
 * one's queries.
 */
export function BriefingsLiveUpdatesProvider() {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = listen<ProjectionUpdatedPayload>(
      "projection_updated",
      (e) => {
        if (cancelled) return;
        if (e.payload.aggregate_type !== "briefing") return;
        // Briefing aggregates: invalidate the detail query so the page
        // shows fresh state, and the active list so the chrome indicator
        // recomputes its in-flight count.
        qc.invalidateQueries({
          queryKey: briefingKeys.detail(e.payload.aggregate_id),
        });
        qc.invalidateQueries({ queryKey: briefingKeys.listActive() });
      },
    );
    return () => {
      cancelled = true;
      void unlistenPromise.then((u) => u());
    };
  }, [qc]);
  return null;
}
