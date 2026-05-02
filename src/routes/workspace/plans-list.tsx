import { createRoute, useParams } from "@tanstack/react-router";
import { z } from "zod";
import { workspaceLayoutRoute } from "./layout";

const plansSearchSchema = z.object({
  status: z
    .enum(["active", "paused", "completed", "archived", "all"])
    .default("active"),
  q: z.string().default(""),
});

export type PlansSearch = z.infer<typeof plansSearchSchema>;

function PlansListPage() {
  const { workspaceId } = useParams({ from: plansListRoute.id });
  return (
    <div className="space-y-3 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Plans</h1>
      <p className="text-muted-foreground text-sm">
        Plan list lands in M8 — workspace {workspaceId}.
      </p>
    </div>
  );
}

export const plansListRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plans",
  validateSearch: plansSearchSchema,
  component: PlansListPage,
});
