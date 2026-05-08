import { useEffect, useMemo } from "react";
import { createRoute, Link, useSearch } from "@tanstack/react-router";
import { ArrowRight, FilePlus, FolderPlus } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { TaskStatusBadge } from "@/features/tasks/presentation";
import {
  useAddWorkspace,
  useActiveWorkspace,
  useClearActiveWorkspace,
  useWorkspaceHomeDispatch,
} from "@/features/workspaces/hooks";
import type {
  WorkspaceHomeDispatch,
  WorkspaceHomeTask,
  WorkspaceHomeWorkspace,
} from "@/features/workspaces/types";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { rootRoute } from "./root";

const homeSearchSchema = z.object({
  view: z.enum(["all", "awaiting_review"]).default("all"),
});

type HomeSearch = z.infer<typeof homeSearchSchema>;

const PHASE_LABEL: Record<string, string> = {
  test_author: "test author",
  implementer: "implementer",
  auditor: "auditor",
};

function HomePage() {
  const dispatchQ = useWorkspaceHomeDispatch();
  const addWorkspace = useAddWorkspace();
  const activeWorkspace = useActiveWorkspace();
  const clearActiveWorkspace = useClearActiveWorkspace();
  const search = useSearch({ from: indexRoute.id }) as HomeSearch;
  const data = dispatchQ.data ?? emptyDispatch;

  useEffect(() => {
    if (!activeWorkspace.data || clearActiveWorkspace.isPending) return;
    clearActiveWorkspace.mutate();
  }, [activeWorkspace.data, clearActiveWorkspace]);

  const needsAttention = useMemo(() => {
    if (search.view !== "awaiting_review") return data.needs_attention;
    return data.needs_attention.filter((task) =>
      task.attention_kind?.startsWith("auditor_"),
    );
  }, [data.needs_attention, search.view]);

  const onAddWorkspace = async () => {
    const selected = await open({ directory: true });
    if (typeof selected !== "string") return;
    addWorkspace.mutate(selected);
  };

  return (
    <div className="scrollbar-styled h-full overflow-auto">
      <main className="mx-auto flex w-full max-w-[var(--content-max-width)] flex-col gap-6 px-5 py-5">
        <header className="flex items-start justify-between gap-4 border-b pb-5">
          <p
            className={cn(
              "min-w-0 text-[18px] leading-7 tracking-tight",
              data.awaiting_review_count > 0 && "font-medium",
            )}
          >
            Welcome back.{" "}
            {data.awaiting_review_count > 0 ? (
              <Link
                to="/"
                search={{ view: "awaiting_review" }}
                className="text-warning underline-offset-4 hover:underline"
              >
                {data.awaiting_review_count} tasks
              </Link>
            ) : (
              <span>0 tasks</span>
            )}{" "}
            awaiting your review across {data.awaiting_review_workspace_count}{" "}
            {data.awaiting_review_workspace_count === 1
              ? "workspace"
              : "workspaces"}
            .
          </p>
          <Button
            type="button"
            size="sm"
            onClick={onAddWorkspace}
            disabled={addWorkspace.isPending}
            className="shrink-0"
          >
            <FolderPlus className="size-3.5" />
            Add workspace
          </Button>
        </header>

        {dispatchQ.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading workspaces…</p>
        ) : data.plan_count === 0 ? (
          <GettingStarted />
        ) : (
          <>
            {search.view === "awaiting_review" && (
              <div className="flex items-center justify-between border px-3 py-2">
                <span className="text-sm">Awaiting-review tasks</span>
                <Link
                  to="/"
                  search={{ view: "all" }}
                  className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
                >
                  Show all
                </Link>
              </div>
            )}
            {needsAttention.length > 0 && (
              <TaskSection
                id="needs-attention"
                title="Needs your attention"
                tasks={needsAttention}
                renderMeta={(task) => whatToDo(task)}
              />
            )}
            {search.view === "all" && data.in_flight.length > 0 && (
              <TaskSection
                title="In flight"
                tasks={data.in_flight}
                monoMeta
                renderMeta={(task) =>
                  `${phaseLabel(task.phase)} running for ${elapsedTime(
                    task.phase_started_at,
                  )}`
                }
              />
            )}
            {search.view === "all" && data.recent_activity.length > 0 && (
              <TaskSection
                title="Recent activity"
                tasks={data.recent_activity}
                showStatus
                monoMeta
                renderMeta={(task) => formatRelativeTime(task.updated_at)}
              />
            )}
            {search.view === "all" && data.workspaces.length > 0 && (
              <WorkspacesSection workspaces={data.workspaces} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function TaskSection({
  id,
  title,
  tasks,
  renderMeta,
  showStatus = false,
  monoMeta = false,
}: {
  id?: string;
  title: string;
  tasks: WorkspaceHomeTask[];
  renderMeta: (task: WorkspaceHomeTask) => string;
  showStatus?: boolean;
  monoMeta?: boolean;
}) {
  return (
    <section id={id} className="space-y-2">
      <h2 className="text-muted-foreground/80 font-mono text-[10px] font-medium uppercase tracking-[0.08em]">
        {title}
      </h2>
      <div className="divide-border border">
        {tasks.map((task) => (
          <Link
            key={`${title}-${task.workspace_id}-${task.task_id}`}
            to="/workspace/$workspaceId/plan/$planId/task/$taskId"
            params={{
              workspaceId: task.workspace_id,
              planId: task.plan_id,
              taskId: task.task_id,
            }}
            className="hover:bg-muted/50 flex min-w-0 items-center gap-3 border-b px-3 py-2.5 transition-colors last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">
                <span className="text-foreground/40 font-mono">
                  {task.workspace_name}
                </span>
                <span className="text-muted-foreground mx-1.5">·</span>
                <span>{task.plan_title}</span>
                <span className="text-muted-foreground mx-1.5">·</span>
                <span className="font-medium">{task.task_title}</span>
              </div>
              <div className="text-muted-foreground mt-1 flex min-w-0 items-center gap-2 text-xs">
                <span
                  className={cn(
                    "truncate",
                    monoMeta && "font-mono tabular-nums",
                  )}
                >
                  {renderMeta(task)}
                </span>
                {showStatus && <TaskStatusBadge status={task.task_status} />}
              </div>
            </div>
            <ArrowRight className="text-muted-foreground size-3.5 shrink-0" />
          </Link>
        ))}
      </div>
    </section>
  );
}

function WorkspacesSection({
  workspaces,
}: {
  workspaces: WorkspaceHomeWorkspace[];
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-muted-foreground/80 font-mono text-[10px] font-medium uppercase tracking-[0.08em]">
        Workspaces
      </h2>
      <div className="divide-border border">
        {workspaces.map((workspace) => (
          <Link
            key={workspace.workspace_id}
            to="/workspace/$workspaceId/plans"
            params={{ workspaceId: workspace.workspace_id }}
            search={{ status: "active", q: "" }}
            className="hover:bg-muted/50 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-2.5 transition-colors last:border-b-0"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {workspace.name}
              </div>
              <div className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
                {workspace.path}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
                {formatRelativeTime(workspace.last_activity_at)}
              </span>
              <ArrowRight className="text-muted-foreground size-3.5" />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function GettingStarted() {
  const steps = [
    "Add a git repository as a workspace.",
    "Create a plan from a briefing or manual scope.",
    "Run tasks, review auditor verdicts, then merge.",
  ];
  return (
    <section className="border border-dashed px-4 py-5">
      <div className="flex items-center gap-2">
        <FilePlus className="size-4" />
        <h2 className="text-sm font-medium">Getting started</h2>
      </div>
      <ol className="mt-4 space-y-2">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3 text-sm">
            <span className="text-muted-foreground font-mono text-xs">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="text-muted-foreground">{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function whatToDo(task: WorkspaceHomeTask): string {
  if (task.attention_kind === "phase_failed") {
    return `${phaseLabel(task.phase)} failed${
      task.error_message ? `: ${task.error_message}` : ". Review and retry."
    }`;
  }
  if (task.verdict === "approve") return "Auditor approved. Review and merge.";
  if (task.verdict === "reject")
    return "Auditor rejected. Reject or pass back.";
  if (task.verdict === "revise")
    return "Auditor requested revision. Pass back with notes.";
  return "Review the task and choose the next action.";
}

function phaseLabel(phase: string | null): string {
  if (!phase) return "Phase";
  return PHASE_LABEL[phase] ?? phase.replace(/_/g, " ");
}

function elapsedTime(startedAt: number | null): string {
  if (!startedAt) return "a moment";
  const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

const emptyDispatch: WorkspaceHomeDispatch = {
  workspace_count: 0,
  plan_count: 0,
  in_flight_count: 0,
  failed_count: 0,
  merged_count: 0,
  awaiting_review_count: 0,
  awaiting_review_workspace_count: 0,
  most_recent_workspace_id: null,
  needs_attention: [],
  in_flight: [],
  recent_activity: [],
  workspaces: [],
};

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: homeSearchSchema,
  component: HomePage,
});
