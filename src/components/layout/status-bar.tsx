import { useMemo } from "react";
import { GitBranch } from "@phosphor-icons/react";
import { useRecentEvents } from "@/features/events/hooks";
import { useProviders } from "@/features/providers/hooks";
import { usePlans } from "@/features/plans/hooks";
import {
  useActiveWorkspace,
  useWorkspaceBranch,
} from "@/features/workspaces/hooks";
import type { ProviderStatus } from "@/features/providers/types";
import type { RecentEvent } from "@/features/events/types";
import { cn } from "@/lib/utils";

type EventTone = "success" | "running" | "failure" | "neutral";

const EVENT_TONES: Array<[(t: string) => boolean, EventTone]> = [
  [(t) => t === "PhaseRunCompleted" || t === "TaskMerged" || t === "TaskApproved", "success"],
  [
    (t) =>
      t === "PhaseRunFailed" ||
      t === "WorktreeRemovalFailed" ||
      t === "WorktreeInitializationFailed",
    "failure",
  ],
  [(t) => t === "PhaseRunStarted", "running"],
];

const TONE_DOT: Record<EventTone, string> = {
  success: "bg-emerald-500",
  running: "bg-amber-500 animate-pulse",
  failure: "bg-red-500",
  neutral: "bg-zinc-500",
};

function eventTone(eventType: string): EventTone {
  for (const [pred, tone] of EVENT_TONES) if (pred(eventType)) return tone;
  return "neutral";
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

type ProviderTone = "healthy" | "degraded" | "offline";

function providerTone(p: ProviderStatus): ProviderTone {
  if (p.error || !p.installed) return "offline";
  if (!p.authenticated) return "degraded";
  return "healthy";
}

const PROVIDER_DOT: Record<ProviderTone, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  offline: "bg-red-500",
};

const PROVIDER_TITLE: Record<ProviderTone, string> = {
  healthy: "healthy",
  degraded: "not authenticated",
  offline: "offline",
};

export function StatusBar() {
  const active = useActiveWorkspace();
  const activeId = active.data?.id ?? null;
  const activePath = active.data?.path ?? null;

  return (
    <div className="border-border bg-background flex h-[22px] flex-shrink-0 items-center gap-4 border-t px-2 font-mono text-[10px]">
      <LatestEvent activeWorkspaceId={activeId} />
      <ProviderChips />
      <WorkspaceState activeWorkspaceId={activeId} activePath={activePath} />
    </div>
  );
}

function LatestEvent({
  activeWorkspaceId,
}: {
  activeWorkspaceId: string | null;
}) {
  // Just the most recent event is enough for the status bar; we re-use the
  // existing recent_events query since it's already invalidated on every
  // append via the global projection_updated listener.
  const { data } = useRecentEvents(activeWorkspaceId, 1);
  const latest: RecentEvent | undefined = data?.[0];

  return (
    <div className="flex min-w-0 max-w-[480px] flex-1 items-center gap-2">
      <span
        className={cn(
          "inline-block size-[6px] flex-shrink-0 rounded-full",
          latest ? TONE_DOT[eventTone(latest.event_type)] : "bg-zinc-600/60",
        )}
        aria-hidden="true"
      />
      {!activeWorkspaceId ? (
        <span className="text-muted-foreground/70 truncate">no workspace</span>
      ) : latest ? (
        <>
          <span className="text-muted-foreground/80 tabular-nums">
            {formatTime(latest.created_at)}
          </span>
          <span className="text-muted-foreground/80 truncate">
            {latest.event_type}
          </span>
          <span className="text-muted-foreground/60 hidden tabular-nums lg:inline">
            {shortId(latest.aggregate_id)}
          </span>
          <span className="text-muted-foreground truncate">
            {latest.summary}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground/70 truncate">no events</span>
      )}
    </div>
  );
}

function ProviderChips() {
  const { data } = useProviders();
  const providers = data ?? [];

  if (providers.length === 0) return null;

  return (
    <div className="flex items-center gap-3">
      {providers.map((p) => {
        const tone = providerTone(p);
        return (
          <span
            key={p.id}
            title={`${p.display_name} — ${PROVIDER_TITLE[tone]}${p.error ? `: ${p.error}` : ""}`}
            className="text-muted-foreground/80 inline-flex items-center gap-1.5"
          >
            <span
              className={cn(
                "inline-block size-[6px] rounded-full",
                PROVIDER_DOT[tone],
              )}
              aria-hidden="true"
            />
            <span>{p.id}</span>
          </span>
        );
      })}
    </div>
  );
}

function WorkspaceState({
  activeWorkspaceId,
  activePath,
}: {
  activeWorkspaceId: string | null;
  activePath: string | null;
}) {
  const plansQ = usePlans(activeWorkspaceId);
  const branchQ = useWorkspaceBranch(activePath);

  const inFlight = useMemo(
    () =>
      (plansQ.data ?? []).reduce(
        (acc, p) => acc + (p.running_task_count || 0),
        0,
      ),
    [plansQ.data],
  );

  return (
    <div className="text-muted-foreground/80 ml-auto flex items-center gap-3 tabular-nums">
      {branchQ.data && (
        <span className="inline-flex items-center gap-1">
          <GitBranch className="size-3" aria-hidden="true" />
          <span className="max-w-[140px] truncate">{branchQ.data}</span>
        </span>
      )}
      {activeWorkspaceId && (
        <span
          className={cn(
            "inline-flex items-center gap-1",
            inFlight > 0 && "text-foreground",
          )}
        >
          {inFlight > 0 && (
            <span
              className="bg-emerald-500 inline-block size-[6px] animate-pulse rounded-full"
              aria-hidden="true"
            />
          )}
          {inFlight} in flight
        </span>
      )}
      <button
        type="button"
        // The drawer/activity view is out of scope for this brief — the brief
        // is explicit about that. We still show the affordance so users know
        // where to look once it lands; the click is a no-op for now.
        className="text-muted-foreground/60 hover:text-foreground/80 cursor-default underline-offset-2 hover:underline"
        title="Activity drawer (coming soon)"
        disabled
      >
        events
      </button>
      <span
        className="text-muted-foreground/50"
        title="Command palette (coming soon)"
      >
        ⌘K
      </span>
    </div>
  );
}
