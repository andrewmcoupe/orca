import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { workspaceLayoutRoute } from "./layout";
import { BriefingSetupScreen } from "@/features/briefings/components/setup-screen";
import { BriefingReviewScreen } from "@/features/briefings/components/review-screen";
import {
  useBriefing,
  useBriefingLiveUpdates,
} from "@/features/briefings/hooks";

const briefingNewSearchSchema = z.object({
  id: z.string().optional(),
});

function BriefingNewPage() {
  const { workspaceId } = useParams({ from: briefingNewRoute.id });
  const search = useSearch({ from: briefingNewRoute.id });
  const navigate = useNavigate();

  // Briefing id can come from a `?id=` query (resuming an in-progress briefing
  // from the plans list) or from local state once we've just created one. The
  // URL form is the canonical "resume this briefing" link.
  const [briefingId, setBriefingId] = useState<string | null>(search.id ?? null);
  useEffect(() => {
    if (search.id && search.id !== briefingId) setBriefingId(search.id);
  }, [search.id, briefingId]);

  useBriefingLiveUpdates(briefingId ?? undefined);
  const briefingQuery = useBriefing(briefingId ?? undefined);
  const briefing = briefingQuery.data ?? null;

  const goToPlans = () =>
    navigate({
      to: "/workspace/$workspaceId/plans",
      params: { workspaceId },
    });

  // Setup phase: nothing started yet.
  if (!briefingId) {
    return (
      <BriefingSetupScreen
        onCancel={goToPlans}
        onStarted={(b) => setBriefingId(b.id)}
      />
    );
  }

  // Briefing exists but the first draft hasn't landed yet (or we're between
  // the start_briefing call and the projection updating). Show a placeholder.
  if (!briefing || !briefing.current_draft) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12">
        <div className="border-border bg-muted/30 flex items-center gap-3 rounded-md border p-4">
          <span className="border-foreground/20 border-t-foreground inline-block h-3 w-3 animate-spin rounded-full border-2" />
          <p className="text-sm">Preparing your briefing…</p>
        </div>
      </div>
    );
  }

  if (briefing.status !== "active") {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12">
        <p className="text-sm">
          This briefing is {briefing.status}.{" "}
          <button
            type="button"
            onClick={goToPlans}
            className="text-primary hover:underline"
          >
            Back to plans
          </button>
        </p>
      </div>
    );
  }

  return (
    <BriefingReviewScreen
      briefing={briefing}
      onAccepted={(planId) =>
        navigate({
          to: "/workspace/$workspaceId/plan/$planId",
          params: { workspaceId, planId },
        })
      }
      onCancelled={goToPlans}
    />
  );
}

export const briefingNewRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/briefings/new",
  validateSearch: briefingNewSearchSchema,
  component: BriefingNewPage,
});
