import { Link, createRoute, useParams } from "@tanstack/react-router";
import { ArrowLeft, Play } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { workspaceLayoutRoute } from "./layout";
import { useTask } from "@/features/tasks/hooks";
import { TaskStatusBadge } from "@/features/tasks/presentation";
import { WorktreeSection } from "@/features/tasks/components/worktree-section";
import { AuditorVerdictSection } from "@/features/tasks/components/auditor-verdict-section";
import {
  usePhaseRuns,
  useStartFakePhase,
  useStartTask,
} from "@/features/phase-runs/hooks";
import { PipelineCards } from "@/features/phase-runs/components/pipeline-cards";
import { PhaseRunsTrail } from "@/features/phase-runs/components/phase-runs-trail";
import { formatRelativeTime } from "@/lib/format";
import type { Task } from "@/features/tasks/types";

function TaskDetailPage() {
  const { workspaceId, planId, taskId } = useParams({
    from: taskDetailRoute.id,
  });
  const taskQ = useTask(taskId);

  if (taskQ.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading task…</div>;
  }
  if (!taskQ.data) {
    return <div className="p-6 text-sm text-muted-foreground">Task not found.</div>;
  }
  return (
    <TaskDetailView
      task={taskQ.data}
      workspaceId={workspaceId}
      planId={planId}
    />
  );
}

function TaskDetailView({
  task,
  workspaceId,
  planId,
}: {
  task: Task;
  workspaceId: string;
  planId: string;
}) {
  const phaseRuns = usePhaseRuns(workspaceId, task.id);
  const startFake = useStartFakePhase();
  const startTask = useStartTask();

  const runs = phaseRuns.data ?? [];
  const anyRunning = runs.some((r) => r.status === "running");

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <Link
        to="/workspace/$workspaceId/plan/$planId"
        params={{ workspaceId, planId }}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
      >
        <ArrowLeft className="size-3" /> Back to plan
      </Link>

      <header className="space-y-2">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {task.title}
              </h1>
              <TaskStatusBadge status={task.status} />
            </div>
            <p className="text-muted-foreground mt-1 text-xs tabular-nums">
              Updated {formatRelativeTime(task.updated_at)}
              {task.merged_commit_sha && (
                <>
                  {" · merged "}
                  <code className="font-mono">
                    {task.merged_commit_sha.slice(0, 8)}
                  </code>
                </>
              )}
            </p>
          </div>
        </div>
        {task.cancel_reason && (
          <p className="bg-zinc-500/10 text-muted-foreground rounded-md border px-3 py-2 text-xs">
            <span className="font-medium">Cancelled:</span> {task.cancel_reason}
          </p>
        )}
      </header>

      {task.spec_markdown.trim() ? (
        <section>
          <h2 className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wide">
            Spec
          </h2>
          <div className="bg-muted/20 rounded-md border p-4">
            <Markdown>{task.spec_markdown}</Markdown>
          </div>
        </section>
      ) : null}

      <AuditorVerdictSection taskId={task.id} />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
            Pipeline
          </h2>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              onClick={() => startTask.mutate(task.id)}
              disabled={startTask.isPending || anyRunning}
              className="gap-1"
            >
              <Play className="size-3" />
              {anyRunning ? "Running…" : runs.length === 0 ? "Start pipeline" : "Restart"}
            </Button>
            <Button
              variant="outline"
              size="sm"
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
          <p className="text-destructive text-xs">
            {String(startFake.error ?? startTask.error)}
          </p>
        )}
        <PipelineCards
          phaseConfig={task.phase_config}
          phaseRuns={runs}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
          Audit trail
        </h2>
        {phaseRuns.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <PhaseRunsTrail phaseRuns={runs} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
          Worktree
        </h2>
        <WorktreeSection task={task} />
      </section>
    </div>
  );
}

export const taskDetailRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plan/$planId/task/$taskId",
  component: TaskDetailPage,
});
