import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { useWorkspaces } from "@/features/workspaces/hooks";
import { usePlan } from "@/features/plans/hooks";
import { useTask } from "@/features/tasks/hooks";

type Crumb = {
  key: string;
  label: ReactNode;
  to?: string;
  params?: Record<string, string>;
};

function CrumbLink({ crumb, last }: { crumb: Crumb; last: boolean }) {
  if (last || !crumb.to) {
    return (
      <span className="text-foreground truncate font-medium">
        {crumb.label}
      </span>
    );
  }
  return (
    <Link
      to={crumb.to}
      params={crumb.params}
      className="text-muted-foreground hover:text-foreground truncate transition-colors"
    >
      {crumb.label}
    </Link>
  );
}

export function WorkspaceBreadcrumbs({
  workspaceId,
  planId,
  taskId,
}: {
  workspaceId: string;
  planId?: string;
  taskId?: string;
}) {
  const workspaces = useWorkspaces();
  const plan = usePlan(planId);
  const task = useTask(taskId);

  const ws = workspaces.data?.find((w) => w.id === workspaceId);

  const crumbs: Crumb[] = [
    {
      key: "workspace",
      label: ws?.name ?? "Workspace",
      to: "/workspace/$workspaceId/plans",
      params: { workspaceId },
    },
  ];
  if (planId) {
    crumbs.push({
      key: "plan",
      label: plan.data?.title ?? "Plan",
      to: "/workspace/$workspaceId/plan/$planId",
      params: { workspaceId, planId },
    });
  }
  if (taskId && planId) {
    crumbs.push({
      key: "task",
      label: task.data?.title ?? "Task",
      to: "/workspace/$workspaceId/plan/$planId/task/$taskId",
      params: { workspaceId, planId, taskId },
    });
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className="text-muted-foreground flex items-center gap-1.5 font-body text-[11px]"
    >
      {crumbs.map((c, i) => (
        <Fragment key={c.key}>
          {i > 0 && (
            <span className="text-muted-foreground/50" aria-hidden="true">
              ›
            </span>
          )}
          <CrumbLink crumb={c} last={i === crumbs.length - 1} />
        </Fragment>
      ))}
    </nav>
  );
}
