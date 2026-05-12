import { useState } from "react";
import { ArrowDown, Lock, Terminal } from "@phosphor-icons/react";
import { PhaseConfigEditor } from "@/features/tasks/components/phase-config-editor";
import { PhaseRunOutputDialog } from "@/features/phase-runs/components/phase-run-output-dialog";
import type {
  PhaseConfig,
  PhaseType,
  PipelineGateItem,
  PipelineItem,
  PipelinePhaseItem,
  PipelineItemStatus,
  PermissionMode,
} from "@/features/tasks/types";
import { ProviderModelLabel } from "@/features/providers/components/provider-logo";
import type { PhaseRun } from "@/features/phase-runs/types";
import { OrbitDot } from "@/components/ui/mini-loaders";
import { useTaskPipelineSnapshot } from "@/features/tasks/hooks";

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

function latestRunById(runs: PhaseRun[], id: string | null): PhaseRun | undefined {
  return id ? runs.find((run) => run.id === id) : undefined;
}

function fallbackItems(phaseConfig: PhaseConfig): PipelineItem[] {
  return phaseConfig.phases.map((phase) => ({
    kind: "phase",
    id: `phase:${phase}`,
    phase,
    status: "pending",
    phase_run_id: null,
    provider: null,
    model: null,
    permission_mode: "acceptEdits",
    started_at: null,
    completed_at: null,
  }));
}

function StatusIndicator({ status }: { status: PipelineItemStatus | string }) {
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
  const snapshotQ = useTaskPipelineSnapshot(workspaceId, taskId);
  const items = snapshotQ.data?.items ?? fallbackItems(phaseConfig);
  const anyItemRunning = items.some((item) => item.status === "running");

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-[11px] italic">
        No phases configured.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {items.flatMap((item, idx) => {
        const isLast = idx === items.length - 1;
        const row =
          item.kind === "phase" ? (
            <PhaseRow
              key={item.id}
              item={item}
              taskId={taskId}
              anyItemRunning={anyItemRunning}
              latest={latestRunById(phaseRuns, item.phase_run_id)}
            />
          ) : (
            <GateRow key={item.id} item={item} />
          );
        return [row, ...(!isLast ? [<PipelineArrow key={`${item.id}:arrow`} />] : [])];
      })}
    </ul>
  );
}

function PipelineArrow() {
  return (
    <li
      className="text-muted-foreground/50 flex justify-center"
      aria-hidden="true"
    >
      <ArrowDown className="size-3.5" />
    </li>
  );
}

function PhaseRow({
  item,
  taskId,
  anyItemRunning,
  latest,
}: {
  item: PipelinePhaseItem;
  taskId: string;
  anyItemRunning: boolean;
  latest: PhaseRun | undefined;
}) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const showEditor = item.status !== "running";
  const duration =
    item.completed_at && item.started_at
      ? formatDurationMs(item.completed_at - item.started_at)
      : null;

  return (
    <li className="crisp-gradient-border space-y-1 rounded-sm p-2">
      <div className="flex items-center gap-2">
        <StatusIndicator status={item.status} />
        <span className="text-foreground flex-1 truncate text-[12px] font-medium">
          {item.phase}
        </span>
        <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
          {item.status === "running" ? "running" : (duration ?? "—")}
        </span>
        {showEditor && (
          <PhaseConfigEditor
            taskId={taskId}
            phase={item.phase as PhaseType}
            initialProvider={item.provider}
            initialModel={item.model}
            initialPermissionMode={item.permission_mode}
            disabled={anyItemRunning}
            disabledReason="Cannot edit while pipeline work is running"
          />
        )}
      </div>
      <div className="text-muted-foreground flex items-center gap-1 pl-3.5 font-mono text-[10px]">
        {item.permission_mode === "plan" && (
          <Lock className="size-2.5 shrink-0" aria-label="read-only" />
        )}
        <span className="inline-flex min-w-0 items-center gap-1 truncate">
          <ProviderModelLabel
            provider={item.provider}
            model={item.model}
            logoClassName="size-2.5"
          />
          {item.permission_mode && (
            <span className="shrink-0">
              · {PERMISSION_MODE_SHORT[item.permission_mode]}
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

function GateRow({ item }: { item: PipelineGateItem }) {
  const duration =
    item.completed_at && item.started_at
      ? formatDurationMs(item.completed_at - item.started_at)
      : `${item.timeout_seconds}s timeout`;

  return (
    <li className="crisp-gradient-border space-y-1 rounded-sm p-2">
      <div className="flex items-center gap-2">
        <StatusIndicator status={item.status} />
        <span className="text-foreground flex-1 truncate text-[12px] font-medium">
          {item.name}
        </span>
        <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
          {item.status === "running" ? "running" : item.status}
        </span>
      </div>
      <div className="text-muted-foreground flex items-center gap-1 pl-3.5 font-mono text-[10px]">
        <Terminal className="size-2.5 shrink-0" aria-label="gate command" />
        <span className="min-w-0 flex-1 truncate">{item.command}</span>
        <span className="shrink-0">{duration}</span>
      </div>
    </li>
  );
}
