import {
  createRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { workspaceLayoutRoute } from "./layout";
import { usePlans } from "@/features/plans/hooks";
import { PlanRow } from "@/features/plans/components/plan-row";
import { PlansFilters } from "@/features/plans/components/plans-filters";
import { NewPlanDialog } from "@/features/plans/components/new-plan-dialog";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import type { Plan } from "@/features/plans/types";
import { Button } from "@/components/ui/button";

const plansSearchSchema = z.object({
  status: z
    .enum(["active", "paused", "completed", "archived", "all"])
    .default("active"),
  q: z.string().default(""),
});

export type PlansSearch = z.infer<typeof plansSearchSchema>;

function filterPlans(plans: Plan[], search: PlansSearch): Plan[] {
  const q = search.q.trim().toLowerCase();
  return plans
    .filter((p) =>
      search.status === "all" ? true : p.status === search.status,
    )
    .filter((p) => {
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => b.updated_at - a.updated_at);
}

function PlansListPage() {
  const { workspaceId } = useParams({ from: plansListRoute.id });
  const search = useSearch({ from: plansListRoute.id });
  const navigate = useNavigate({ from: plansListRoute.id });

  const plans = usePlans(workspaceId);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Local-only search input that syncs to the URL after a debounce, so typing
  // stays snappy and the URL is the source of truth for shareable state.
  const [localQuery, setLocalQuery] = useState(search.q);
  const debouncedQuery = useDebouncedValue(localQuery, 150);
  useEffect(() => {
    if (debouncedQuery === search.q) return;
    navigate({
      search: (prev) => ({ ...prev, q: debouncedQuery }),
      replace: true,
    });
  }, [debouncedQuery, search.q, navigate]);
  // If URL is changed externally (back/forward), keep the input in sync.
  useEffect(() => {
    if (search.q !== localQuery && search.q !== debouncedQuery) {
      setLocalQuery(search.q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.q]);

  const filtered = useMemo(
    () => filterPlans(plans.data ?? [], search),
    [plans.data, search],
  );

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Plans</h1>
        <span className="text-muted-foreground text-xs tabular-nums">
          {filtered.length} of {plans.data?.length ?? 0}
        </span>
      </div>
      <PlansFilters
        status={search.status}
        onStatusChange={(status) =>
          navigate({
            search: (prev) => ({ ...prev, status }),
            replace: true,
          })
        }
        query={localQuery}
        onQueryChange={setLocalQuery}
        onNewPlan={() => setDialogOpen(true)}
      />
      {plans.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasAnyPlans={(plans.data ?? []).length > 0}
          onNewPlan={() => setDialogOpen(true)}
        />
      ) : (
        <div className="bg-card border">
          {filtered.map((plan) => (
            <PlanRow key={plan.id} plan={plan} workspaceId={workspaceId} />
          ))}
        </div>
      )}
      <NewPlanDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(plan) =>
          navigate({
            to: "/workspace/$workspaceId/plan/$planId",
            params: { workspaceId, planId: plan.id },
          })
        }
      />
    </div>
  );
}

function EmptyState({
  hasAnyPlans,
  onNewPlan,
}: {
  hasAnyPlans: boolean;
  onNewPlan: () => void;
}) {
  return (
    <div className="bg-muted/20 rounded-md border border-dashed py-12 text-center">
      <p className="text-sm font-medium">
        {hasAnyPlans ? "No plans match your filters" : "No plans yet"}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        {hasAnyPlans
          ? "Try a different status filter or clear your search."
          : "Create your first plan to start grouping tasks."}
      </p>
      {!hasAnyPlans && (
        <Button
          type="button"
          onClick={onNewPlan}
          className="text-primary mt-3 text-sm hover:underline"
        >
          + New plan
        </Button>
      )}
    </div>
  );
}

export const plansListRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plans",
  validateSearch: plansSearchSchema,
  component: PlansListPage,
});
