import { Link } from "@tanstack/react-router";
import { CircleNotch, Eye, LinkSimple, Queue } from "@phosphor-icons/react";
import { TaskReviewStateBadge } from "@/features/tasks/presentation";
import { usePhaseRuns } from "@/features/phase-runs/hooks";
import {
  ProviderLogo,
  ProviderModelLabel,
} from "@/features/providers/components/provider-logo";
import { useWorkspaceSettings } from "@/features/workspaces/hooks";
import { resolvePhaseSettings } from "@/features/workspaces/types";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { deriveTaskReviewState } from "@/features/tasks/task-domain";
import type { Task } from "@/features/tasks/types";
import { useState } from "react";

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
  dependencies,
}: {
  task: Task;
  workspaceId: string;
  /** Resolved titles for `task.depends_on`, in declaration order. Falls back to
   * the raw id when the referenced task isn't in the same plan list. */
  dependencyTitles?: string[];
  dependencies?: Array<{ id: string; title: string }>;
}) {
  const [blockersOpen, setBlockersOpen] = useState(false);
  const workspaceSettingsQ = useWorkspaceSettings(workspaceId);
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
  const queueDependencyTitles =
    task.is_queued && task.is_blocked && dependencyTitles
      ? dependencyTitles
      : [];
  const blockerItems =
    dependencies ??
    task.depends_on.map((id, index) => ({
      id,
      title: dependencyTitles?.[index] ?? id,
    }));
  const reviewState = deriveTaskReviewState({
    task,
    activeRun,
    latestRun: lastRun,
  });
  const nextPhase = task.current_phase_config.phases[0];
  const planned =
    !activeRun && !initRunning && !isTerminal && nextPhase && workspaceSettingsQ.data
      ? resolvePhaseSettings(
          workspaceSettingsQ.data,
          task.current_phase_config,
          nextPhase,
        )
      : null;
  const isReady =
    !task.is_blocked &&
    !task.is_queued &&
    !activeRun &&
    !initRunning &&
    (task.status === "draft" || reviewState === "ready_to_land");

  return (
    <div
      className={cn(
        "group rounded-sm px-3 py-2 transition-colors last:border-b-0",
        isReady
          ? "bg-emerald-500/8 hover:bg-emerald-500/12 ring-1 ring-emerald-500/20"
          : "bg-muted/40 hover:bg-muted/60",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="grid gap-1">
              <Link
                to="/workspace/$workspaceId/plan/$planId/task/$taskId"
                params={{ workspaceId, planId: task.plan_id, taskId: task.id }}
                className="truncate text-xs font-light hover:underline"
              >
                {task.title}
              </Link>
              {blockerItems.length > 0 && (
                <TaskDependencyLine
                  task={task}
                  workspaceId={workspaceId}
                  dependencies={blockerItems}
                  expanded={blockersOpen}
                  onToggle={() => setBlockersOpen((v) => !v)}
                />
              )}

              {task.is_queued && queueDependencyTitles.length === 0 && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] text-warning"
                  title="Queued to start when dependencies are ready"
                >
                  <Queue className="size-3" />
                  <span>Queued</span>
                </span>
              )}

              {initRunning && (
                <span
                  className="text-muted-foreground inline-flex items-center gap-1 text-[10px]"
                  title={
                    task.worktree_init_command
                      ? `Initializing task files: ${task.worktree_init_command}`
                      : "Initializing task files"
                  }
                >
                  <CircleNotch className="size-3 animate-spin text-sky-600 dark:text-sky-400" />
                  <span>Initializing task files…</span>
                  {task.worktree_init_command && (
                    <code className="hidden truncate font-mono md:inline">
                      {task.worktree_init_command}
                    </code>
                  )}
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
                    ·
                  </span>
                  <span className="text-muted-foreground/70 hidden items-center gap-1 md:inline-flex">
                    <ProviderLogo
                      provider={activeRun.provider}
                      className="size-2.5"
                    />
                    {activeRun.provider}
                  </span>
                </span>
              )}

              {planned?.model && (
                <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 font-mono text-[10px]">
                  <span className="shrink-0">next {nextPhase}</span>
                  <span className="text-muted-foreground/70">·</span>
                  <ProviderModelLabel
                    provider={planned.model.provider}
                    model={planned.model.model}
                    logoClassName="size-2.5"
                  />
                </span>
              )}
            </div>

            {awaitingReview && (
              <span
                className="inline-flex items-center gap-1 text-[10px] text-warning"
                title="Auditor finished — awaiting your review"
              >
                <Eye className="size-3" />
                <span>Awaiting review</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {task.is_queued && (
            <span
              className="bg-warning/15 text-warning inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px]"
              title={
                queueDependencyTitles.length > 0
                  ? `Queued behind: ${queueDependencyTitles.join(", ")}`
                  : "Queued to start when dependencies are ready"
              }
            >
              <Queue className="size-3" />
              Queued
            </span>
          )}
          <TaskReviewStateBadge state={reviewState} />
          <span
            className="text-muted-foreground/40 text-xs tabular-nums"
            title={new Date(task.updated_at).toLocaleString()}
          >
            {formatRelativeTime(task.updated_at)}
          </span>
        </div>
      </div>
    </div>
  );
}

function TaskDependencyLine({
  task,
  workspaceId,
  dependencies,
  expanded,
  onToggle,
}: {
  task: Task;
  workspaceId: string;
  dependencies: Array<{ id: string; title: string }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tone =
    task.is_blocked || task.is_queued ? "text-warning" : "text-muted-foreground";
  const prefix = task.is_queued
    ? "Queued behind"
    : task.is_blocked
      ? "Blocked by"
      : "Depends on";

  if (dependencies.length === 1) {
    const dep = dependencies[0];
    return (
      <Link
        to="/workspace/$workspaceId/plan/$planId/task/$taskId"
        params={{ workspaceId, planId: task.plan_id, taskId: dep.id }}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 text-[10px] hover:underline",
          tone,
        )}
        title={`${prefix}: ${dep.title}`}
      >
        {task.is_queued ? <Queue className="size-3" /> : <LinkSimple className="size-3" />}
        <span>
          {prefix} {truncate(dep.title, 32)}
        </span>
      </Link>
    );
  }

  return (
    <div className={cn("grid gap-1 text-[10px]", tone)}>
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex w-fit items-center gap-1 hover:underline"
        title={`${prefix}: ${dependencies.map((dep) => dep.title).join(", ")}`}
      >
        {task.is_queued ? <Queue className="size-3" /> : <LinkSimple className="size-3" />}
        <span>
          {prefix} {dependencies.length} tasks
        </span>
      </button>
      {expanded && (
        <div className="grid gap-0.5 pl-4">
          {dependencies.map((dep) => (
            <Link
              key={dep.id}
              to="/workspace/$workspaceId/plan/$planId/task/$taskId"
              params={{ workspaceId, planId: task.plan_id, taskId: dep.id }}
              className="truncate text-muted-foreground hover:text-foreground hover:underline"
              title={dep.title}
            >
              {dep.title}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
