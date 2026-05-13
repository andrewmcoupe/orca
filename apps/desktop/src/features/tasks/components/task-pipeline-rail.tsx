import { useState, type ReactNode } from "react";
import { Lock, Terminal } from "@phosphor-icons/react";
import { PhaseConfigEditor } from "@/features/tasks/components/phase-config-editor";
import { PhaseRunOutputDialog } from "@/features/phase-runs/components/phase-run-output-dialog";
import { useWorkspaceSettings } from "@/features/workspaces/hooks";
import { resolvePhaseSettings } from "@/features/workspaces/types";
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
import { cn } from "@/lib/utils";

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

function latestRunById(
  runs: PhaseRun[],
  id: string | null,
): PhaseRun | undefined {
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

function plannedItems(
  phaseConfig: PhaseConfig,
  workspaceSettings: ReturnType<typeof useWorkspaceSettings>["data"],
): PipelineItem[] {
  if (!workspaceSettings) return fallbackItems(phaseConfig);
  return phaseConfig.phases.map((phase) => {
    const resolved = resolvePhaseSettings(workspaceSettings, phaseConfig, phase);
    return {
      kind: "phase",
      id: `phase:${phase}`,
      phase,
      status: "pending",
      phase_run_id: null,
      provider: resolved.model?.provider ?? null,
      model: resolved.model?.model ?? null,
      permission_mode: resolved.permission_mode,
      started_at: null,
      completed_at: null,
    };
  });
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
  const settingsQ = useWorkspaceSettings(workspaceId);
  const items = snapshotQ.data?.items ?? plannedItems(phaseConfig, settingsQ.data);
  const anyItemRunning = items.some((item) => item.status === "running");

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-[11px] italic">
        No phases configured.
      </p>
    );
  }

  return (
    <ol className="space-y-0">
      {items.map((item, idx) => {
        return (
          <TimelineRow
            key={item.id}
            item={item}
            isFirst={idx === 0}
            isLast={idx === items.length - 1}
          >
            {item.kind === "phase" ? (
              <PhaseRow
                item={item}
                taskId={taskId}
                anyItemRunning={anyItemRunning}
                latest={latestRunById(phaseRuns, item.phase_run_id)}
              />
            ) : (
              <GateRow item={item} />
            )}
          </TimelineRow>
        );
      })}
    </ol>
  );
}

function TimelineRow({
  item,
  isFirst,
  isLast,
  children,
}: {
  item: PipelineItem;
  isFirst: boolean;
  isLast: boolean;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[34px_minmax(0,1fr)] items-stretch gap-0">
      <TimelineTrack item={item} isFirst={isFirst} isLast={isLast} />
      <div className="min-w-0 py-1">{children}</div>
    </li>
  );
}

function TimelineTrack({
  item,
  isFirst,
  isLast,
}: {
  item: PipelineItem;
  isFirst: boolean;
  isLast: boolean;
}) {
  const spineX = 12;
  const markerX = spineX;
  const markerCenterY = 26;
  const markerSize = 18;
  const markerClass = markerTone(item.status);
  const spineClass = spineTone(item.status);

  return (
    <div className="relative min-h-full w-[34px]" aria-hidden="true">
      <svg className="absolute inset-0 z-0 h-full w-[34px] overflow-visible">
        <path
          d={`M ${spineX} ${isFirst ? markerCenterY : 0} V ${isLast ? markerCenterY : "100%"}`}
          className="text-border/60"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        {isPassedStatus(item.status) && (
          <path
            d={`M ${spineX} ${isFirst ? markerCenterY : 0} V ${isLast ? markerCenterY : "100%"}`}
            className={spineClass}
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {item.status === "running" && (
          <path
            d={`M ${spineX} 0 V ${markerCenterY}`}
            className="text-success"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
            vectorEffect="non-scaling-stroke"
          >
            <animate
              attributeName="opacity"
              values="0.55;1;0.55"
              dur="1.6s"
              repeatCount="indefinite"
            />
          </path>
        )}
      </svg>
      <span
        className={cn(
          "absolute z-10 grid place-items-center rounded-full overflow-visible",
          markerClass,
        )}
        style={{
          left: markerX - markerSize / 2,
          top: markerCenterY - markerSize / 2,
          width: markerSize,
          height: markerSize,
        }}
      >
        <TimelineMarker status={item.status} />
      </span>
    </div>
  );
}

function TimelineMarker({ status }: { status: PipelineItemStatus }) {
  if (status === "running") {
    return (
      <svg
        viewBox="0 0 48 48"
        className="pointer-events-none absolute left-1/2 top-1/2 size-11 -translate-x-1/2 -translate-y-1/2 overflow-visible"
      >
        <circle
          cx="24"
          cy="24"
          r="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.7"
        >
          <animate
            attributeName="r"
            values="11;22;22"
            dur="1.8s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.7;0;0"
            dur="1.8s"
            repeatCount="indefinite"
          />
        </circle>
        <circle
          cx="24"
          cy="24"
          r="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.7"
        >
          <animate
            attributeName="r"
            values="11;22;22"
            dur="1.8s"
            begin="0.6s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.7;0;0"
            dur="1.8s"
            begin="0.6s"
            repeatCount="indefinite"
          />
        </circle>
        <circle
          cx="24"
          cy="24"
          r="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.7"
        >
          <animate
            attributeName="r"
            values="11;22;22"
            dur="1.8s"
            begin="1.2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.7;0;0"
            dur="1.8s"
            begin="1.2s"
            repeatCount="indefinite"
          />
        </circle>
        <circle
          cx="24"
          cy="24"
          r="11"
          fill="var(--background)"
          stroke="currentColor"
          strokeWidth="2.5"
        />
        <circle cx="24" cy="24" r="4" fill="currentColor" />
      </svg>
    );
  }
  if (status === "completed" || status === "passed") {
    return (
      <svg viewBox="0 0 16 16" className="size-3">
        <path
          d="M4.1 8.2 6.7 10.8 12 5.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "failed" || status === "cancelled") {
    return (
      <svg viewBox="0 0 16 16" className="size-3">
        <path
          d="M5 5 11 11 M11 5 5 11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return <span className="bg-current size-1 rounded-full opacity-60" />;
}

function markerTone(status: PipelineItemStatus): string {
  switch (status) {
    case "running":
      return "text-success";
    case "completed":
    case "passed":
      return "bg-background text-success ring-1 ring-success/70";
    case "failed":
      return "bg-background text-destructive ring-1 ring-destructive/60";
    case "cancelled":
      return "bg-muted text-muted-foreground ring-1 ring-border";
    default:
      return "bg-background text-muted-foreground/50 ring-1 ring-border";
  }
}

function spineTone(status: PipelineItemStatus): string {
  switch (status) {
    case "completed":
    case "passed":
      return "text-success/75";
    default:
      return "text-border/60";
  }
}

function isPassedStatus(status: PipelineItemStatus): boolean {
  return status === "completed" || status === "passed";
}

function itemContainerTone(
  status: PipelineItemStatus,
  kind: PipelineItem["kind"],
) {
  if (status === "running") {
    return "border-success/35 bg-success/[0.04] ring-1 ring-success/15";
  }
  if (status === "failed") {
    return "border-destructive/35 bg-destructive/[0.04]";
  }
  if (kind === "gate") {
    return "border-border/50 bg-muted/[0.08]";
  }
  return "border-border/70 bg-muted/[0.12]";
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
    <div
      className={cn(
        "space-y-1 rounded-sm border px-2 py-2 transition-colors crisp-gradient-border",
        itemContainerTone(item.status, "phase"),
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-foreground flex-1 truncate text-[12px] font-medium">
          {item.phase}
        </span>
        <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
          {item.status === "running" && (
            <OrbitDot className="text-success shrink-0" />
          )}
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
    </div>
  );
}

function GateRow({ item }: { item: PipelineGateItem }) {
  const duration =
    item.completed_at && item.started_at
      ? formatDurationMs(item.completed_at - item.started_at)
      : `${item.timeout_seconds}s timeout`;

  return (
    <div
      className={cn(
        "space-y-1 rounded-sm border px-2 py-1.5 transition-colors",
        itemContainerTone(item.status, "gate"),
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-foreground flex-1 truncate text-[12px] font-medium">
          gate: {item.name}
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
    </div>
  );
}
