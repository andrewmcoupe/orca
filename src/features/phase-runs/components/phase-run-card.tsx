import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCancelPhaseRun, usePhaseRunOutput } from "@/features/phase-runs/hooks";
import type { PhaseRun } from "@/features/phase-runs/types";
import { cn } from "@/lib/utils";

const STATUS_BADGE: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  completed: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
};

export function PhaseRunCard({ phaseRun }: { phaseRun: PhaseRun }) {
  const output = usePhaseRunOutput(phaseRun.id);
  const cancel = useCancelPhaseRun();

  const stream = (output.data ?? []).map((c) => c.chunk).join("");

  return (
    <div className="bg-card overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">{phaseRun.phase}</span>
        <span className="text-muted-foreground text-xs">
          {phaseRun.provider} · {phaseRun.model}
        </span>
        <Badge
          variant="outline"
          className={cn(
            "ml-auto h-5 rounded-sm border px-1.5 text-[10px] uppercase tracking-wide",
            STATUS_BADGE[phaseRun.status] ?? STATUS_BADGE.cancelled,
          )}
        >
          {phaseRun.status}
        </Badge>
        {phaseRun.status === "running" && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => cancel.mutate(phaseRun.id)}
            disabled={cancel.isPending}
          >
            Cancel
          </Button>
        )}
      </div>
      {phaseRun.summary && (
        <p className="text-muted-foreground border-b px-3 py-2 text-xs">
          {phaseRun.summary}
        </p>
      )}
      {phaseRun.error_message && (
        <p className="text-destructive border-b px-3 py-2 text-xs">
          <span className="font-medium">{phaseRun.error_kind}:</span>{" "}
          {phaseRun.error_message}
        </p>
      )}
      <pre className="bg-zinc-950 text-zinc-100 max-h-64 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed">
        {stream || (
          <span className="text-zinc-500">(no output)</span>
        )}
      </pre>
    </div>
  );
}
