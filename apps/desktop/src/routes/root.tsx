import { Outlet, createRootRoute } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { WorkspacesSidebar } from "@/components/layout/sidebar";
import { StatusBar } from "@/components/layout/status-bar";
import { TitleBar, TitleBarItem } from "@/components/layout/titlebar";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useProjectionInvalidation } from "@/features/events/hooks";
import { QuickTaskShortcut } from "@/features/quick-task/quick-task-shortcut";

function RootLayout() {
  useProjectionInvalidation();

  return (
    <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
      <SidebarProvider
        className="min-h-0 flex-1 flex-col"
        style={
          {
            "--sidebar-width": "220px",
            "--sidebar-width-icon": "2.75rem",
          } as CSSProperties
        }
      >
        <TitleBar>
          <TitleBarItem>
            <SidebarTrigger
              title="Toggle workspace sidebar"
              className="size-6 rounded-none text-muted-foreground hover:text-foreground"
            />
          </TitleBarItem>
        </TitleBar>
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
      </SidebarProvider>
    </div>
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
});
