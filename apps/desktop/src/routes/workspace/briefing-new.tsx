import {
  createRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import { workspaceLayoutRoute } from "./layout";
import { ContentColumn } from "@/components/layout/content-column";
import { Button } from "@/components/ui/button";
import { BriefingSetupScreen } from "@/features/briefings/components/setup-screen";
import { BriefingReviewScreen } from "@/features/briefings/components/review-screen";
import { BriefingSidebar } from "@/features/briefings/components/briefing-sidebar";
import {
  useBriefing,
  useBriefingLiveOutput,
  useCancelBriefing,
  useCancelBriefingGeneration,
  useGenerateBriefingDraft,
} from "@/features/briefings/hooks";
import { ProviderModelLabel } from "@/features/providers/components/provider-logo";
import type { Briefing } from "@/features/briefings/types";

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

  const briefingQuery = useBriefing(briefingId ?? undefined);
  const briefing = briefingQuery.data ?? null;
  const liveOutput = useBriefingLiveOutput(
    briefingId ?? undefined,
    !!briefing?.is_generating,
  );
  useEffect(() => {
    if (briefing?.is_generating) liveOutput.reset();
    // Reset on each new generation start only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefing?.is_generating, briefing?.updated_at]);

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
      <ContentColumn className="mx-auto px-5 py-12">
        <div className="border-border bg-muted/30 flex items-center gap-3 rounded-md border p-4">
          <span className="border-foreground/20 border-t-foreground inline-block h-3 w-3 animate-spin rounded-full border-2" />
          <p className="text-sm">Loading briefing…</p>
        </div>
      </ContentColumn>
    );
  }

  // No draft yet — three substates the projection cleanly separates:
  //   1. is_generating   → the worker is running, show a live spinner with cancel.
  //   2. last_generation_error → the previous attempt failed; surface the reason
  //      and offer retry / cancel.
  //   3. neither         → fresh briefing or a cleanly-cancelled attempt; offer
  //      "Generate first draft".
  if (briefing.status === "active" && !briefing.current_draft) {
    return (
      <BriefingShell briefing={briefing} liveOutputText={liveOutput.text}>
        <BriefingPreDraftScreen briefing={briefing} onCancelled={goToPlans} />
      </BriefingShell>
    );
  }

  if (briefing.status !== "active") {
    return (
      <ContentColumn className="mx-auto px-5 py-12">
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
    <BriefingShell briefing={briefing} liveOutputText={liveOutput.text}>
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
    </BriefingShell>
  );
}

function BriefingShell({
  briefing,
  liveOutputText,
  children,
}: {
  briefing: Briefing;
  liveOutputText: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0">
      <div className="scrollbar-styled min-w-0 flex-1 overflow-auto">
        {children}
      </div>
      <BriefingSidebar briefing={briefing} liveOutputText={liveOutputText} />
    </div>
  );
}

/**
 * Renders the pre-first-draft phase: a generating spinner, a failure banner
 * with retry, or a clean "generate" button. The discriminator is purely the
 * briefing projection — no local UI state machine is needed because the
 * backend's `is_generating` / `last_generation_error` fields are the source
 * of truth, and the global live-updates listener keeps them current.
 */
function BriefingPreDraftScreen({
  briefing,
  onCancelled,
}: {
  briefing: Briefing;
  onCancelled: () => void;
}) {
  const generate = useGenerateBriefingDraft();
  const cancelGeneration = useCancelBriefingGeneration();
  const cancelBriefing = useCancelBriefing();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const liveOutput = useBriefingLiveOutput(briefing.id, briefing.is_generating);
  // Wipe the buffer when a fresh generation kicks off so retries start clean.
  useEffect(() => {
    if (briefing.is_generating) liveOutput.reset();
    // Intentionally only on the rising edge of `is_generating`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefing.is_generating, briefing.updated_at]);

  // Live elapsed counter while the projection says we're generating. Only
  // mounts a clock when actually generating; resets on every fresh start.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!briefing.is_generating) {
      setElapsed(0);
      return;
    }
    // Use the briefing's `updated_at` (set by `BriefingGenerationStarted`) as
    // the wall-clock origin. That way the counter is correct even if the user
    // navigated away and came back ten seconds later.
    const started = briefing.updated_at;
    setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    const t = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [briefing.is_generating, briefing.updated_at]);

  const onGenerate = async () => {
    setErrorMsg(null);
    try {
      await generate.mutateAsync(briefing.id);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const onCancelInflight = async () => {
    setErrorMsg(null);
    try {
      await cancelGeneration.mutateAsync(briefing.id);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const onCancelBriefing = async () => {
    setErrorMsg(null);
    try {
      await cancelBriefing.mutateAsync(briefing.id);
      onCancelled();
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  // Disable terminal actions during in-flight mutations to prevent
  // double-submits. Note: we don't disable based on `briefing.is_generating`
  // for the action buttons — the buttons themselves change identity (Generate
  // vs Cancel) based on that, so each button is only visible in the state
  // where it makes sense.
  const mutating =
    generate.isPending ||
    cancelGeneration.isPending ||
    cancelBriefing.isPending;

  return (
    <ContentColumn className="mx-auto space-y-4 px-5 py-8">
      <header className="space-y-1">
        <h1 className="text-xl font-medium tracking-tight">
          {briefing.is_generating ? "Generating draft" : "Resume briefing"}
        </h1>
        <p className="text-muted-foreground text-sm">
          {briefing.is_generating
            ? "The model is reading your codebase. You can leave this page — generation will continue in the background, and you'll see the result here when it lands."
            : briefing.last_generation_error
              ? "The last generation attempt didn't finish. Retry, or cancel to start over."
              : "Generate the first draft now, or cancel to start over."}
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
          <ProviderModelLabel
            provider={briefing.provider}
            model={briefing.model}
            separator="/"
            logoClassName="size-2.5"
          />
        </p>
      </div>

      {briefing.is_generating && (
        <div className="border-border bg-muted/30 space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-3">
            <span className="border-foreground/20 border-t-foreground inline-block h-3 w-3 animate-spin rounded-full border-2" />
            <div className="flex-1">
              <p className="text-sm font-medium">Reading your codebase…</p>
              <p className="text-muted-foreground text-xs">
                {elapsed}s elapsed. This typically takes 30–90 seconds.
              </p>
            </div>
          </div>
          {liveOutput.text && (
            <LiveOutputPane text={liveOutput.text} />
          )}
        </div>
      )}

      {!briefing.is_generating && briefing.last_generation_error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-md border p-3"
        >
          <p className="text-destructive text-sm font-medium">
            Last generation attempt failed
          </p>
          <p className="text-destructive/80 mt-1 whitespace-pre-wrap font-mono text-xs">
            {briefing.last_generation_error}
          </p>
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
          onClick={onCancelBriefing}
          disabled={mutating}
        >
          Cancel briefing
        </Button>
        {briefing.is_generating ? (
          <Button
            type="button"
            variant="outline"
            onClick={onCancelInflight}
            disabled={cancelGeneration.isPending}
          >
            {cancelGeneration.isPending ? "Stopping…" : "Stop generation"}
          </Button>
        ) : (
          <Button type="button" onClick={onGenerate} disabled={mutating}>
            {generate.isPending
              ? "Starting…"
              : briefing.last_generation_error
                ? "Retry generation"
                : "Generate first draft"}
          </Button>
        )}
      </div>
    </ContentColumn>
  );
}

/**
 * Scrollable, terminal-styled view of the model's live output. Auto-pins to
 * the bottom as text streams in. Shrunk and dialled back so it informs
 * without dominating the page during the wait.
 */
function LiveOutputPane({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className="bg-background text-muted-foreground max-h-48 overflow-auto rounded-sm border p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap"
    >
      {text}
    </pre>
  );
}

export const briefingNewRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/briefings/new",
  validateSearch: briefingNewSearchSchema,
  component: BriefingNewPage,
});
