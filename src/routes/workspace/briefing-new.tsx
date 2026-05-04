import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { workspaceLayoutRoute } from "./layout";
import { ContentColumn } from "@/components/layout/content-column";
import { Button } from "@/components/ui/button";
import { BriefingSetupScreen } from "@/features/briefings/components/setup-screen";
import { BriefingReviewScreen } from "@/features/briefings/components/review-screen";
import {
  useBriefing,
  useBriefingLiveUpdates,
  useCancelBriefing,
  useGenerateBriefingDraft,
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

  // Still loading the briefing record itself.
  if (briefingQuery.isLoading || !briefing) {
    return (
      <ContentColumn className="px-5 py-12">
        <div className="border-border bg-muted/30 flex items-center gap-3 rounded-md border p-4">
          <span className="border-foreground/20 border-t-foreground inline-block h-3 w-3 animate-spin rounded-full border-2" />
          <p className="text-sm">Loading briefing…</p>
        </div>
      </ContentColumn>
    );
  }

  // Briefing exists but no draft was ever produced (generation failed or the
  // window closed before it returned). Resumes get stuck here forever otherwise
  // because nothing is actually running — give the user a way to retry or bail.
  if (briefing.status === "active" && !briefing.current_draft) {
    return (
      <BriefingResumeNoDraft
        briefing={briefing}
        onCancelled={goToPlans}
      />
    );
  }

  if (briefing.status !== "active") {
    return (
      <ContentColumn className="px-5 py-12">
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
      </ContentColumn>
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

function BriefingResumeNoDraft({
  briefing,
  onCancelled,
}: {
  briefing: import("@/features/briefings/types").Briefing;
  onCancelled: () => void;
}) {
  const generate = useGenerateBriefingDraft();
  const cancel = useCancelBriefing();
  const [elapsed, setElapsed] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!generate.isPending) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [generate.isPending]);

  const onGenerate = async () => {
    setErrorMsg(null);
    try {
      await generate.mutateAsync(briefing.id);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const onCancel = async () => {
    try {
      await cancel.mutateAsync(briefing.id);
      onCancelled();
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const busy = generate.isPending || cancel.isPending;

  return (
    <ContentColumn className="space-y-4 px-5 py-8">
      <header className="space-y-1">
        <h1 className="text-xl font-medium tracking-tight">Resume briefing</h1>
        <p className="text-muted-foreground text-sm">
          This briefing was started but no draft was produced. Generate the
          first draft now, or cancel and start over.
        </p>
      </header>

      <div className="border-border bg-muted/20 rounded-md border p-3">
        <p className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
          Original description
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
          {briefing.initial_description}
        </p>
        <p className="text-muted-foreground mt-2 font-mono text-[11px]">
          {briefing.provider}:{briefing.model}
        </p>
      </div>

      {generate.isPending && (
        <div className="border-border bg-muted/30 flex items-center gap-3 rounded-md border p-3">
          <span className="border-foreground/20 border-t-foreground inline-block h-3 w-3 animate-spin rounded-full border-2" />
          <div className="flex-1">
            <p className="text-sm font-medium">Reading your codebase…</p>
            <p className="text-muted-foreground text-xs">
              {elapsed}s elapsed. This typically takes 30–90 seconds.
            </p>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3">
          <p className="text-destructive/80 font-mono text-xs">{errorMsg}</p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel briefing
        </Button>
        <Button type="button" onClick={onGenerate} disabled={busy}>
          {generate.isPending ? "Generating…" : "Generate first draft"}
        </Button>
      </div>
    </ContentColumn>
  );
}

export const briefingNewRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/briefings/new",
  validateSearch: briefingNewSearchSchema,
  component: BriefingNewPage,
});
