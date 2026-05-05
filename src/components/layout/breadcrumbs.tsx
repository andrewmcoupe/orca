import { Link, useRouter } from "@tanstack/react-router";
import { CSSProperties, Fragment, type ReactNode } from "react";
import { useWorkspaces } from "@/features/workspaces/hooks";
import { usePlan } from "@/features/plans/hooks";
import { useTask } from "@/features/tasks/hooks";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { Button } from "../ui/button";

type Crumb = {
  key: string;
  label: ReactNode;
  to?: string;
  params?: Record<string, string>;
};

const noDragStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;

function NavButtons() {
  const router = useRouter();
  return (
    <div className="flex items-center gap-0.5" style={noDragStyle}>
      <Button
        variant="ghost"
        size="icon"
        className="size-5 rounded-sm text-muted-foreground border-none"
        onClick={() => router.history.back()}
        aria-label="Back"
      >
        <CaretLeft size={8} weight="bold" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-5 rounded-sm text-muted-foreground border-none"
        onClick={() => router.history.forward()}
        aria-label="Forward"
      >
        <CaretRight size={2} weight="bold" />
      </Button>
    </div>
  );
}

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
      <NavButtons />
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
