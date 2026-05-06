import { Link } from "@tanstack/react-router";
import { PlanSourceIcon, PlanStatusBadge } from "@/features/plans/presentation";
import { formatRelativeTime } from "@/lib/format";
import type { Plan } from "@/features/plans/types";

export function PlanRow({
  plan,
  workspaceId,
}: {
  plan: Plan;
  workspaceId: string;
}) {
  return (
    <Link
      to="/workspace/$workspaceId/plan/$planId"
      params={{ workspaceId, planId: plan.id }}
      className="hover:bg-muted/40 group block border-b py-2 px-3 transition-colors last:border-b-0"
    >
      <div className="flex items-center gap-3">
        <PlanSourceIcon source={plan.source} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-xs font-medium">{plan.title}</h3>
            <PlanStatusBadge status={plan.status} />
          </div>
          <TaskSummary plan={plan} />
        </div>
        <span
          className="text-muted-foreground shrink-0 text-xs tabular-nums"
          title={new Date(plan.updated_at).toLocaleString()}
        >
          {formatRelativeTime(plan.updated_at)}
        </span>
      </div>
    </Link>
  );
}

function TaskSummary({ plan }: { plan: Plan }) {
  const done = plan.done_task_count;
  const running = plan.running_task_count;
  const failed = plan.failed_task_count;
  const total = plan.task_count;

  if (total === 0) {
    return (
      <p className="text-muted-foreground/80 mt-0.5 text-xs">No tasks yet</p>
    );
  }

  return (
    <p className="text-muted-foreground/90 mt-0.5 flex items-center gap-2 text-[11px]">
      <span className="text-muted-foreground tabular-nums">{total} tasks</span>
      {running > 0 && (
        <>
          <Sep />
          <span className="text-success tabular-nums">
            {running} running
          </span>
        </>
      )}
      {done > 0 && (
        <>
          <Sep />
          <span className="text-blue-600 dark:text-blue-400 tabular-nums">
            {done} done
          </span>
        </>
      )}
      {failed > 0 && (
        <>
          <Sep />
          <span className="text-destructive tabular-nums">{failed} failed</span>
        </>
      )}
    </p>
  );
}

function Sep() {
  return <span className="text-muted-foreground/50">·</span>;
}
