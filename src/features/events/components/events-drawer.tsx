import { useState } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useEventDetail, useRecentEvents } from "@/features/events/hooks";
import type { RecentEvent } from "@/features/events/types";
import { cn } from "@/lib/utils";

const BADGE_COLORS: Array<[(t: string) => boolean, string]> = [
  [(t) => t === "PhaseRunCompleted", "bg-emerald-600"],
  [
    (t) =>
      t === "PhaseRunFailed" ||
      t === "WorktreeRemovalFailed" ||
      t === "WorktreeInitializationFailed",
    "bg-red-600",
  ],
  [(t) => t === "PhaseRunStarted", "bg-emerald-500"],
  [(t) => t === "PhaseRunOutputAppended", "bg-zinc-500"],
  [(t) => t.startsWith("PhaseRun"), "bg-violet-500"],
  [(t) => t.startsWith("Plan"), "bg-amber-500"],
  [(t) => t.startsWith("Briefing"), "bg-fuchsia-500"],
  [(t) => t.startsWith("Task"), "bg-blue-500"],
  [(t) => t === "WorktreeCreated", "bg-sky-500"],
  [(t) => t === "WorktreeRemoved", "bg-slate-500"],
  [(t) => t.startsWith("Worktree"), "bg-sky-600"],
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

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/**
 * Workspace-wide events drawer that slides up from the bottom of the app.
 * Reads the `recent_events` rolling buffer (capped at 200 rows backend-side)
 * for the active workspace; clicking a row opens the same payload-detail
 * side panel as the per-task event list.
 */
export function EventsDrawer({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  workspaceId: string | null;
}) {
  const events = useRecentEvents(workspaceId, 200);
  const [selected, setSelected] = useState<RecentEvent | null>(null);
  const rows = events.data ?? [];

  return (
    <>
      <Drawer direction="bottom" open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[40vh]">
          <DrawerHeader className="border-border border-b">
            <DrawerTitle className="text-sm">Recent events</DrawerTitle>
            <DrawerDescription className="text-[11px]">
              Last {rows.length} events for this workspace. Newest first.
            </DrawerDescription>
          </DrawerHeader>
          <div className="scrollbar-styled min-h-0 flex-1 overflow-y-auto">
            {!workspaceId ? (
              <p className="text-muted-foreground p-4 text-xs italic">
                Select a workspace to view its events.
              </p>
            ) : rows.length === 0 ? (
              <p className="text-muted-foreground p-4 text-xs italic">
                No events yet.
              </p>
            ) : (
              <ol className="divide-border/60 divide-y font-mono text-[11px]">
                {rows.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(e)}
                      className="hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-ring/50 flex w-full items-baseline gap-2 px-3 py-1.5 text-left focus-visible:ring-1 focus-visible:outline-none"
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
                      <span className="text-muted-foreground/60 hidden tabular-nums md:inline">
                        {e.aggregate_type}/{shortId(e.aggregate_id)}
                      </span>
                      <span className="text-foreground/90 flex-1 truncate">
                        {e.summary}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer
        direction="right"
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
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
      <DetailRow
        label="Aggregate"
        value={`${selected.aggregate_type} ${selected.aggregate_id}`}
      />
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
