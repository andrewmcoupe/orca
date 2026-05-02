import { createRoute, useParams } from "@tanstack/react-router";
import { workspaceLayoutRoute } from "./layout";

function TaskDetailPage() {
  const { taskId } = useParams({ from: taskDetailRoute.id });
  return (
    <div className="space-y-3 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Task</h1>
      <p className="text-muted-foreground text-sm">
        Task detail lands in M10 — task {taskId}.
      </p>
    </div>
  );
}

export const taskDetailRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plan/$planId/task/$taskId",
  component: TaskDetailPage,
});
