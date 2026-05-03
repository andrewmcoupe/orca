import { Outlet, createRootRoute } from "@tanstack/react-router";
import { WorkspacesSidebar } from "@/components/layout/sidebar";
import { StatusBar } from "@/components/layout/status-bar";
import { useProjectionInvalidation } from "@/features/events/hooks";
import { QuickTaskShortcut } from "@/features/quick-task/quick-task-shortcut";

function RootLayout() {
  useProjectionInvalidation();

  return (
    <div className="bg-background text-foreground flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <WorkspacesSidebar />
        <main className="min-w-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <StatusBar />
      <QuickTaskShortcut />
    </div>
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
});
