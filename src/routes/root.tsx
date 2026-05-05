import { Outlet, createRootRoute } from "@tanstack/react-router";
import { WorkspacesSidebar } from "@/components/layout/sidebar";
import { StatusBar } from "@/components/layout/status-bar";
import { TitleBar } from "@/components/layout/titlebar";
import { useProjectionInvalidation } from "@/features/events/hooks";
import { QuickTaskShortcut } from "@/features/quick-task/quick-task-shortcut";

function RootLayout() {
  useProjectionInvalidation();

  return (
    <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <WorkspacesSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="scrollbar-styled min-h-0 flex-1 overflow-auto">
            <Outlet />
          </main>
          <StatusBar />
        </div>
        <QuickTaskShortcut />
      </div>
    </div>
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
});
