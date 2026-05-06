import { Link } from "@tanstack/react-router";
import { CircleNotch, Eye, LinkSimple } from "@phosphor-icons/react";
import { TaskStatusBadge } from "@/features/tasks/presentation";
import { usePhaseRuns } from "@/features/phase-runs/hooks";
import { formatRelativeTime } from "@/lib/format";
import type { Task } from "@/features/tasks/types";

const TERMINAL_STATUSES = new Set([
  "merged",
  "cancelled",
  "archived",
  "approved",
]);

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const PHASE_LABEL: Record<string, string> = {
  test_author: "tests",
  implementer: "implementer",
  auditor: "auditor",
};

export function TaskRow({
  task,
  workspaceId,
  dependencyTitles,
}: {
  task: Task;
  workspaceId: string;
  /** Resolved titles for `task.depends_on`, in declaration order. Falls back to
   * the raw id when the referenced task isn't in the same plan list. */
  dependencyTitles?: string[];
}) {
  const initRunning = task.worktree_init_status === "running";
  // Task projections never carry a literal "running" status — the running-ness
  // is held by the latest phase run. Fetch when there's any phase run on a
  // non-terminal task (and don't double up with the worktree-init indicator).
  const isTerminal = TERMINAL_STATUSES.has(task.status);
  const phaseRunsTaskId =
    !initRunning && !isTerminal && task.latest_phase_run_id
      ? task.id
      : undefined;
  const phaseRuns = usePhaseRuns(workspaceId, phaseRunsTaskId);
  const activeRun = phaseRuns.data?.find((r) => r.status === "running");
  // "Awaiting review" = the auditor finished and the user hasn't acted on the
  // verdict yet. The task projection has no literal status for this; we infer
  // it from the most recent phase run being a completed auditor run, with the
  // task not yet approved/merged/cancelled. Skipped when something is actively
  // running so we don't double-up indicators.
  const lastRun = phaseRuns.data?.[phaseRuns.data.length - 1];
  const awaitingReview =
    !activeRun &&
    !isTerminal &&
    !!lastRun &&
    lastRun.phase === "auditor" &&
    lastRun.status === "completed";
  return (
    <Link
      to="/workspace/$workspaceId/plan/$planId/task/$taskId"
      params={{ workspaceId, planId: task.plan_id, taskId: task.id }}
      className="hover:bg-muted/40 group flex items-center gap-3 border-b px-3 py-2 transition-colors last:border-b-0 bg-muted"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-light">{task.title}</span>
          <TaskStatusBadge status={task.status} />
          {initRunning && (
            <span
              className="text-muted-foreground inline-flex items-center gap-1 text-[10px]"
              title={
                task.worktree_init_command
                  ? `Initializing worktree: ${task.worktree_init_command}`
                  : "Initializing worktree"
              }
            >
              <CircleNotch className="size-3 animate-spin text-sky-600 dark:text-sky-400" />
              <span>Initializing worktree…</span>
              {task.worktree_init_command && (
                <code className="hidden truncate font-mono md:inline">
                  {task.worktree_init_command}
                </code>
              )}
            </span>
          )}
          {dependencyTitles && dependencyTitles.length > 0 && (
            <span
              className={
                "inline-flex items-center gap-1 text-[10px] " +
                (task.is_blocked ? "text-warning" : "text-muted-foreground")
              }
              title={
                (task.is_blocked ? "Blocked by: " : "Depends on: ") +
                dependencyTitles.join(", ")
              }
            >
              <LinkSimple className="size-3" />
              <span>
                {task.is_blocked ? "Blocked by " : "Depends on "}
                {dependencyTitles.length === 1
                  ? truncate(dependencyTitles[0], 32)
                  : `${dependencyTitles.length} tasks`}
              </span>
            </span>
          )}
          {awaitingReview && (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-warning"
              title="Auditor finished — awaiting your review"
            >
              <Eye className="size-3" />
              <span>Awaiting review</span>
            </span>
          )}
          {!initRunning && activeRun && (
            <span
              className="text-muted-foreground inline-flex items-center gap-1 text-[10px]"
              title={`Running ${activeRun.phase} via ${activeRun.provider} (${activeRun.model})`}
            >
              <CircleNotch className="size-3 animate-spin text-sky-600 dark:text-sky-400" />
              <span>
                Running {PHASE_LABEL[activeRun.phase] ?? activeRun.phase}
              </span>
              <span className="text-muted-foreground/70 hidden md:inline">
                · {activeRun.provider}
              </span>
            </span>
          )}
        </div>
      </div>
      <span
        className="text-muted-foreground text-xs tabular-nums"
        title={new Date(task.updated_at).toLocaleString()}
      >
        {formatRelativeTime(task.updated_at)}
      </span>
    </Link>
  );
}
