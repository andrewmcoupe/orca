import {
  Link,
  Outlet,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { WorkspacesSidebar } from "@/components/layout/sidebar";
import { TitleBar, TitleBarItem } from "@/components/layout/titlebar";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { OrbitDot } from "@/components/ui/mini-loaders";
import { useProjectionInvalidation } from "@/features/events/hooks";
import { QuickTaskShortcut } from "@/features/quick-task/quick-task-shortcut";
import { TerminalStoreProvider } from "@/features/terminal/terminal-store";
import { useWorkspaceHomeDispatch } from "@/features/workspaces/hooks";
import type { WorkspaceHomeTask } from "@/features/workspaces/types";

function RootLayout() {
  useProjectionInvalidation();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const isGlobalSettings =
    pathname === "/settings" || pathname.startsWith("/settings/");

  if (isGlobalSettings) {
    return (
      <RootTerminalScope>
        <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
          <TitleBar>
            <div className="flex-1" />
            <TitleBarItem>
              <AppProgressIndicator />
            </TitleBarItem>
          </TitleBar>
          <main className="min-h-0 flex-1 overflow-hidden">
            <Outlet />
          </main>
        </div>
      </RootTerminalScope>
    );
  }

  return (
    <RootTerminalScope>
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
                className="size-6 rounded-none border-0 text-muted-foreground hover:text-foreground"
              />
            </TitleBarItem>
            <div className="flex-1" />
            <TitleBarItem>
              <AppProgressIndicator />
            </TitleBarItem>
          </TitleBar>
          <div className="flex min-h-0 flex-1">
            <WorkspacesSidebar />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <main className="min-h-0 flex-1 overflow-hidden">
                <Outlet />
              </main>
            </div>
            <QuickTaskShortcut />
          </div>
        </SidebarProvider>
      </div>
    </RootTerminalScope>
  );
}

function RootTerminalScope({ children }: { children: ReactNode }) {
  return <TerminalStoreProvider>{children}</TerminalStoreProvider>;
}

function AppProgressIndicator() {
  const dispatchQ = useWorkspaceHomeDispatch();
  const inFlight = dispatchQ.data?.in_flight ?? [];
  const inFlightCount = dispatchQ.data?.in_flight_count ?? inFlight.length;
  if (inFlightCount === 0) return null;

  const label =
    inFlightCount === 1
      ? "1 task in progress"
      : `${inFlightCount} tasks in progress`;

  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="text-warning hover:bg-muted/60 flex h-6 items-center gap-1.5 border-none px-2 text-[11px] transition-colors"
              aria-label={label}
            >
              <OrbitDot />
              <span className="font-mono tabular-nums">{inFlightCount}</span>
            </button>
          }
        />
        <TooltipContent side="bottom" align="end" className="max-w-sm">
          <div className="space-y-1.5">
            <p className="font-medium">{label}</p>
            <div className="space-y-1">
              {inFlight.slice(0, 4).map((task) => (
                <ProgressTooltipRow
                  key={task.phase_run_id ?? task.task_id}
                  task={task}
                />
              ))}
              {inFlightCount > 4 && (
                <p className="text-background/75">
                  +{inFlightCount - 4} more running
                </p>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ProgressTooltipRow({ task }: { task: WorkspaceHomeTask }) {
  return (
    <Link
      to="/workspace/$workspaceId/plan/$planId/task/$taskId"
      params={{
        workspaceId: task.workspace_id,
        planId: task.plan_id,
        taskId: task.task_id,
      }}
      className="block max-w-xs truncate text-background/90 underline-offset-2 hover:text-background hover:underline"
    >
      {task.workspace_name} · {task.plan_title} · {task.task_title}
    </Link>
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
});
