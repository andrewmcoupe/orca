import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "@phosphor-icons/react";
import { workspaceLayoutRoute } from "./layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ContentColumn } from "@/components/layout/content-column";
import {
  useBriefing,
  useBriefingHistory,
  useBriefingLiveUpdates,
} from "@/features/briefings/hooks";
import { BriefingTranscriptView } from "@/features/briefings/components/transcript-view";

function BriefingDetailPage() {
  const { workspaceId, briefingId } = useParams({
    from: briefingDetailRoute.id,
  });
  const navigate = useNavigate();
  useBriefingLiveUpdates(briefingId);
  const briefingQ = useBriefing(briefingId);
  const historyQ = useBriefingHistory(briefingId);

  const goBack = () => {
    if (briefingQ.data?.final_plan_id) {
      navigate({
        to: "/workspace/$workspaceId/plan/$planId",
        params: { workspaceId, planId: briefingQ.data.final_plan_id },
      });
    } else {
      navigate({
        to: "/workspace/$workspaceId/plans",
        params: { workspaceId },
      });
    }
  };

  return (
    <ContentColumn className="space-y-5 px-5 py-5">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={goBack}
            className="-ml-2"
          >
            <ArrowLeft className="size-3.5" /> Back
          </Button>
          <div>
            <h1 className="text-[20px] font-medium tracking-tight">
              Briefing transcript
            </h1>
            <p className="text-muted-foreground mt-1 text-xs">
              Read-only audit trail of how this plan came to be.
            </p>
          </div>
        </div>
        {briefingQ.data && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-mono text-[10px]">
              {briefingQ.data.provider}:{briefingQ.data.model}
            </Badge>
            <StatusBadge status={briefingQ.data.status} />
          </div>
        )}
      </header>

      {historyQ.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading transcript…</p>
      ) : historyQ.error ? (
        <p className="text-destructive text-sm">
          Failed to load transcript: {String(historyQ.error)}
        </p>
      ) : (
        <BriefingTranscriptView entries={historyQ.data ?? []} />
      )}
    </ContentColumn>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "border-blue-500/30 bg-blue-500/15 text-blue-700 dark:text-blue-300"
      : status === "active"
        ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        : "border-zinc-500/20 bg-zinc-500/10 text-muted-foreground";
  return (
    <Badge
      variant="outline"
      className={`${cls} h-5 rounded-sm border px-1.5 text-[10px] uppercase tracking-wide`}
    >
      {status}
    </Badge>
  );
}

export const briefingDetailRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/briefings/$briefingId",
  component: BriefingDetailPage,
});
