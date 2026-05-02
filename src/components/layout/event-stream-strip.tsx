import { useEffect, useRef } from "react";
import { useRecentEvents } from "@/features/events/hooks";
import type { RecentEvent } from "@/features/events/types";
import { cn } from "@/lib/utils";

const BADGE_COLORS: Array<[predicate: (t: string) => boolean, cls: string]> = [
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

export function EventStreamStrip({
  activeWorkspaceId,
}: {
  activeWorkspaceId: string | null;
}) {
  const { data } = useRecentEvents(activeWorkspaceId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

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
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="border-border bg-muted/30 h-20 overflow-y-auto border-t px-2 py-1 font-mono text-[11px] leading-relaxed"
    >
      {!activeWorkspaceId ? (
        <div className="text-muted-foreground">No active workspace.</div>
      ) : events.length === 0 ? (
        <div className="text-muted-foreground">No recent events.</div>
      ) : (
        events.map((e) => (
          <div key={e.id} className="flex items-baseline gap-2">
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
            <span className="truncate">{e.summary}</span>
          </div>
        ))
      )}
    </div>
  );
}
