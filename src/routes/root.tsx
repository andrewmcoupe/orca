import { Outlet, createRootRoute } from "@tanstack/react-router";
import { WorkspacesSidebar } from "@/components/layout/sidebar";
import { EventStreamStrip } from "@/components/layout/event-stream-strip";
import { useActiveWorkspace } from "@/features/workspaces/hooks";
import { useProjectionInvalidation } from "@/features/events/hooks";
import { QuickTaskShortcut } from "@/features/quick-task/quick-task-shortcut";

function RootLayout() {
  useProjectionInvalidation();
  const active = useActiveWorkspace();

  return (
    <div className="bg-background text-foreground flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <WorkspacesSidebar />
        <main className="min-w-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <EventStreamStrip activeWorkspaceId={active.data?.id ?? null} />
      <QuickTaskShortcut />
    </div>
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
});
