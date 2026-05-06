import { useState } from "react";
import { ArrowRight, Lock, Terminal } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PhaseConfigEditor } from "@/features/tasks/components/phase-config-editor";
import { PhaseRunOutputDialog } from "@/features/phase-runs/components/phase-run-output-dialog";
import type { PhaseConfig, PhaseType } from "@/features/tasks/types";
import {
  bundledDefaultPermissionMode,
  resolvePhaseSettings,
  type ModelChoice,
  type PermissionMode,
  type WorkspaceSettings,
} from "@/features/workspaces/types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
import { CrossfadeBar, PixelRain } from "@/components/ui/mini-loaders";
import type { PhaseRun } from "../types";

type PhaseStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

const STATUS_BADGE_STYLES: Record<Exclude<PhaseStatus, "pending">, string> = {
  running: "text-success",
  completed: "text-primary",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

const CARD_BORDER_STYLES: Record<PhaseStatus, string> = {
  pending: "border-dashed border-border/60 bg-transparent",
  running: "border-success/40 bg-success/5 ring-1 ring-success/20",
  completed: "border-primary/30 bg-primary/[0.03]",
  failed: "border-destructive/40 bg-destructive/5",
  cancelled: "border-border bg-muted/30",
};

function CustomisationDot({ tooltip }: { tooltip: string }) {
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={(props) => (
            <span
              {...props}
              aria-label={tooltip}
              className="bg-success size-1.5 rounded-full"
            />
          )}
        />
        <TooltipContent side="top" className="text-[11px]">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** True when the resolved (model, permission_mode) for this phase under the
 * task's current config differs from the resolved values under an empty task
 * config — i.e. the workspace-level defaults. The resolver is the single source
 * of truth on both sides so this stays consistent with what actually runs. */
function phaseDiffersFromWorkspaceDefault(
  phase: PhaseType,
  taskConfig: PhaseConfig,
  workspaceSettings: WorkspaceSettings,
): boolean {
  const taskResolved = resolvePhaseSettings(workspaceSettings, taskConfig, phase);
  const emptyTask: PhaseConfig = {
    phases: taskConfig.phases,
    gate_overrides: taskConfig.gate_overrides ?? null,
    models: null,
    permission_modes: null,
  };
  const wsResolved = resolvePhaseSettings(workspaceSettings, emptyTask, phase);
  return (
    !modelChoiceEq(taskResolved.model, wsResolved.model) ||
    taskResolved.permission_mode !== wsResolved.permission_mode
  );
}

function modelChoiceEq(a: ModelChoice | null, b: ModelChoice | null): boolean {
  if (a === null || b === null) return a === b;
  return a.provider === b.provider && a.model === b.model;
}

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
  taskId,
  phaseConfig,
  phaseRuns,
  onSelectRun,
}: {
  workspaceId: string;
  /** Task whose config is rendered. When omitted, the editor affordance is
   * hidden — used by previews / planning views that don't have a task id. */
  taskId?: string;
  phaseConfig: PhaseConfig;
  phaseRuns: PhaseRun[];
  onSelectRun?: (phaseRunId: string) => void;
}) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const phases = phaseConfig.phases;
  // While any phase of this task is in flight we lock down the editor — both
  // because mid-run changes wouldn't take effect (the running phase already has
  // its resolved config) and because the brief explicitly requires it.
  const anyPhaseRunning = phaseRuns.some((r) => r.status === "running");
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
    <div className="scrollbar-styled flex items-stretch gap-2 overflow-x-auto pb-1">
      {phases.map((phase, idx) => {
        const latest = latestRunForPhase(phaseRuns, phase);
        const status = deriveStatus(latest);
        return (
          <PhaseCardRow
            key={phase}
            taskId={taskId}
            phase={phase}
            status={status}
            latest={latest}
            workspaceSettings={settingsQ.data}
            phaseConfig={phaseConfig}
            isLast={idx === phases.length - 1}
            anyPhaseRunning={anyPhaseRunning}
            onSelectRun={onSelectRun}
          />
        );
      })}
    </div>
  );
}

function PhaseCardRow({
  taskId,
  phase,
  status,
  latest,
  workspaceSettings,
  phaseConfig,
  isLast,
  anyPhaseRunning,
  onSelectRun,
}: {
  taskId?: string;
  phase: PhaseType;
  status: PhaseStatus;
  latest: PhaseRun | undefined;
  workspaceSettings: WorkspaceSettings | undefined;
  phaseConfig: PhaseConfig;
  isLast: boolean;
  anyPhaseRunning: boolean;
  onSelectRun?: (phaseRunId: string) => void;
}) {
  const clickable = !!latest && !!onSelectRun;
  const isPending = status === "pending";
  const [terminalOpen, setTerminalOpen] = useState(false);

  // What the *next* run of this phase would use. We always resolve this — even
  // when there's a `latest` run to display — so the editor's initial values
  // and the customisation indicator reflect "what would run now," not what
  // historically ran. The card body still shows the historical run's values.
  const resolved = workspaceSettings
    ? resolvePhaseSettings(workspaceSettings, phaseConfig, phase)
    : null;

  // Show the historical run's values *only* while it's running — for any other
  // state we display the resolved (next-run) config so post-edit changes are
  // visible immediately. Click into the run for the historical detail.
  const showHistorical = status === "running";
  const provider =
    (showHistorical ? latest?.provider : null) ?? resolved?.model?.provider ?? null;
  const model =
    (showHistorical ? latest?.model : null) ?? resolved?.model?.model ?? null;
  const permissionMode = ((showHistorical ? latest?.permission_mode : null) ??
    resolved?.permission_mode ??
    null) as PermissionMode | null;

  // Customisation indicator: does the *current* effective config differ from
  // the workspace default for this phase? Computed fresh from props each
  // render so reset/apply paths flow through automatically. Only meaningful
  // when both the task config and workspace settings are loaded.
  const isCustomised = workspaceSettings
    ? phaseDiffersFromWorkspaceDefault(phase, phaseConfig, workspaceSettings)
    : false;

  const showEditor = !!taskId && status !== "running";
  const editorDisabled = anyPhaseRunning;
  const disabledReason = "Cannot edit while a phase is running";

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
      <div
        className={cn(
          "flex w-[200px] flex-shrink-0 flex-col",
          CARD_BORDER_STYLES[status],
          "border p-3 transition-colors",
          clickable && "hover:bg-muted/30",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={!clickable}
            onClick={() => latest && onSelectRun?.(latest.id)}
            className={cn(
              "min-w-0 flex-1 truncate text-left text-[13px] font-medium",
              isPending ? "text-muted-foreground" : "text-foreground",
              clickable ? "cursor-pointer" : "cursor-default",
            )}
          >
            {phase}
          </button>
          <div className="flex shrink-0 items-center gap-1.5">
            {isCustomised && (
              <CustomisationDot
                tooltip={
                  status === "running"
                    ? "Phase config has been customised. Edits apply to the next run."
                    : "Phase config has been customised for this task."
                }
              />
            )}
            {status === "running" ? (
              <span
                className={cn(
                  "inline-flex items-center",
                  STATUS_BADGE_STYLES.running,
                )}
                aria-label={`${phase} running`}
              >
                {phase === "auditor" ? <CrossfadeBar /> : <PixelRain />}
              </span>
            ) : (
              !isPending && (
                <span
                  className={cn(
                    "text-[9px] uppercase tracking-[0.08em]",
                    STATUS_BADGE_STYLES[status as Exclude<PhaseStatus, "pending">],
                  )}
                >
                  {status}
                </span>
              )
            )}
            {showEditor && taskId && (
              <PhaseConfigEditor
                taskId={taskId}
                phase={phase}
                initialProvider={resolved?.model?.provider ?? provider ?? null}
                initialModel={resolved?.model?.model ?? model ?? null}
                initialPermissionMode={
                  (resolved?.permission_mode ??
                    permissionMode ??
                    bundledDefaultPermissionMode(phase)) as PermissionMode
                }
                disabled={editorDisabled}
                disabledReason={disabledReason}
              />
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={!clickable}
          onClick={() => latest && onSelectRun?.(latest.id)}
          className={cn(
            "flex flex-1 flex-col gap-1 text-left",
            clickable ? "cursor-pointer" : "cursor-default",
          )}
        >

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
        {latest && (
          <Button
            variant="ghost"
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              setTerminalOpen(true);
            }}
            className="text-muted-foreground hover:text-foreground mt-2 h-7 w-full justify-center gap-1.5 border text-[11px]"
            title={
              status === "running"
                ? "Watch the live LLM output stream"
                : "Open the captured LLM output"
            }
          >
            <Terminal className="size-3" />
            View LLM output
          </Button>
        )}
      </div>
      {!isLast && (
        <div className="text-muted-foreground/60 flex shrink-0 items-center px-0.5 text-sm">
          <ArrowRight className="size-3.5" />
        </div>
      )}
      {latest && (
        <PhaseRunOutputDialog
          open={terminalOpen}
          onOpenChange={setTerminalOpen}
          phaseRun={latest}
        />
      )}
    </>
  );
}
