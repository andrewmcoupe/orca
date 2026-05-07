import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CaretRight } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useTasksInPlan } from "../hooks";
import { TaskStatusBadge } from "../presentation";
import { DependencyEditDialog } from "./dependencies-section";
import { PhaseRunOutputDialog } from "@/features/phase-runs/components/phase-run-output-dialog";
import { DetailSidebarAction } from "@/components/layout/detail-sidebar";
import type { Task } from "../types";
import type { PhaseRun } from "@/features/phase-runs/types";

/**
 * DEPENDENCIES section content — list of upstream tasks plus an inline edit
 * affordance. Section header itself ("DEPENDENCIES" + "edit" link) is
 * rendered by the sidebar primitive; this component owns the body and the
 * edit dialog. Always renders something even on empty so the user has a
 * clear "no dependencies" state with the edit affordance still reachable.
 */
export function DependenciesSidebarBody({
  workspaceId,
  task,
}: {
  workspaceId: string;
  task: Task;
}) {
  const tasksQ = useTasksInPlan(task.plan_id);
  const allTasks = tasksQ.data ?? [];
  const taskById = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of allTasks) m.set(t.id, t);
    return m;
  }, [allTasks]);

  const deps = task.depends_on
    .map((id) => taskById.get(id))
    .filter((t): t is Task => !!t);

  if (deps.length === 0) {
    return <p className="text-muted-foreground text-[11px] italic">none</p>;
  }
  return (
    <ul className="space-y-1.5">
      {deps.map((d) => (
        <li key={d.id} className="flex items-center gap-2 text-[12px]">
          <TaskStatusBadge status={d.status} />
          <Link
            to="/workspace/$workspaceId/plan/$planId/task/$taskId"
            params={{
              workspaceId,
              planId: task.plan_id,
              taskId: d.id,
            }}
            className={cn(
              "min-w-0 flex-1 truncate underline-offset-2 hover:underline",
              d.status === "merged"
                ? "text-muted-foreground"
                : "text-foreground",
            )}
          >
            {d.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function DependenciesSidebarEditAction({ task }: { task: Task }) {
  const tasksQ = useTasksInPlan(task.plan_id);
  const [open, setOpen] = useState(false);
  const disabled = task.status === "merged" || task.status === "archived";
  return (
    <>
      <DetailSidebarAction onClick={() => setOpen(true)} disabled={disabled}>
        edit
      </DetailSidebarAction>
      <DependencyEditDialog
        task={task}
        candidates={tasksQ.data ?? []}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * ARTIFACTS section content — links into phase output viewers and the diff
 * modal. Each row is a small underlined link with a leading chevron, matching
 * the brief and screenshot. Phases that haven't produced output and missing
 * diffs are simply omitted; consumers test for `hasAny` to decide whether to
 * render the section at all.
 */
export function ArtifactsSidebarBody({
  task,
  phaseRuns,
  onOpenDiff,
}: {
  task: Task;
  phaseRuns: PhaseRun[];
  onOpenDiff: () => void;
}) {
  // Latest run per phase so "View implementer output" lands on the freshest
  // attempt; the trail in the audit-trail disclosure still shows older runs.
  const latestByPhase = useMemo(() => {
    const m = new Map<string, PhaseRun>();
    for (const r of phaseRuns) {
      const prev = m.get(r.phase);
      if (!prev || r.started_at > prev.started_at) m.set(r.phase, r);
    }
    return m;
  }, [phaseRuns]);

  // Diff is conceptually available whenever we have a worktree to diff
  // against or the task was merged (we diff against the merge commit).
  const diffAvailable =
    task.worktree_status === "active" || !!task.merged_commit_sha;

  const phaseRows = Array.from(latestByPhase.entries()).sort(
    (a, b) => a[1].started_at - b[1].started_at,
  );
  const hasAny = phaseRows.length > 0 || diffAvailable;

  if (!hasAny) {
    return <p className="text-muted-foreground text-[11px] italic">none yet</p>;
  }

  return (
    <ul className="space-y-1.5">
      {phaseRows.map(([phase, run]) => (
        <PhaseOutputLink key={phase} phase={phase} run={run} />
      ))}
      {diffAvailable && (
        <li>
          <button
            type="button"
            onClick={onOpenDiff}
            className="text-primary/90 hover:text-primary inline-flex items-center gap-0.5 text-[12px] underline-offset-2 hover:underline"
          >
            <CaretRight className="size-3 shrink-0" />
            <span>
              diff
              {task.merged_commit_sha && (
                <span className="text-muted-foreground ml-1 font-mono text-[11px]">
                  ({task.merged_commit_sha.slice(0, 8)})
                </span>
              )}
            </span>
          </button>
        </li>
      )}
    </ul>
  );
}

function PhaseOutputLink({ phase, run }: { phase: string; run: PhaseRun }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-primary/90 hover:text-primary inline-flex items-center gap-0.5 text-[12px] underline-offset-2 hover:underline"
      >
        <CaretRight className="size-3 shrink-0" />
        <span>{phase} output</span>
      </button>
      <PhaseRunOutputDialog open={open} onOpenChange={setOpen} phaseRun={run} />
    </li>
  );
}

/**
 * Whether the artifacts section should render at all — call sites use this
 * to toggle the section's `hidden` flag rather than checking inside the
 * body and rendering an empty header. Keeps the sidebar layout tight.
 */
export function hasAnyArtifacts(task: Task, phaseRuns: PhaseRun[]): boolean {
  if (phaseRuns.length > 0) return true;
  if (task.worktree_status === "active") return true;
  if (task.merged_commit_sha) return true;
  return false;
}
