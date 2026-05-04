import { useMemo, useState } from "react";
import {
  ArrowUUpLeft,
  CheckCircle,
  Copy,
  DotsThree,
  GitDiff,
  GitMerge,
  Play,
  Stop,
  Trash,
  XCircle,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  useApproveTaskAnyway,
  useDeleteWorktree,
  useLatestAuditorVerdict,
  useRejectTask,
} from "@/features/tasks/hooks";
import {
  useCancelPhaseRun,
  usePhaseRuns,
  useStartFakePhase,
  useStartTask,
  useStartTaskPhase,
} from "@/features/phase-runs/hooks";
import { MergeDialog } from "./merge-dialog";
import { PassBackDialog } from "./pass-back-dialog";
import type { AuditorVerdict, AuditorVerdictKind, Task } from "../types";
import type { PhaseRun } from "@/features/phase-runs/types";

type PrimaryActionId =
  | "run"
  | "approve"
  | "pass_back"
  | "merge"
  | null;

type ToolbarState = {
  task: Task;
  phaseRunning: PhaseRun | undefined;
  hasAnyRun: boolean;
  allFailed: boolean;
  implementerCompleted: boolean;
  verdict: AuditorVerdict | null;
  worktreeActive: boolean;
};

/**
 * Pure: derive which action gets primary visual weight from the task's current
 * state. Recomputed on every render — falling out of reactive rendering keeps
 * us honest, no sync logic to forget. Returning `null` is correct for terminal
 * states (merged, cancelled) where there is no obvious next step.
 */
function computePrimary(s: ToolbarState): PrimaryActionId {
  const { task, phaseRunning, hasAnyRun, allFailed, verdict } = s;
  if (task.status === "merged" || task.status === "cancelled" || task.status === "archived") {
    return null;
  }
  if (phaseRunning) return null;
  if (task.status === "approved" && s.worktreeActive) return "merge";
  const kind = verdict?.verdict as AuditorVerdictKind | undefined;
  if (kind === "revise" || kind === "reject") return "pass_back";
  if (kind === "approve" && task.status !== "approved") return "approve";
  if (!hasAnyRun || allFailed) return "run";
  return null;
}

/**
 * Action toolbar for the task detail view. One known place for primary actions;
 * tooltips on every button explain what they do (and, when disabled, why).
 *
 * State is derived from the task projection plus a handful of supporting
 * queries (phase runs, latest verdict). Click handlers fan out to the existing
 * Tauri commands; the toolbar itself adds no business logic.
 */
export function TaskActionToolbar({
  task,
  workspaceId,
  onOpenDiff,
}: {
  task: Task;
  workspaceId: string;
  onOpenDiff: () => void;
}) {
  const phaseRunsQ = usePhaseRuns(workspaceId, task.id);
  const verdictQ = useLatestAuditorVerdict(task.id);
  const runs = phaseRunsQ.data ?? [];
  const verdict = verdictQ.data ?? null;

  const phaseRunning = runs.find((r) => r.status === "running");
  const hasAnyRun = runs.length > 0;
  const allFailed =
    hasAnyRun && runs.every((r) => r.status === "failed" || r.status === "cancelled");
  const implementerCompleted = runs.some(
    (r) => r.phase === "implementer" && r.status === "completed",
  );
  const worktreeActive = task.worktree_status === "active";
  const worktreeRemoved = task.worktree_status === "removed";

  const state: ToolbarState = {
    task,
    phaseRunning,
    hasAnyRun,
    allFailed,
    implementerCompleted,
    verdict,
    worktreeActive,
  };

  const primary = useMemo(() => computePrimary(state), [
    task.id,
    task.status,
    task.worktree_status,
    runs.length,
    phaseRunning?.id,
    hasAnyRun,
    allFailed,
    verdict?.verdict,
  ]);

  const startTask = useStartTask();
  const startFake = useStartFakePhase();
  const startTaskPhase = useStartTaskPhase();
  const cancelPhaseRun = useCancelPhaseRun();
  const approve = useApproveTaskAnyway();
  const reject = useRejectTask();
  const deleteWorktree = useDeleteWorktree();

  const [mergeOpen, setMergeOpen] = useState(false);
  const [passBackOpen, setPassBackOpen] = useState(false);

  // === Run / Restart =====================================================
  const isMerged = task.status === "merged";
  const isCancelled = task.status === "cancelled";
  const isApproved = task.status === "approved";

  const runLabel = hasAnyRun ? "Restart" : "Run";
  const runDisabled = !!phaseRunning || isMerged || isCancelled || startTask.isPending;
  const runTooltip = phaseRunning
    ? "A phase is already running."
    : isMerged
      ? "Task is already merged."
      : isCancelled
        ? "Task was cancelled."
        : hasAnyRun
          ? "Restart from the beginning."
          : "Start the pipeline.";

  // === Approve ===========================================================
  const approveDisabled =
    !verdict || isApproved || isMerged || isCancelled || approve.isPending;
  const approveTooltip = !verdict
    ? "No auditor verdict yet."
    : isApproved
      ? "Already approved."
      : isMerged
        ? "Task is already merged."
        : isCancelled
          ? "Task was cancelled."
          : "Approve task and prepare for merge.";

  // === Pass back =========================================================
  const passBackDisabled = !verdict || isMerged || isCancelled || isApproved;
  const passBackTooltip = !verdict
    ? "No verdict to pass back from."
    : isMerged
      ? "Task is already merged."
      : isCancelled
        ? "Task was cancelled."
        : isApproved
          ? "Task is already approved."
          : "Run the implementer again with the auditor's feedback as context.";

  // === Reject ============================================================
  const rejectDisabled =
    !verdict || isMerged || isCancelled || reject.isPending;
  const rejectTooltip = !verdict
    ? "No auditor verdict yet."
    : isMerged
      ? "Task is already merged."
      : isCancelled
        ? "Task was already cancelled."
        : "Cancel this task without merging.";

  // === Merge =============================================================
  const mergeDisabled = !isApproved || !worktreeActive || isMerged;
  const mergeTooltip = isMerged
    ? "Task is already merged."
    : !isApproved
      ? "Approve the task first."
      : worktreeRemoved
        ? "Worktree was removed — merge unavailable."
        : !worktreeActive
          ? "Worktree unavailable."
          : "Open the merge dialog to merge into the current branch.";

  // === Review diff =======================================================
  // Diff is conceptually available whenever we have a worktree to diff against
  // or the task has been merged (we can diff against the merge commit). We let
  // the modal itself handle "no diff yet" empty-states; here we just check the
  // baseline.
  const diffDisabled = !worktreeActive && !task.merged_commit_sha;
  const diffTooltip = diffDisabled
    ? "No diff available yet."
    : "Open the diff in side-by-side view.";

  return (
    <TooltipProvider delay={200}>
      <div className="flex flex-wrap items-center gap-1">
        <ToolbarButton
          icon={<Play weight={primary === "run" ? "fill" : "regular"} />}
          label={runLabel}
          isPrimary={primary === "run"}
          disabled={runDisabled}
          tooltip={runTooltip}
          onClick={() => startTask.mutate(task.id)}
        />
        <ToolbarButton
          icon={<CheckCircle weight={primary === "approve" ? "fill" : "regular"} />}
          label="Approve"
          isPrimary={primary === "approve"}
          disabled={approveDisabled}
          tooltip={approveTooltip}
          onClick={() => approve.mutate(task.id)}
        />
        <ToolbarButton
          icon={<ArrowUUpLeft />}
          label="Pass back"
          isPrimary={primary === "pass_back"}
          disabled={passBackDisabled}
          tooltip={passBackTooltip}
          onClick={() => setPassBackOpen(true)}
        />
        <ToolbarButton
          icon={<XCircle />}
          label="Reject"
          isPrimary={false}
          disabled={rejectDisabled}
          tooltip={rejectTooltip}
          variant="reject"
          onClick={() => reject.mutate(task.id)}
        />
        <ToolbarButton
          icon={<GitMerge weight={primary === "merge" ? "fill" : "regular"} />}
          label="Merge"
          isPrimary={primary === "merge"}
          disabled={mergeDisabled}
          tooltip={mergeTooltip}
          onClick={() => setMergeOpen(true)}
        />
        <ToolbarButton
          icon={<GitDiff />}
          label="Review diff"
          isPrimary={false}
          disabled={diffDisabled}
          tooltip={diffTooltip}
          onClick={onOpenDiff}
        />

        <OverflowMenu
          task={task}
          phaseRunning={phaseRunning}
          implementerCompleted={implementerCompleted}
          worktreeActive={worktreeActive}
          onCancelPhase={(phaseRunId) => cancelPhaseRun.mutate(phaseRunId)}
          onRerunAuditor={() =>
            startTaskPhase.mutate({ taskId: task.id, phase: "auditor" })
          }
          onCopyId={() => {
            void navigator.clipboard.writeText(task.id);
          }}
          onDeleteWorktree={() =>
            deleteWorktree.mutate({ taskId: task.id, force: false })
          }
          onRunFake={() =>
            startFake.mutate({ taskId: task.id, phase: "implementer" })
          }
        />
      </div>

      <MergeDialog
        taskId={task.id}
        taskTitle={task.title}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
      />
      <PassBackDialog
        taskId={task.id}
        open={passBackOpen}
        onOpenChange={setPassBackOpen}
      />
    </TooltipProvider>
  );
}

function ToolbarButton({
  icon,
  label,
  isPrimary,
  disabled,
  tooltip,
  onClick,
  variant,
}: {
  icon: React.ReactNode;
  label: string;
  isPrimary: boolean;
  disabled: boolean;
  tooltip: string;
  onClick: () => void;
  variant?: "reject";
}) {
  // Wrap a span around disabled buttons so the tooltip still fires on hover —
  // pointer-events:none on a disabled button suppresses the trigger otherwise.
  const button = (
    <Button
      size="sm"
      variant={isPrimary ? "default" : "ghost"}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "gap-1",
        variant === "reject" &&
          !isPrimary &&
          !disabled &&
          "text-muted-foreground hover:text-destructive",
      )}
    >
      {icon}
      {label}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <span {...props} className="inline-flex">
            {button}
          </span>
        )}
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function OverflowMenu({
  task,
  phaseRunning,
  implementerCompleted,
  worktreeActive,
  onCancelPhase,
  onRerunAuditor,
  onCopyId,
  onDeleteWorktree,
  onRunFake,
}: {
  task: Task;
  phaseRunning: PhaseRun | undefined;
  implementerCompleted: boolean;
  worktreeActive: boolean;
  onCancelPhase: (phaseRunId: string) => void;
  onRerunAuditor: () => void;
  onCopyId: () => void;
  onDeleteWorktree: () => void;
  onRunFake: () => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={(props) => (
            <span {...props} className="inline-flex">
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="More actions"
                  >
                    <DotsThree weight="bold" />
                  </Button>
                }
              />
            </span>
          )}
        />
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {/* Phase actions */}
        <DropdownMenuItem
          disabled={!phaseRunning}
          onClick={() => phaseRunning && onCancelPhase(phaseRunning.id)}
        >
          <Stop />
          <span className="flex-1">Cancel running phase</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!implementerCompleted || !!phaseRunning}
          onClick={onRerunAuditor}
        >
          <Play />
          <span className="flex-1">Re-run auditor only</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Utility actions */}
        <DropdownMenuItem onClick={onCopyId}>
          <Copy />
          <span className="flex-1">Copy task ID</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!worktreeActive}
          variant="destructive"
          onClick={onDeleteWorktree}
        >
          <Trash />
          <span className="flex-1">Delete worktree</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Development tools */}
        <DropdownMenuItem
          disabled={!!phaseRunning || task.status === "merged"}
          onClick={onRunFake}
        >
          <Play />
          <span className="flex-1">Run (fake)</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
