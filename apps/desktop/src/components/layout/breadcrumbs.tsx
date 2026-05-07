import { Link, useRouter } from "@tanstack/react-router";
import { CSSProperties, Fragment, type ReactNode } from "react";
import { useWorkspaces } from "@/features/workspaces/hooks";
import { usePlan } from "@/features/plans/hooks";
import { useTask } from "@/features/tasks/hooks";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

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
    <div className="flex shrink-0 items-center gap-0.5" style={noDragStyle}>
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
  // `block truncate` on the leaf element + `min-w-0` on the wrapping flex
  // child is what lets the breadcrumb shrink instead of forcing the header
  // wider than the available width — without `block`, the inline anchor has
  // no width to truncate against in the flex context.
  if (last || !crumb.to) {
    return (
      <span className="text-foreground block truncate font-medium">
        {crumb.label}
      </span>
    );
  }
  return (
    <Link
      to={crumb.to}
      params={crumb.params}
      className="text-muted-foreground hover:text-foreground block truncate transition-colors"
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
      className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 font-body text-[11px]"
    >
      <NavButtons />
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <Fragment key={c.key}>
            {i > 0 && (
              <span
                className="text-muted-foreground/50 shrink-0"
                aria-hidden="true"
              >
                ›
              </span>
            )}
            {/* Each crumb is its own min-w-0 flex item so they share the
             * available width and truncate together; the leaf takes priority
             * via `flex-1` so the most-specific label gets whatever room is
             * left after earlier crumbs collapse. */}
            <span
              className={cn(
                "min-w-0",
                last ? "flex-1" : "max-w-[28%] shrink",
              )}
            >
              <CrumbLink crumb={c} last={last} />
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}
