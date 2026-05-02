import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { workspaceLayoutRoute } from "./layout";
import { usePlan } from "@/features/plans/hooks";
import { useTasksInPlan } from "@/features/tasks/hooks";
import { PlanSourceIcon, PlanStatusBadge } from "@/features/plans/presentation";
import { PlanActions } from "@/features/plans/components/plan-actions";
import { TaskRow } from "@/features/tasks/components/task-row";
import { NewTaskDialog } from "@/features/tasks/components/new-task-dialog";
import { formatRelativeTime } from "@/lib/format";
import type { Plan } from "@/features/plans/types";

function PlanDetailPage() {
  const { workspaceId, planId } = useParams({ from: planDetailRoute.id });
  const planQ = usePlan(planId);

  if (planQ.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading plan…</div>;
  }
  if (!planQ.data) {
    return <div className="p-6 text-sm text-muted-foreground">Plan not found.</div>;
  }
  return <PlanDetailView plan={planQ.data} workspaceId={workspaceId} />;
}

function PlanDetailView({
  plan,
  workspaceId,
}: {
  plan: Plan;
  workspaceId: string;
}) {
  const tasks = useTasksInPlan(plan.id);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="space-y-3">
        <div className="flex items-start gap-3">
          <PlanSourceIcon source={plan.source} className="mt-1.5 size-5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {plan.title}
              </h1>
              <PlanStatusBadge status={plan.status} />
            </div>
            <p className="text-muted-foreground mt-1 text-xs tabular-nums">
              Updated {formatRelativeTime(plan.updated_at)} · Created{" "}
              {formatRelativeTime(plan.created_at)}
            </p>
          </div>
          <PlanActions plan={plan} />
        </div>
        {plan.pause_reason && (
          <p className="bg-amber-500/10 text-amber-800 dark:text-amber-200 rounded-md border border-amber-500/30 px-3 py-2 text-xs">
            <span className="font-medium">Paused:</span> {plan.pause_reason}
          </p>
        )}
        {plan.cancel_reason && (
          <p className="bg-zinc-500/10 text-muted-foreground rounded-md border px-3 py-2 text-xs">
            <span className="font-medium">Cancelled:</span> {plan.cancel_reason}
          </p>
        )}
      </header>

      {plan.description.trim() ? (
        <section>
          <Markdown>{plan.description}</Markdown>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Tasks{" "}
            <span className="text-muted-foreground/70 font-normal tabular-nums">
              {plan.task_count}
            </span>
          </h2>
          <Button
            size="sm"
            onClick={() => setNewTaskOpen(true)}
            disabled={
              plan.status === "cancelled" ||
              plan.status === "archived" ||
              plan.status === "completed"
            }
          >
            + New task
          </Button>
        </div>
        {tasks.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading tasks…</p>
        ) : (tasks.data ?? []).length === 0 ? (
          <div className="bg-muted/20 rounded-md border border-dashed py-10 text-center">
            <p className="text-sm">No tasks yet</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Add a task to start running phases.
            </p>
          </div>
        ) : (
          <div className="bg-card rounded-md border">
            {(tasks.data ?? []).map((task) => (
              <TaskRow key={task.id} task={task} workspaceId={workspaceId} />
            ))}
          </div>
        )}
      </section>

      <NewTaskDialog
        planId={plan.id}
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        onCreated={(task) =>
          navigate({
            to: "/workspace/$workspaceId/plan/$planId/task/$taskId",
            params: {
              workspaceId,
              planId: plan.id,
              taskId: task.id,
            },
          })
        }
      />
    </div>
  );
}

export const planDetailRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plan/$planId",
  component: PlanDetailPage,
});
