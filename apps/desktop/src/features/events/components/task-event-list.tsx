import { useState } from "react";
import { useRecentEvents, useEventDetail } from "@/features/events/hooks";
import { useActiveWorkspace } from "@/features/workspaces/hooks";
import { usePhaseRuns } from "@/features/phase-runs/hooks";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import type { RecentEvent } from "@/features/events/types";
import { cn } from "@/lib/utils";

const BADGE_COLORS: Array<[(t: string) => boolean, string]> = [
  [(t) => t === "PhaseRunCompleted", "bg-emerald-600"],
  [(t) => t === "PhaseRunFailed" || t === "WorktreeRemovalFailed", "bg-red-600"],
  [(t) => t === "PhaseRunStarted", "bg-emerald-500"],
  [(t) => t === "PhaseRunOutputAppended", "bg-zinc-500"],
  [(t) => t.startsWith("PhaseRun"), "bg-violet-500"],
  [(t) => t.startsWith("Plan"), "bg-amber-500"],
  [(t) => t.startsWith("Task"), "bg-blue-500"],
  [(t) => t === "WorktreeCreated", "bg-sky-500"],
  [(t) => t === "WorktreeRemoved", "bg-slate-500"],
  [(t) => t === "GateRan", "bg-orange-500"],
];

function badgeClass(eventType: string): string {
  for (const [pred, cls] of BADGE_COLORS) if (pred(eventType)) return cls;
  return "bg-slate-600";
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatFullTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleString()} (${ms})`;
}

/**
 * Per-task slice of the workspace event log. We filter the existing
 * `recent_events` rolling buffer client-side by the task ID and the IDs of
 * its phase runs (phase-run events live on their own aggregate). The buffer
 * caps at 200 rows backend-side, so older runs may not be visible — that's
 * acceptable for the in-task audit-trail view; deep history will live in the
 * future Activity view.
 */
export function TaskEventList({
  workspaceId,
  taskId,
}: {
  workspaceId: string;
  taskId: string;
}) {
  const active = useActiveWorkspace();
  const events = useRecentEvents(active.data?.id ?? null);
  const phaseRuns = usePhaseRuns(workspaceId, taskId);
  const [selected, setSelected] = useState<RecentEvent | null>(null);

  const phaseRunIds = new Set((phaseRuns.data ?? []).map((r) => r.id));
  // Show oldest first to read top-to-bottom as the task progressed.
  const filtered = (events.data ?? [])
    .filter(
      (e) =>
        (e.aggregate_type === "task" && e.aggregate_id === taskId) ||
        (e.aggregate_type === "phase_run" && phaseRunIds.has(e.aggregate_id)),
    )
    .slice()
    .reverse();

  if (filtered.length === 0) {
    return (
      <p className="text-muted-foreground text-[11px] italic">
        No events yet.
      </p>
    );
  }

  return (
    <>
      <ol className="scrollbar-styled border-border bg-muted/10 divide-border/60 max-h-[260px] divide-y overflow-y-auto border font-mono text-[11px]">
        {filtered.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => setSelected(e)}
              className="hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-ring/50 flex w-full items-baseline gap-2 px-2 py-1 text-left focus-visible:ring-1 focus-visible:outline-none"
            >
              <span className="text-muted-foreground/80 tabular-nums">
                {formatTime(e.created_at)}
              </span>
              <span
                className={cn(
                  "inline-block min-w-[110px] rounded-sm px-1 text-center text-[9px] font-medium uppercase tracking-wide text-white",
                  badgeClass(e.event_type),
                )}
              >
                {e.event_type}
              </span>
              <span className="text-foreground/90 flex-1 truncate">
                {e.summary}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <Drawer
        direction="right"
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DrawerContent className="flex h-full w-full flex-col sm:max-w-md">
          {selected && (
            <>
              <DrawerHeader className="border-border border-b">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-block rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-white",
                      badgeClass(selected.event_type),
                    )}
                  >
                    {selected.event_type}
                  </span>
                </div>
                <DrawerTitle className="mt-2 text-base break-words">
                  {selected.summary}
                </DrawerTitle>
                <DrawerDescription>
                  {formatFullTimestamp(selected.created_at)}
                </DrawerDescription>
              </DrawerHeader>
              <EventDetailBody selected={selected} />
            </>
          )}
        </DrawerContent>
      </Drawer>
    </>
  );
}

function EventDetailBody({ selected }: { selected: RecentEvent }) {
  const { data: detail, isLoading } = useEventDetail(selected.id);
  return (
    <div className="scrollbar-styled flex-1 overflow-y-auto px-4 py-3 font-mono text-xs">
      <DetailRow label="Event ID" value={selected.id} />
      <DetailRow label="Aggregate" value={`${selected.aggregate_type} ${selected.aggregate_id}`} />
      <DetailRow label="Event type" value={selected.event_type} />
      <DetailRow
        label="Created at"
        value={formatFullTimestamp(selected.created_at)}
      />
      {detail && <DetailRow label="Seq" value={String(detail.seq)} />}

      <div className="mt-4">
        <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
          Payload
        </div>
        {isLoading ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : detail ? (
          <pre className="scrollbar-styled bg-muted/50 max-h-96 overflow-auto rounded border p-2 text-[11px] whitespace-pre-wrap break-words">
            {prettyJson(detail.payload)}
          </pre>
        ) : (
          <div className="text-muted-foreground">Event not found.</div>
        )}
      </div>
    </div>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border/60 grid grid-cols-[120px_1fr] gap-2 border-b py-1.5 last:border-b-0">
      <div className="text-muted-foreground text-[10px] uppercase tracking-wide">
        {label}
      </div>
      <div className="break-words">{value}</div>
    </div>
  );
}

