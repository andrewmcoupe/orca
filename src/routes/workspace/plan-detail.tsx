import {
  createRoute,
  Link,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { Sparkle } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ContentColumn } from "@/components/layout/content-column";
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
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading plan…</div>
    );
  }
  if (!planQ.data) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Plan not found.</div>
    );
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
    <div className="space-y-6 px-5 py-4">
      <header className="space-y-3">
        <div className="flex items-start gap-3">
          <PlanSourceIcon source={plan.source} className="mt-1.5 size-5" />
          <ContentColumn className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[20px] font-medium tracking-tight font-body">
                {plan.title}
              </h1>
              <PlanStatusBadge status={plan.status} />
            </div>
            <p className="text-muted-foreground text-xs tabular-nums font-body">
              Updated {formatRelativeTime(plan.updated_at)} · Created{" "}
              {formatRelativeTime(plan.created_at)}
            </p>
            <BriefingProvenance plan={plan} workspaceId={workspaceId} />
          </ContentColumn>
          <PlanActions plan={plan} />
        </div>
        {plan.pause_reason && (
          <ContentColumn>
            <p className="bg-amber-500/10 text-amber-800 dark:text-amber-200 border border-amber-500/30 px-3 py-2 text-xs">
              <span className="font-medium">Paused:</span> {plan.pause_reason}
            </p>
          </ContentColumn>
        )}
        {plan.cancel_reason && (
          <ContentColumn>
            <p className="bg-zinc-500/10 text-muted-foreground border px-3 py-2 text-xs">
              <span className="font-medium">Cancelled:</span>{" "}
              {plan.cancel_reason}
            </p>
          </ContentColumn>
        )}
      </header>

      {plan.description.trim() ? (
        <section>
          <ContentColumn>
            <Markdown>{plan.description}</Markdown>
          </ContentColumn>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-muted-foreground text-[10px] font-medium uppercase tracking-[0.08em]">
            Tasks{" "}
            <span className="text-muted-foreground/70 font-mono tabular-nums">
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
          <div className="bg-card border">
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

/**
 * For briefing-sourced plans, surface a small link to the briefing transcript so
 * users can audit "why does this plan look the way it does" — the assumptions
 * the model made and the pushbacks the user gave during refinement.
 */
function BriefingProvenance({
  plan,
  workspaceId,
}: {
  plan: Plan;
  workspaceId: string;
}) {
  if (plan.source !== "briefing") return null;
  const briefingId =
    typeof plan.source_metadata?.briefing_id === "string"
      ? (plan.source_metadata.briefing_id as string)
      : null;
  if (!briefingId) return null;
  return (
    <p className="mt-1.5">
      <Link
        to="/workspace/$workspaceId/briefings/$briefingId"
        params={{ workspaceId, briefingId }}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] hover:underline font-body"
      >
        <Sparkle className="size-3" weight="fill" />
        Created from briefing
      </Link>
    </p>
  );
}

export const planDetailRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plan/$planId",
  component: PlanDetailPage,
});
