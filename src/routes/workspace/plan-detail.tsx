import { createRoute, useParams } from "@tanstack/react-router";
import { workspaceLayoutRoute } from "./layout";

function PlanDetailPage() {
  const { planId } = useParams({ from: planDetailRoute.id });
  return (
    <div className="space-y-3 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Plan</h1>
      <p className="text-muted-foreground text-sm">
        Plan detail lands in M9 — plan {planId}.
      </p>
    </div>
  );
}

export const planDetailRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plan/$planId",
  component: PlanDetailPage,
});
