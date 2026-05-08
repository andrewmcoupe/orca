import { useState } from "react";
import { Lock, Terminal } from "@phosphor-icons/react";
import { PhaseConfigEditor } from "@/features/tasks/components/phase-config-editor";
import { PhaseRunOutputDialog } from "@/features/phase-runs/components/phase-run-output-dialog";
import type { PhaseConfig, PhaseType } from "@/features/tasks/types";
import {
  bundledDefaultPermissionMode,
  resolvePhaseSettings,
  type PermissionMode,
} from "@/features/workspaces/types";
import { ProviderModelLabel } from "@/features/providers/components/provider-logo";
import { useWorkspaceSettings } from "@/features/workspaces/hooks";
import type { PhaseRun } from "@/features/phase-runs/types";
import { OrbitDot } from "@/components/ui/mini-loaders";

/**
 * Compact phase rows for the right sidebar. The brief explicitly calls out
 * "no big phase cards with heavy padding — dense rows" — so we drop the card
 * border/background and render each phase as a one-line summary plus a model
 * meta line plus a "View output" affordance. The full pipeline-card with its
 * arrow connectors lives in the main column for previews; this is its
 * sidebar variant.
 */
const PERMISSION_MODE_SHORT: Record<PermissionMode, string> = {
  plan: "plan",
  acceptEdits: "acceptEdits",
  bypassPermissions: "bypass",
};

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return remSec ? `${min}m ${remSec}s` : `${min}m`;
}

function statusOf(latest: PhaseRun | undefined): string {
  if (!latest) return "pending";
  return latest.status;
}

function latestRunForPhase(
  runs: PhaseRun[],
  phase: PhaseType,
): PhaseRun | undefined {
  return [...runs].reverse().find((r) => r.phase === phase);
}

function StatusIndicator({ status }: { status: string }) {
  if (status !== "running") {
    return (
      <span className="shrink-0 translate-y-[1px]" aria-label={status}>
        <span className="text-muted-foreground/40 relative inline-block h-3 w-3 rounded-full border border-current/15">
          <span className="absolute inset-0">
            <span className="absolute -top-[1px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-current" />
          </span>
        </span>
      </span>
    );
  }

  return (
    <span className="shrink-0 translate-y-[1px]" aria-label={status}>
      <OrbitDot className="text-success" />
    </span>
  );
}

export function TaskPipelineRail({
  workspaceId,
  taskId,
  phaseConfig,
  phaseRuns,
}: {
  workspaceId: string;
  taskId: string;
  phaseConfig: PhaseConfig;
  phaseRuns: PhaseRun[];
}) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const phases = phaseConfig.phases;
  const anyPhaseRunning = phaseRuns.some((r) => r.status === "running");

  if (phases.length === 0) {
    return (
      <p className="text-muted-foreground text-[11px] italic">
        No phases configured.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {phases.map((phase) => {
        const latest = latestRunForPhase(phaseRuns, phase);
        const status = statusOf(latest);
        const resolved = settingsQ.data
          ? resolvePhaseSettings(settingsQ.data, phaseConfig, phase)
          : null;
        // Show running run's actual values; otherwise show what the *next*
        // run would resolve to. Mirrors PipelineCards' logic so users see
        // edits reflected immediately after they apply.
        const showHistorical = status === "running";
        const provider =
          (showHistorical ? latest?.provider : null) ??
          resolved?.model?.provider ??
          null;
        const model =
          (showHistorical ? latest?.model : null) ??
          resolved?.model?.model ??
          null;
        const permissionMode = ((showHistorical
          ? latest?.permission_mode
          : null) ??
          resolved?.permission_mode ??
          null) as PermissionMode | null;
        const duration =
          latest?.completed_at && latest.started_at
            ? formatDurationMs(latest.completed_at - latest.started_at)
            : null;

        return (
          <PhaseRow
            key={phase}
            phase={phase}
            status={status}
            taskId={taskId}
            anyPhaseRunning={anyPhaseRunning}
            resolvedProvider={resolved?.model?.provider ?? provider}
            resolvedModel={resolved?.model?.model ?? model}
            resolvedPermissionMode={
              (resolved?.permission_mode ??
                permissionMode ??
                bundledDefaultPermissionMode(phase)) as PermissionMode
            }
            displayProvider={provider}
            displayModel={model}
            displayPermissionMode={permissionMode}
            duration={duration}
            latest={latest}
          />
        );
      })}
    </ul>
  );
}

function PhaseRow({
  phase,
  status,
  taskId,
  anyPhaseRunning,
  resolvedProvider,
  resolvedModel,
  resolvedPermissionMode,
  displayProvider,
  displayModel,
  displayPermissionMode,
  duration,
  latest,
}: {
  phase: PhaseType;
  status: string;
  taskId: string;
  anyPhaseRunning: boolean;
  resolvedProvider: string | null;
  resolvedModel: string | null;
  resolvedPermissionMode: PermissionMode;
  displayProvider: string | null;
  displayModel: string | null;
  displayPermissionMode: PermissionMode | null;
  duration: string | null;
  latest: PhaseRun | undefined;
}) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const showEditor = status !== "running";

  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2">
        <StatusIndicator status={status} />
        <span className="text-foreground flex-1 truncate text-[12px] font-medium">
          {phase}
        </span>
        <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
          {status === "running" ? "running" : (duration ?? "—")}
        </span>
        {showEditor && (
          <PhaseConfigEditor
            taskId={taskId}
            phase={phase}
            initialProvider={resolvedProvider}
            initialModel={resolvedModel}
            initialPermissionMode={resolvedPermissionMode}
            disabled={anyPhaseRunning}
            disabledReason="Cannot edit while a phase is running"
          />
        )}
      </div>
      <div className="text-muted-foreground flex items-center gap-1 pl-3.5 font-mono text-[10px]">
        {displayPermissionMode === "plan" && (
          <Lock className="size-2.5 shrink-0" aria-label="read-only" />
        )}
        <span className="inline-flex min-w-0 items-center gap-1 truncate">
          <ProviderModelLabel
            provider={displayProvider}
            model={displayModel}
            logoClassName="size-2.5"
          />
          {displayPermissionMode && (
            <span className="shrink-0">
              · {PERMISSION_MODE_SHORT[displayPermissionMode]}
            </span>
          )}
        </span>
      </div>
      {latest && (
        <button
          type="button"
          onClick={() => setTerminalOpen(true)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 pl-3.5 text-[11px] underline-offset-2 hover:underline"
        >
          <Terminal className="size-3" />
          View output
        </button>
      )}
      {latest && (
        <PhaseRunOutputDialog
          open={terminalOpen}
          onOpenChange={setTerminalOpen}
          phaseRun={latest}
        />
      )}
    </li>
  );
}
