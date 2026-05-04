import { Link } from "@tanstack/react-router";
import { TaskStatusBadge } from "@/features/tasks/presentation";
import { formatRelativeTime } from "@/lib/format";
import type { Task } from "@/features/tasks/types";

export function TaskRow({
  task,
  workspaceId,
}: {
  task: Task;
  workspaceId: string;
}) {
  return (
    <Link
      to="/workspace/$workspaceId/plan/$planId/task/$taskId"
      params={{ workspaceId, planId: task.plan_id, taskId: task.id }}
      className="hover:bg-muted/40 group flex items-center gap-3 border-b px-3 py-2 transition-colors last:border-b-0 bg-muted"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-light">{task.title}</span>
          <TaskStatusBadge status={task.status} />
        </div>
      </div>
      <span
        className="text-muted-foreground text-xs tabular-nums"
        title={new Date(task.updated_at).toLocaleString()}
      >
        {formatRelativeTime(task.updated_at)}
      </span>
    </Link>
  );
}
