import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ContentColumn } from "@/components/layout/content-column";
import {
  DetailSidebar,
  type DetailSidebarSection,
} from "@/components/layout/detail-sidebar";
import { HeaderSlot } from "@/components/layout/header-slot";
import { Markdown } from "@/components/markdown";
import { workspaceLayoutRoute } from "./layout";
import { usePlan } from "@/features/plans/hooks";
import { useTasksInPlan } from "@/features/tasks/hooks";
import { PlanSourceIcon, PlanStatusBadge } from "@/features/plans/presentation";
import { PlanActionToolbar } from "@/features/plans/components/plan-action-toolbar";
import {
  PlanArtifactsSidebarBody,
  PlanSummarySidebarBody,
  planHasArtifacts,
} from "@/features/plans/components/plan-sidebar-sections";
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
  const taskList = tasks.data ?? [];

  const sidebarSections: DetailSidebarSection[] = [
    {
      key: "summary",
      title: "Summary",
      children: <PlanSummarySidebarBody plan={plan} tasks={taskList} />,
    },
    {
      key: "artifacts",
      title: "Artifacts",
      hidden: !planHasArtifacts(plan),
      children: (
        <PlanArtifactsSidebarBody plan={plan} workspaceId={workspaceId} />
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0">
      <HeaderSlot>
        <PlanActionToolbar plan={plan} />
      </HeaderSlot>
      <div className="scrollbar-styled min-w-0 flex-1 overflow-auto">
        <div className="space-y-6 px-6 pt-4 pb-8">
          <div className="flex min-w-0 items-start gap-3">
            <PlanSourceIcon source={plan.source} className="mt-1.5 size-5" />
            <ContentColumn className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-[22px] font-medium tracking-tight font-body">
                  {plan.title}
                </h1>
                <PlanStatusBadge status={plan.status} />
              </div>
              <p className="text-muted-foreground text-[12px] tabular-nums font-body">
                Updated {formatRelativeTime(plan.updated_at)} · Created{" "}
                {formatRelativeTime(plan.created_at)}
              </p>
              {plan.pause_reason && (
                <p className="bg-amber-500/10 text-amber-800 dark:text-amber-200 border border-amber-500/30 px-3 py-2 text-xs">
                  <span className="font-medium">Paused:</span>{" "}
                  {plan.pause_reason}
                </p>
              )}
              {plan.cancel_reason && (
                <p className="bg-zinc-500/10 text-muted-foreground border px-3 py-2 text-xs">
                  <span className="font-medium">Cancelled:</span>{" "}
                  {plan.cancel_reason}
                </p>
              )}
            </ContentColumn>
          </div>

          {plan.description.trim() ? (
            <ContentColumn>
              <Markdown>{plan.description}</Markdown>
            </ContentColumn>
          ) : null}

          <ContentColumn>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-muted-foreground/80 font-mono text-[10px] font-medium uppercase tracking-[0.08em]">
                  Tasks{" "}
                  <span className="text-muted-foreground/70 ml-1 tabular-nums">
                    {plan.task_count}
                  </span>
                </h2>
                <Button
                  size="sm"
                  variant="outline"
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
              ) : taskList.length === 0 ? (
                <div className="bg-muted/20 rounded-md border border-dashed py-10 text-center">
                  <p className="text-sm">No tasks yet</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Add a task to start running phases.
                  </p>
                </div>
              ) : (
                <div className="grid gap-2">
                  {(() => {
                    const titlesById = new Map(
                      taskList.map((t) => [t.id, t.title]),
                    );
                    return taskList.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        workspaceId={workspaceId}
                        dependencyTitles={task.depends_on.map(
                          (id) => titlesById.get(id) ?? id,
                        )}
                      />
                    ));
                  })()}
                </div>
              )}
            </section>
          </ContentColumn>
        </div>
      </div>

      <DetailSidebar sections={sidebarSections} />

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
