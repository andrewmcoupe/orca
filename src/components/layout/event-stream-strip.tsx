import { useEffect, useRef, useState } from "react";
import { useEventDetail, useRecentEvents } from "@/features/events/hooks";
import type { EventDetail, RecentEvent } from "@/features/events/types";
import { cn } from "@/lib/utils";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

const BADGE_COLORS: Array<[predicate: (t: string) => boolean, cls: string]> = [
  [(t) => t === "PhaseRunCompleted", "bg-emerald-600"],
  [
    (t) => t === "PhaseRunFailed" || t === "WorktreeRemovalFailed",
    "bg-red-600",
  ],
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

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function EventStreamStrip({
  activeWorkspaceId,
}: {
  activeWorkspaceId: string | null;
}) {
  const { data } = useRecentEvents(activeWorkspaceId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [selected, setSelected] = useState<RecentEvent | null>(null);

  // Newest at the bottom; backend returns DESC.
  const events: RecentEvent[] = (data ?? []).slice().reverse();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="border-border bg-muted/30 h-40 overflow-y-auto border-t px-2 py-1 font-mono text-[11px] leading-relaxed"
      >
        {!activeWorkspaceId ? (
          <div className="text-muted-foreground">No active workspace.</div>
        ) : events.length === 0 ? (
          <div className="text-muted-foreground">No recent events.</div>
        ) : (
          events.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setSelected(e)}
              className="hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-ring/50 flex w-full items-baseline gap-2 rounded px-1 text-left focus-visible:ring-1 focus-visible:outline-none"
            >
              <span className="text-muted-foreground tabular-nums">
                {formatTime(e.created_at)}
              </span>
              <span
                className={cn(
                  "inline-block min-w-[110px] rounded px-1 text-center text-[10px] font-medium text-white",
                  badgeClass(e.event_type),
                )}
              >
                {e.event_type}
              </span>
              <span className="text-muted-foreground bg-muted hidden rounded border px-1 text-[10px] sm:inline-block">
                {e.aggregate_type}
              </span>
              <span className="text-muted-foreground hidden tabular-nums sm:inline-block">
                {shortId(e.aggregate_id)}
              </span>
              <span className="flex-1 truncate">{e.summary}</span>
            </button>
          ))
        )}
      </div>

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
                      "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-white",
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
  const highlight = detail ? extractHighlight(detail) : null;
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs">
      {highlight && (
        <div className="mb-3">
          <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
            {highlight.label}
          </div>
          <pre
            className={cn(
              "max-h-64 overflow-auto rounded border p-2 text-[11px] whitespace-pre-wrap break-words",
              highlight.tone === "error"
                ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
                : "bg-muted/50",
            )}
          >
            {highlight.value}
          </pre>
        </div>
      )}

      <DetailRow label="Event ID" value={selected.id} />
      <DetailRow label="Aggregate type" value={selected.aggregate_type} />
      <DetailRow label="Aggregate ID" value={selected.aggregate_id} />
      <DetailRow label="Event type" value={selected.event_type} />
      <DetailRow
        label="Created at"
        value={formatFullTimestamp(selected.created_at)}
      />
      {detail && <DetailRow label="Seq" value={String(detail.seq)} />}

      <div className="mt-4">
        <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
          Summary
        </div>
        <div className="bg-muted/50 rounded border p-2 break-words whitespace-pre-wrap">
          {selected.summary}
        </div>
      </div>

      <div className="mt-4">
        <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
          Payload
        </div>
        {isLoading ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : detail ? (
          <pre className="bg-muted/50 max-h-96 overflow-auto rounded border p-2 text-[11px] whitespace-pre-wrap break-words">
            {prettyJson(detail.payload)}
          </pre>
        ) : (
          <div className="text-muted-foreground">Event not found.</div>
        )}
      </div>

      {detail && detail.metadata && detail.metadata !== "{}" && (
        <div className="mt-3">
          <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
            Metadata
          </div>
          <pre className="bg-muted/50 max-h-48 overflow-auto rounded border p-2 text-[11px] whitespace-pre-wrap break-words">
            {prettyJson(detail.metadata)}
          </pre>
        </div>
      )}
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

type Highlight = { label: string; value: string; tone: "error" | "info" };

function extractHighlight(detail: EventDetail): Highlight | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(detail.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (k: string) =>
    typeof payload[k] === "string" ? (payload[k] as string) : "";
  switch (detail.event_type) {
    case "GateRan": {
      const passed = payload.passed === true;
      if (passed) return null;
      const name = str("gate_name");
      const output = str("output");
      return {
        label: `Gate "${name}" failed`,
        value: output || "(no output captured)",
        tone: "error",
      };
    }
    case "PhaseRunFailed": {
      const kind = str("error_kind");
      const msg = str("error_message");
      return {
        label: "Failure",
        value: [kind, msg].filter(Boolean).join("\n\n") || "(no detail)",
        tone: "error",
      };
    }
    case "WorktreeRemovalFailed": {
      const msg = str("error") || str("message") || str("reason");
      if (!msg) return null;
      return { label: "Removal error", value: msg, tone: "error" };
    }
    default:
      return null;
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
