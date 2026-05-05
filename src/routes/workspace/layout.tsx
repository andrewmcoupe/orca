import { Outlet, createRoute, useParams } from "@tanstack/react-router";
import { rootRoute } from "../root";
import { useActivateWorkspace } from "@/features/workspaces/hooks";
import { WorkspaceBreadcrumbs } from "@/components/layout/breadcrumbs";
import { BriefingsLiveUpdatesProvider } from "@/features/briefings/live-updates-provider";
import { InflightBriefingsIndicator } from "@/features/briefings/components/inflight-indicator";

function WorkspaceLayout() {
  const { workspaceId } = useParams({ from: workspaceLayoutRoute.id });
  useActivateWorkspace(workspaceId);

  // Read child params if present so the breadcrumb knows what to show.
  // useParams without `strict:false` would error on routes that don't define
  // these params, so we use the relaxed form here.
  const all = useParams({ strict: false }) as {
    workspaceId: string;
    planId?: string;
    taskId?: string;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Listens for `projection_updated` while the user is anywhere inside
          the workspace, not just on briefing pages. This is what lets a
          briefing keep generating after the user navigates away — events
          continue to invalidate caches so the in-flight indicator and the
          briefing page stay accurate. */}
      <BriefingsLiveUpdatesProvider />
      <header className="border-border bg-background sticky top-0 z-10 flex h-7 items-center justify-between gap-2 border-b px-3">
        <WorkspaceBreadcrumbs
          workspaceId={workspaceId}
          planId={all.planId}
          taskId={all.taskId}
        />
        {/* Pill that shows when one or more briefings are still drafting in
            the background. Hidden when there are none, so the header is
            visually unchanged in the common case. */}
        <InflightBriefingsIndicator />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

export const workspaceLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspace/$workspaceId",
  component: WorkspaceLayout,
});
