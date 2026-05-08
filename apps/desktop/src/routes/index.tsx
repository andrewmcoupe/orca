import { useMemo } from "react";
import { createRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CheckCircle,
  ClockCounterClockwise,
  FolderPlus,
  GitMerge,
  ListChecks,
  Pulse,
  Warning,
} from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  useAddWorkspace,
  useWorkspaceStats,
  useWorkspaces,
} from "@/features/workspaces/hooks";
import type {
  Workspace,
  WorkspaceStats,
} from "@/features/workspaces/types";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { rootRoute } from "./root";

type WorkspaceRow = {
  workspace: Workspace;
  stats: WorkspaceStats | null;
};

function HomePage() {
  const workspaces = useWorkspaces();
  const statsQ = useWorkspaceStats();
  const addWorkspace = useAddWorkspace();
  const list = workspaces.data ?? [];
  const statsByWorkspace = useMemo(
    () => new Map((statsQ.data ?? []).map((s) => [s.workspace_id, s])),
    [statsQ.data],
  );
  const rows = list.map((workspace) => ({
    workspace,
    stats: statsByWorkspace.get(workspace.id) ?? null,
  }));
  const totals = useMemo(() => summarize(rows), [rows]);

  const onAddWorkspace = async () => {
    const selected = await open({ directory: true });
    if (typeof selected !== "string") return;
    addWorkspace.mutate(selected);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Track active plans, running tasks, review queues, and completed work
            across your registered repos.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={onAddWorkspace}
          disabled={addWorkspace.isPending}
        >
          <FolderPlus className="size-3.5" />
          Add workspace
        </Button>
      </header>

      {list.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <OverviewStats totals={totals} />
          <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Workspace activity</h2>
                {statsQ.isFetching && (
                  <span className="text-muted-foreground text-xs">
                    Refreshing
                  </span>
                )}
              </div>
              <div className="divide-border overflow-hidden rounded-md border">
                {rows.map((row) => (
                  <WorkspaceSummaryRow key={row.workspace.id} row={row} />
                ))}
              </div>
            </div>
            <GettingStarted />
          </section>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid min-h-[420px] place-items-center border border-dashed">
      <div className="max-w-md space-y-5 px-6 text-center">
        <div className="mx-auto flex size-10 items-center justify-center border">
          <FolderPlus className="size-5" />
        </div>
        <div>
          <h2 className="text-base font-medium">Add a git repo to begin</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            Orca stores plans, tasks, phase runs, and review state per
            workspace. Once a repo is added, this page becomes your overview.
          </p>
        </div>
        <GettingStarted compact />
      </div>
    </div>
  );
}

function OverviewStats({
  totals,
}: {
  totals: ReturnType<typeof summarize>;
}) {
  return (
    <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      <StatTile
        label="Workspaces"
        value={totals.workspaceCount}
        icon={<ListChecks className="size-3.5" />}
      />
      <StatTile
        label="Active plans"
        value={totals.activePlans}
        icon={<Pulse className="size-3.5" />}
      />
      <StatTile
        label="Running tasks"
        value={totals.runningTasks}
        icon={<ClockCounterClockwise className="size-3.5" />}
        tone={totals.runningTasks > 0 ? "success" : "default"}
      />
      <StatTile
        label="Awaiting review"
        value={totals.awaitingReview}
        icon={<Warning className="size-3.5" />}
        tone={totals.awaitingReview > 0 ? "warning" : "default"}
      />
      <StatTile
        label="Merged"
        value={totals.mergedTasks}
        icon={<GitMerge className="size-3.5" />}
      />
    </section>
  );
}

function StatTile({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: "default" | "success" | "warning";
}) {
  return (
    <div
      className={cn(
        "flex min-h-[72px] items-center justify-between border px-3 py-2",
        tone === "success" && "border-success/30 bg-success/5",
        tone === "warning" && "border-warning/35 bg-warning/5",
      )}
    >
      <div>
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="mt-1 font-mono text-2xl tabular-nums">{value}</div>
      </div>
      <span className="text-muted-foreground">{icon}</span>
    </div>
  );
}

function WorkspaceSummaryRow({ row }: { row: WorkspaceRow }) {
  const { workspace, stats } = row;
  const updatedAt = stats?.updated_at ?? workspace.updated_at;
  const hasAttention =
    (stats?.running_task_count ?? 0) > 0 ||
    (stats?.awaiting_review_task_count ?? 0) > 0 ||
    (stats?.failed_task_count ?? 0) > 0;

  return (
    <Link
      to="/workspace/$workspaceId/plans"
      params={{ workspaceId: workspace.id }}
      search={{ status: "active", q: "" }}
      className="hover:bg-muted/60 grid gap-3 px-4 py-3 transition-colors md:grid-cols-[minmax(180px,1fr)_auto]"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{workspace.name}</span>
          {stats?.error && (
            <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
              stats unavailable
            </Badge>
          )}
          {hasAttention && !stats?.error && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              active
            </Badge>
          )}
        </div>
        <div className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
          {workspace.path}
        </div>
        <div className="text-muted-foreground mt-1 text-[11px]">
          Updated {formatRelativeTime(updatedAt)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <Metric label="plans" value={stats?.plan_count ?? null} />
        <Metric label="tasks" value={stats?.task_count ?? null} />
        <Metric
          label="running"
          value={stats?.running_task_count ?? null}
          emphasize={(stats?.running_task_count ?? 0) > 0}
        />
        <Metric
          label="review"
          value={stats?.awaiting_review_task_count ?? null}
          emphasize={(stats?.awaiting_review_task_count ?? 0) > 0}
        />
        <Metric
          label="failed"
          value={stats?.failed_task_count ?? null}
          destructive={(stats?.failed_task_count ?? 0) > 0}
        />
        <ArrowRight className="text-muted-foreground size-3.5" />
      </div>
    </Link>
  );
}

function Metric({
  label,
  value,
  emphasize,
  destructive,
}: {
  label: string;
  value: number | null;
  emphasize?: boolean;
  destructive?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 min-w-[58px] flex-col justify-center border px-2 text-right",
        emphasize && "border-success/30 bg-success/5 text-success",
        destructive && "border-destructive/30 bg-destructive/5 text-destructive",
      )}
    >
      <span className="font-mono text-xs tabular-nums">{value ?? "..."}</span>
      <span className="text-muted-foreground text-[9px] uppercase">{label}</span>
    </span>
  );
}

function GettingStarted({ compact = false }: { compact?: boolean }) {
  const steps = [
    "Add a git repository as a workspace.",
    "Open Plans and create a plan from a brief, PRD, or manual scope.",
    "Break the plan into tasks, run the pipeline, then review and merge.",
  ];

  return (
    <aside
      className={cn(
        "border px-4 py-3",
        compact ? "text-left" : "self-start",
      )}
    >
      <h2 className="text-sm font-medium">Getting started</h2>
      <ol className="mt-3 space-y-2">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-2 text-sm">
            <span className="text-muted-foreground font-mono text-xs">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="text-muted-foreground">{step}</span>
          </li>
        ))}
      </ol>
      {!compact && (
        <div className="text-muted-foreground mt-4 flex items-start gap-2 border-t pt-3 text-xs">
          <CheckCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Stats are read from each workspace&apos;s local Orca event store, so
            switching workspaces is no longer required just to compare activity.
          </span>
        </div>
      )}
    </aside>
  );
}

function summarize(rows: WorkspaceRow[]) {
  return rows.reduce(
    (acc, row) => {
      const stats = row.stats;
      acc.workspaceCount += 1;
      if (!stats || stats.error) return acc;
      acc.activePlans += stats.active_plan_count;
      acc.runningTasks += stats.running_task_count;
      acc.awaitingReview += stats.awaiting_review_task_count;
      acc.mergedTasks += stats.merged_task_count;
      return acc;
    },
    {
      workspaceCount: 0,
      activePlans: 0,
      runningTasks: 0,
      awaitingReview: 0,
      mergedTasks: 0,
    },
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
