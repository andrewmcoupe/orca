import { ArrowRight, Lock } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PhaseConfig, PhaseType } from "@/features/tasks/types";
import { PERMISSION_MODE_LABEL, type PermissionMode } from "@/features/workspaces/types";
import type { PhaseRun } from "../types";

type PhaseStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

const PHASE_STATUS_STYLES: Record<PhaseStatus, string> = {
  pending: "bg-muted/40 text-muted-foreground border-dashed",
  running:
    "bg-emerald-500/10 border-emerald-500/40 ring-1 ring-emerald-500/30 animate-pulse",
  completed: "bg-blue-500/5 border-blue-500/30",
  failed: "bg-red-500/5 border-red-500/40",
  cancelled: "bg-zinc-500/5 border-zinc-500/30",
};

function deriveStatus(latest: PhaseRun | undefined): PhaseStatus {
  if (!latest) return "pending";
  switch (latest.status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function latestRunForPhase(
  runs: PhaseRun[],
  phase: PhaseType,
): PhaseRun | undefined {
  return [...runs].reverse().find((r) => r.phase === phase);
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${min}m${remSec ? ` ${remSec}s` : ""}`;
}

export function PipelineCards({
  phaseConfig,
  phaseRuns,
  onSelectRun,
}: {
  phaseConfig: PhaseConfig;
  phaseRuns: PhaseRun[];
  onSelectRun?: (phaseRunId: string) => void;
}) {
  const phases = phaseConfig.phases;
  if (phases.length === 0) {
    return (
      <p className="text-muted-foreground text-xs italic">
        No phases configured for this task.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {phases.map((phase, idx) => {
        const latest = latestRunForPhase(phaseRuns, phase);
        const status = deriveStatus(latest);
        const duration =
          latest?.completed_at && latest.started_at
            ? formatDurationMs(latest.completed_at - latest.started_at)
            : null;
        return (
          <PhaseCardRow
            key={phase}
            phase={phase}
            status={status}
            latest={latest}
            duration={duration}
            isLast={idx === phases.length - 1}
            onSelectRun={onSelectRun}
          />
        );
      })}
    </div>
  );
}

function PhaseCardRow({
  phase,
  status,
  latest,
  duration,
  isLast,
  onSelectRun,
}: {
  phase: PhaseType;
  status: PhaseStatus;
  latest: PhaseRun | undefined;
  duration: string | null;
  isLast: boolean;
  onSelectRun?: (phaseRunId: string) => void;
}) {
  const clickable = !!latest && !!onSelectRun;
  return (
    <>
      <button
        type="button"
        disabled={!clickable}
        onClick={() => latest && onSelectRun?.(latest.id)}
        className={cn(
          "flex min-w-[160px] flex-col items-start gap-1 border p-3 text-left transition-colors",
          PHASE_STATUS_STYLES[status],
          clickable && "hover:bg-muted/40 cursor-pointer",
          !clickable && "cursor-default",
        )}
      >
        <div className="flex w-full items-center gap-2">
          <span className="font-mono text-sm">{phase}</span>
          <Badge
            variant="outline"
            className="ml-auto h-5 border px-1.5 text-[10px] uppercase tracking-wide"
          >
            {status}
          </Badge>
        </div>
        {latest && (
          <div className="text-muted-foreground space-y-0.5 text-[11px] tabular-nums">
            <div>
              {latest.provider} · {latest.model}
              {duration && <> · {duration}</>}
            </div>
            {latest.permission_mode && (
              <div className="inline-flex items-center gap-1">
                {latest.permission_mode === "plan" && (
                  <Lock className="size-3" aria-label="read-only" />
                )}
                <span>
                  mode:{" "}
                  {PERMISSION_MODE_LABEL[
                    latest.permission_mode as PermissionMode
                  ] ?? latest.permission_mode}
                </span>
              </div>
            )}
          </div>
        )}
      </button>
      {!isLast && (
        <div className="text-muted-foreground flex items-center">
          <ArrowRight className="size-4" />
        </div>
      )}
    </>
  );
}
