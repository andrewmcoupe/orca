import { Outlet, createRoute, useParams } from "@tanstack/react-router";
import { rootRoute } from "../root";
import { useActivateWorkspace } from "@/features/workspaces/hooks";
import { WorkspaceBreadcrumbs } from "@/components/layout/breadcrumbs";

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
      <header className="border-border bg-background sticky top-0 z-10 flex h-10 items-center border-b px-4">
        <WorkspaceBreadcrumbs
          workspaceId={workspaceId}
          planId={all.planId}
          taskId={all.taskId}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

export const workspaceLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "workspace-layout",
  path: "/workspace/$workspaceId",
  component: WorkspaceLayout,
});
