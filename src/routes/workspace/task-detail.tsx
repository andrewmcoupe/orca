import { useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { GitMerge, Play } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { workspaceLayoutRoute } from "./layout";
import { useTask } from "@/features/tasks/hooks";
import { TaskStatusBadge } from "@/features/tasks/presentation";
import { WorktreeSection } from "@/features/tasks/components/worktree-section";
import { WorktreeInitSection } from "@/features/tasks/components/worktree-init-section";
import { AuditorVerdictSection } from "@/features/tasks/components/auditor-verdict-section";
import { MergeDialog } from "@/features/tasks/components/merge-dialog";
import { useLatestMergeAttempt } from "@/features/tasks/merge-hooks";
import {
  usePhaseRuns,
  useStartFakePhase,
  useStartTask,
} from "@/features/phase-runs/hooks";
import { PipelineCards } from "@/features/phase-runs/components/pipeline-cards";
import { PhaseRunsTrail } from "@/features/phase-runs/components/phase-runs-trail";
import { TaskEventList } from "@/features/events/components/task-event-list";
import { DiffPanel } from "@/features/diff/components/diff-panel";
import { formatRelativeTime } from "@/lib/format";
import type { Task } from "@/features/tasks/types";

function TaskDetailPage() {
  const { workspaceId, taskId } = useParams({
    from: taskDetailRoute.id,
  });
  const taskQ = useTask(taskId);

  if (taskQ.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading task…</div>
    );
  }
  if (!taskQ.data) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Task not found.</div>
    );
  }
  return <TaskDetailView task={taskQ.data} workspaceId={workspaceId} />;
}

function TaskDetailView({
  task,
  workspaceId,
}: {
  task: Task;
  workspaceId: string;
}) {
  const phaseRuns = usePhaseRuns(workspaceId, task.id);
  const startFake = useStartFakePhase();
  const startTask = useStartTask();

  const runs = phaseRuns.data ?? [];
  const anyRunning = runs.some((r) => r.status === "running");

  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1 space-y-7 px-5 py-4">
      <header className="space-y-2">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[20px] font-medium tracking-tight">
                {task.title}
              </h1>
              <TaskStatusBadge status={task.status} />
            </div>
            <TaskHeaderMeta task={task} />
          </div>
          <TaskActionArea task={task} />
        </div>
        {task.cancel_reason && (
          <p className="bg-zinc-500/10 text-muted-foreground border px-3 py-2 font-mono text-[11px]">
            <span className="font-medium">Cancelled:</span> {task.cancel_reason}
          </p>
        )}
        <MergeAttemptInline taskId={task.id} task={task} />
      </header>

      {task.spec_markdown.trim() ? (
        <section className="space-y-2">
          <SectionLabel>Spec</SectionLabel>
          <div className="bg-muted/20 border p-3">
            <Markdown>{task.spec_markdown}</Markdown>
          </div>
        </section>
      ) : null}

      <AuditorVerdictSection taskId={task.id} />

      <WorktreeInitSection task={task} />

      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <SectionLabel>Pipeline</SectionLabel>
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              onClick={() => startTask.mutate(task.id)}
              disabled={startTask.isPending || anyRunning}
              className="gap-1"
            >
              <Play className="size-3" />
              {anyRunning
                ? "Running…"
                : runs.length === 0
                  ? "Start pipeline"
                  : "Restart"}
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                startFake.mutate({ taskId: task.id, phase: "implementer" })
              }
              disabled={startFake.isPending}
            >
              Run (fake)
            </Button>
          </div>
        </div>
        {(startFake.error || startTask.error) && (
          <p className="text-destructive text-[11px]">
            {String(startFake.error ?? startTask.error)}
          </p>
        )}
        <PipelineCards
          workspaceId={workspaceId}
          phaseConfig={task.phase_config}
          phaseRuns={runs}
        />
      </section>

      <section className="space-y-2.5">
        <SectionLabel>Audit trail</SectionLabel>
        <TaskEventList workspaceId={workspaceId} taskId={task.id} />
        {phaseRuns.isLoading ? (
          <p className="text-muted-foreground text-[11px]">Loading…</p>
        ) : (
          <PhaseRunsTrail phaseRuns={runs} />
        )}
      </section>

      <section className="space-y-2.5">
        <SectionLabel>Worktree</SectionLabel>
        <WorktreeSection task={task} />
      </section>
      </div>
      <DiffPanel workspaceId={workspaceId} taskId={task.id} />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-muted-foreground/70 font-mono text-[10px] font-medium uppercase tracking-[0.08em]">
      {children}
    </h2>
  );
}

function TaskHeaderMeta({ task }: { task: Task }) {
  if (task.status === "merged" && task.merged_commit_sha) {
    return (
      <p className="text-muted-foreground mt-1 font-mono text-[11px] tabular-nums">
        Merged into{" "}
        <code>{task.merge_target_branch ?? "main"}</code>{" "}
        as <CopyableSha sha={task.merged_commit_sha} />
        {task.merged_at != null && (
          <> · {formatRelativeTime(task.merged_at)}</>
        )}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground mt-1 font-mono text-[11px] tabular-nums">
      Updated {formatRelativeTime(task.updated_at)}
    </p>
  );
}

function CopyableSha({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    await navigator.clipboard.writeText(sha);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy commit SHA"
      className="hover:text-foreground font-mono underline-offset-2 hover:underline"
    >
      <code>{sha.slice(0, 8)}</code>
      {copied && (
        <span className="text-muted-foreground ml-1 text-[10px]">copied</span>
      )}
    </button>
  );
}

function TaskActionArea({ task }: { task: Task }) {
  const [mergeOpen, setMergeOpen] = useState(false);
  const canMerge =
    task.status === "approved" && task.worktree_status === "active";
  const worktreeGoneButApproved =
    task.status === "approved" && task.worktree_status === "removed";

  if (task.status === "merged") return null;

  if (worktreeGoneButApproved) {
    return (
      <div className="text-muted-foreground text-xs">
        Merge unavailable — worktree removed
      </div>
    );
  }

  if (!canMerge) return null;

  return (
    <>
      <Button
        size="sm"
        onClick={() => setMergeOpen(true)}
        className="gap-1"
        title="Merge this task into the current branch of the main worktree"
      >
        <GitMerge className="size-3" />
        Merge
      </Button>
      <MergeDialog
        taskId={task.id}
        taskTitle={task.title}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
      />
    </>
  );
}

/**
 * Surface the most recent failed merge attempt (if any) inline in the header so the
 * user remembers there's a conflict blocking the merge. We hide it once the task is
 * actually merged — the merge succeeded, the past attempt is no longer actionable.
 */
function MergeAttemptInline({
  taskId,
  task,
}: {
  taskId: string;
  task: Task;
}) {
  const attempt = useLatestMergeAttempt(taskId);
  if (task.status === "merged") return null;
  if (!attempt.data) return null;
  // Suppress if the attempt is older than the most recent task update — heuristic
  // for "the user has done something since" (resolved, restarted pipeline, etc).
  if (attempt.data.attempted_at < task.updated_at) return null;

  const a = attempt.data;
  const truncated = a.conflicts.slice(0, 3).join(", ");
  const more = a.conflicts.length > 3 ? `, +${a.conflicts.length - 3} more` : "";
  return (
    <p className="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 border px-3 py-2 text-xs">
      Last merge attempt blocked by conflicts{" "}
      {formatRelativeTime(a.attempted_at)}. {a.conflicts.length} file
      {a.conflicts.length === 1 ? "" : "s"}: <code className="font-mono">{truncated}{more}</code>
    </p>
  );
}

export const taskDetailRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plan/$planId/task/$taskId",
  component: TaskDetailPage,
});
