import { ArrowRight, Lock } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { PhaseConfig, PhaseType } from "@/features/tasks/types";
import {
  resolvePhaseSettings,
  type PermissionMode,
  type WorkspaceSettings,
} from "@/features/workspaces/types";

// Compact, identifier-style labels for the phase card. We intentionally don't
// use `PERMISSION_MODE_LABEL` here — its prose form ("Plan (read-only)") is
// for settings UIs; the phase card uses the literal mode name a developer
// would type into config.
const PERMISSION_MODE_SHORT: Record<PermissionMode, string> = {
  plan: "plan",
  acceptEdits: "acceptEdits",
  bypassPermissions: "bypassPermissions",
};
import { useWorkspaceSettings } from "@/features/workspaces/hooks";
import type { PhaseRun } from "../types";

type PhaseStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

const STATUS_BADGE_STYLES: Record<Exclude<PhaseStatus, "pending">, string> = {
  running: "text-emerald-600 dark:text-emerald-400",
  completed: "text-blue-600 dark:text-blue-400",
  failed: "text-red-600 dark:text-red-400",
  cancelled: "text-zinc-500",
};

const CARD_BORDER_STYLES: Record<PhaseStatus, string> = {
  pending: "border-dashed border-border/60 bg-transparent",
  running:
    "border-emerald-500/40 bg-emerald-500/5 ring-1 ring-emerald-500/20",
  completed: "border-blue-500/30 bg-blue-500/[0.03]",
  failed: "border-red-500/40 bg-red-500/5",
  cancelled: "border-zinc-500/30 bg-zinc-500/[0.03]",
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
  return remSec ? `${min}m ${remSec}s` : `${min}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${Math.round(n / 1000)}k tok`;
}

export function PipelineCards({
  workspaceId,
  phaseConfig,
  phaseRuns,
  onSelectRun,
}: {
  workspaceId: string;
  phaseConfig: PhaseConfig;
  phaseRuns: PhaseRun[];
  onSelectRun?: (phaseRunId: string) => void;
}) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const phases = phaseConfig.phases;
  if (phases.length === 0) {
    return (
      <p className="text-muted-foreground text-[11px] italic">
        No phases configured for this task.
      </p>
    );
  }
  return (
    // Horizontal scroll instead of wrap — wrapping would break the read of
    // "left to right is the pipeline order" once a config has 3+ phases.
    <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
      {phases.map((phase, idx) => {
        const latest = latestRunForPhase(phaseRuns, phase);
        const status = deriveStatus(latest);
        return (
          <PhaseCardRow
            key={phase}
            phase={phase}
            status={status}
            latest={latest}
            workspaceSettings={settingsQ.data}
            phaseConfig={phaseConfig}
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
  workspaceSettings,
  phaseConfig,
  isLast,
  onSelectRun,
}: {
  phase: PhaseType;
  status: PhaseStatus;
  latest: PhaseRun | undefined;
  workspaceSettings: WorkspaceSettings | undefined;
  phaseConfig: PhaseConfig;
  isLast: boolean;
  onSelectRun?: (phaseRunId: string) => void;
}) {
  const clickable = !!latest && !!onSelectRun;
  const isPending = status === "pending";

  // For queued phases we still want to show what *will* run. Resolve from the
  // workspace settings + task overrides so the user sees model/mode upfront.
  const resolved =
    !latest && workspaceSettings
      ? resolvePhaseSettings(workspaceSettings, phaseConfig, phase)
      : null;

  const provider = latest?.provider ?? resolved?.model?.provider ?? null;
  const model = latest?.model ?? resolved?.model?.model ?? null;
  const permissionMode = (latest?.permission_mode ??
    resolved?.permission_mode ??
    null) as PermissionMode | null;

  const duration =
    latest?.completed_at && latest.started_at
      ? formatDurationMs(latest.completed_at - latest.started_at)
      : null;
  const tokens =
    latest && (latest.input_tokens || latest.output_tokens)
      ? (latest.input_tokens ?? 0) + (latest.output_tokens ?? 0)
      : null;

  return (
    <>
      <button
        type="button"
        disabled={!clickable}
        onClick={() => latest && onSelectRun?.(latest.id)}
        className={cn(
          "flex w-[200px] flex-shrink-0 flex-col gap-1 border p-3 text-left transition-colors",
          CARD_BORDER_STYLES[status],
          clickable && "hover:bg-muted/30 cursor-pointer",
          !clickable && "cursor-default",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate text-[13px] font-medium",
              isPending ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {phase}
          </span>
          {!isPending && (
            <span
              className={cn(
                "shrink-0 text-[9px] uppercase tracking-[0.08em]",
                STATUS_BADGE_STYLES[status as Exclude<PhaseStatus, "pending">],
              )}
            >
              {status}
            </span>
          )}
        </div>

        <div
          className={cn(
            "flex flex-col gap-1 font-mono text-[11px] leading-tight tabular-nums",
            isPending ? "text-muted-foreground/60" : "text-muted-foreground",
          )}
        >
          <span className="truncate">
            {provider && model ? `${provider} · ${model}` : "—"}
          </span>
          <span className="inline-flex items-center gap-1 truncate">
            {permissionMode === "plan" && (
              <Lock className="size-3 shrink-0" aria-label="read-only" />
            )}
            <span className="truncate">
              {permissionMode
                ? `mode: ${PERMISSION_MODE_SHORT[permissionMode]}`
                : "mode: —"}
            </span>
          </span>
          <span className="truncate">
            {duration && tokens
              ? `${duration} · ${formatTokens(tokens)}`
              : duration
                ? duration
                : tokens
                  ? formatTokens(tokens)
                  : isPending
                    ? "queued"
                    : "—"}
          </span>
        </div>
      </button>
      {!isLast && (
        <div className="text-muted-foreground/60 flex shrink-0 items-center px-0.5 text-sm">
          <ArrowRight className="size-3.5" />
        </div>
      )}
    </>
  );
}
