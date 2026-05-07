import { useMemo, useState } from "react";
import { Globe, GitBranch, Stop } from "@phosphor-icons/react";
import { useRecentEvents } from "@/features/events/hooks";
import { EventsDrawer } from "@/features/events/components/events-drawer";
import {
  usePreviewServerStatus,
  useStopPreviewServer,
} from "@/features/preview-server/hooks";
import { useProviders } from "@/features/providers/hooks";
import { usePlans } from "@/features/plans/hooks";
import {
  useActiveWorkspace,
  useWorkspaceBranch,
} from "@/features/workspaces/hooks";
import type { ProviderStatus } from "@/features/providers/types";
import type { RecentEvent } from "@/features/events/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { OrbitDot } from "../ui/mini-loaders";

type EventTone = "success" | "running" | "failure" | "neutral";

const EVENT_TONES: Array<[(t: string) => boolean, EventTone]> = [
  [
    (t) =>
      t === "PhaseRunCompleted" || t === "TaskMerged" || t === "TaskApproved",
    "success",
  ],
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
  success: "bg-success",
  running: "bg-warning animate-pulse",
  failure: "bg-destructive",
  neutral: "bg-muted-foreground/60",
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
  healthy: "bg-success",
  degraded: "bg-warning",
  offline: "bg-destructive",
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
  const [eventsOpen, setEventsOpen] = useState(false);

  return (
    <>
      <div className="border-border bg-card flex flex-shrink-0 items-center gap-4 border-t px-2 py-1 font-mono">
        <LatestEvent activeWorkspaceId={activeId} />
        <ProviderChips />
        <PreviewServerIndicator />
        <WorkspaceState
          activeWorkspaceId={activeId}
          activePath={activePath}
          onOpenEvents={() => setEventsOpen(true)}
        />
      </div>
      <EventsDrawer
        open={eventsOpen}
        onOpenChange={setEventsOpen}
        workspaceId={activeId}
      />
    </>
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
    <div className="flex min-w-0 max-w-[480px] flex-1 items-center gap-2 text-xs">
      <span
        className={cn(
          "inline-block size-[6px] flex-shrink-0 rounded-full",
          latest
            ? TONE_DOT[eventTone(latest.event_type)]
            : "bg-muted-foreground/40",
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

function PreviewServerIndicator() {
  const statusQ = usePreviewServerStatus();
  const stop = useStopPreviewServer();
  const status = statusQ.data;

  if (!status || status.state === "idle") return null;

  const isActive = status.state === "starting" || status.state === "running";
  const taskId = status.task_id ? shortId(status.task_id) : "unknown";
  const title = [
    `Preview server ${status.state}`,
    status.open_url ? `URL: ${status.open_url}` : null,
    status.worktree_path ? `Worktree: ${status.worktree_path}` : null,
    status.last_error ? `Error: ${status.last_error}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 max-w-[260px] items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-xs",
        status.state === "failed"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      <Globe className="size-3 shrink-0" aria-hidden="true" />
      {isActive && (
        <span className="inline-flex text-success" aria-hidden="true">
          <OrbitDot />
        </span>
      )}
      <span className="min-w-0 truncate">
        preview {status.state} {taskId}
      </span>
      {(status.state === "starting" || status.state === "running") && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => stop.mutate()}
          disabled={stop.isPending}
          className="h-4 w-4 shrink-0 border-none p-0 text-current hover:bg-current/10"
          title="Stop preview server"
          aria-label="Stop preview server"
        >
          <Stop className="size-3" />
        </Button>
      )}
    </span>
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
            className="text-muted-foreground/80 inline-flex items-center gap-1.5 text-xs"
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
  onOpenEvents,
}: {
  activeWorkspaceId: string | null;
  activePath: string | null;
  onOpenEvents: () => void;
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
        <span className="inline-flex items-center gap-1 text-xs">
          <GitBranch className="size-3" aria-hidden="true" />
          <span className="max-w-[140px] truncate" title={branchQ.data}>
            {branchQ.data}
          </span>
        </span>
      )}
      {activeWorkspaceId && (
        <span
          className={cn(
            "inline-flex items-center gap-1 font-body text-xs font-mono",
            inFlight > 0 && "text-foreground",
          )}
        >
          {inFlight > 0 && (
            <span className="text-success inline-flex" aria-hidden="true">
              <OrbitDot />
            </span>
          )}
          {inFlight} in flight
        </span>
      )}
      <Button
        variant={"ghost"}
        size={"xs"}
        type="button"
        onClick={onOpenEvents}
        className={"border-none text-xs font-mono px-0"}
        title="Open recent events"
      >
        events
      </Button>
    </div>
  );
}
