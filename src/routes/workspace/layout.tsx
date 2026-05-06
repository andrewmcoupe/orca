import { Outlet, createRoute, useParams } from "@tanstack/react-router";
import { rootRoute } from "../root";
import { useActivateWorkspace } from "@/features/workspaces/hooks";
import { WorkspaceBreadcrumbs } from "@/components/layout/breadcrumbs";
import {
  HeaderSlotProvider,
  HeaderSlotTarget,
} from "@/components/layout/header-slot";
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
      <HeaderSlotProvider>
        {/* Bumped from h-7 to h-11 so detail-view action toolbars (Run /
            Approve / Pass back / etc.) can portal into the right side of
            this bar without cramming text buttons into a 28px strip. */}
        <header className="border-border bg-background sticky top-0 z-10 flex h-11 items-center justify-between gap-3 border-b px-3">
          <WorkspaceBreadcrumbs
            workspaceId={workspaceId}
            planId={all.planId}
            taskId={all.taskId}
          />
          <div className="flex shrink-0 items-center gap-2">
            <HeaderSlotTarget className="flex items-center" />
            {/* Pill that shows when one or more briefings are still drafting in
                the background. Hidden when there are none, so the header is
                visually unchanged in the common case. */}
            <InflightBriefingsIndicator />
          </div>
        </header>
        <div className="scrollbar-styled min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </HeaderSlotProvider>
    </div>
  );
}

export const workspaceLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspace/$workspaceId",
  component: WorkspaceLayout,
});
