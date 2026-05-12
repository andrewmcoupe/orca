import { useMemo, useState } from "react";
import {
  ArrowUUpLeft,
  ArrowSquareOut,
  CheckCircle,
  Copy,
  DotsThree,
  GitDiff,
  GitMerge,
  Pencil,
  Play,
  Stop,
  Terminal,
  Trash,
  Warning,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  useApproveTaskAnyway,
  useDeleteTask,
  useDeleteWorktree,
  useLatestAuditorVerdict,
  useRejectTask,
  useTasksInPlan,
  useUnqueueTask,
} from "@/features/tasks/hooks";
import {
  useCancelPhaseRun,
  usePhaseRuns,
  useStartTask,
  useStartTaskPhase,
} from "@/features/phase-runs/hooks";
import { tasksApi } from "../api";
import { MergeDialog } from "./merge-dialog";
import { PassBackDialog } from "./pass-back-dialog";
import {
  FileOverlapDialog,
  overlapPairKey,
} from "./file-overlap-dialog";
import {
  dismissOverlapPairs,
  isOverlapDismissed,
} from "../file-overlap-suppression";
import { DependencyEditDialog } from "./dependencies-section";
import { PreviewServerDialog } from "@/features/preview-server/components/preview-server-dialog";
import { usePreviewServerStatus } from "@/features/preview-server/hooks";
import { useWorkspaceSettings } from "@/features/workspaces/hooks";
import type { AuditorVerdict, AuditorVerdictKind, FileOverlap, Task } from "../types";
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
  onOpenTerminal,
}: {
  task: Task;
  workspaceId: string;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
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
  const startTaskPhase = useStartTaskPhase();
  const cancelPhaseRun = useCancelPhaseRun();
  const approve = useApproveTaskAnyway();
  const reject = useRejectTask();
  const deleteTask = useDeleteTask();
  const deleteWorktree = useDeleteWorktree();
  const unqueueTask = useUnqueueTask();
  const tasksInPlanQ = useTasksInPlan(task.plan_id);
  const workspaceSettingsQ = useWorkspaceSettings(workspaceId);
  const previewStatusQ = usePreviewServerStatus();

  const [mergeOpen, setMergeOpen] = useState(false);
  const [passBackOpen, setPassBackOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // M8 file overlap warning: cached overlaps + the original `forceRun`
  // intent for the *current* run-click attempt. Cleared on cancel or
  // proceed. Held in component state rather than TanStack Query because
  // the dialog flow is one-shot.
  const [overlapState, setOverlapState] = useState<{
    overlaps: FileOverlap[];
    forceRun: boolean;
  } | null>(null);

  // === Run / Restart =====================================================
  const isMerged = task.status === "merged";
  const isCancelled = task.status === "cancelled";
  const isApproved = task.status === "approved";

  // Brief 4 / M6: dependency-aware run button. Three render states:
  //   1. Not blocked → "Run" / "Restart" (existing behaviour).
  //   2. Blocked, not queued → "Run" but tooltip warns "Will queue —
  //      blocked by N tasks". Click emits TaskQueued (server-side).
  //   3. Queued → button label flips to "Cancel queue".
  const blockingDeps = task.depends_on.filter((depId) => {
    const dep = tasksInPlanQ.data?.find((t) => t.id === depId);
    return dep && dep.status !== "merged";
  });
  const blockedCount = blockingDeps.length || task.depends_on.length;

  let runLabel: string;
  let runIcon: React.ReactNode;
  let runTooltip: string;
  if (task.is_queued) {
    runLabel = "Cancel queue";
    runIcon = <XCircle />;
    runTooltip = `Cancel — task is waiting for ${blockedCount} dependenc${blockedCount === 1 ? "y" : "ies"} to merge.`;
  } else if (task.is_blocked) {
    runLabel = hasAnyRun ? "Restart" : "Run";
    runIcon = <Play weight={primary === "run" ? "fill" : "regular"} />;
    runTooltip = `Will queue — task is blocked by ${blockedCount} task${blockedCount === 1 ? "" : "s"}.`;
  } else {
    runLabel = hasAnyRun ? "Restart" : "Run";
    runIcon = <Play weight={primary === "run" ? "fill" : "regular"} />;
    runTooltip = phaseRunning
      ? "A phase is already running."
      : task.worktree_init_status === "running"
        ? "Worktree is still initialising — wait for it to finish."
        : isMerged
          ? "Task is already merged."
          : isCancelled
            ? "Task was cancelled."
            : hasAnyRun
              ? "Restart from the beginning."
              : "Start the pipeline.";
  }
  const initRunning = task.worktree_init_status === "running";
  const runDisabled =
    !task.is_queued &&
    (!!phaseRunning ||
      isMerged ||
      isCancelled ||
      initRunning ||
      startTask.isPending ||
      unqueueTask.isPending);

  /** Centralised "user clicked Run" handler. Walks the staged sequence:
   *  1. If currently queued → unqueue and bail.
   *  2. Otherwise check for file overlaps (M8); if any survive the
   *     suppression set, open the warning dialog and pause. The dialog's
   *     "Proceed anyway" continues the flow with `forceRun = false` (the
   *     queue check still applies — overlap doesn't override deps).
   *  3. If no overlaps (or all suppressed), dispatch start_task. */
  const tryStartTask = async (forceRun: boolean) => {
    if (task.is_queued && !forceRun) {
      // The Run button label flips to "Cancel queue" in this state; click
      // means "stop waiting." `forceRun = true` is the overflow's "Run
      // anyway" path which dispatches immediately and skips the queue
      // entirely (so we keep the queued state on the audit trail).
      unqueueTask.mutate(task.id);
      return;
    }
    // Brief 4 / M8: "the warning doesn't fire until the queue manager
    // actually starts it." A blocked task that's about to be queued
    // doesn't need the overlap dialog — by the time it auto-starts, the
    // in-flight set will look different. Same for force_run, where the
    // user is explicitly bypassing the queue check; we still gate them
    // on the overlap warning (force_run ignores deps, not file conflicts).
    if (task.is_blocked && !forceRun) {
      startTask.mutate({ taskId: task.id, forceRun: false });
      return;
    }
    // The overlap check needs the in-flight tasks, which only exist when
    // the worktree story is well underway. For brand-new tasks with no
    // sibling phase runs, the call still happens but reliably returns [].
    let candidates: FileOverlap[] = [];
    try {
      candidates = await tasksApi.detectFileOverlap(task.id);
    } catch (e) {
      // Best-effort: a backend error (likely "no active workspace" race)
      // shouldn't strand the user. Log and proceed; if real overlap exists
      // and matters, the merge will surface it later.
      console.error("file overlap detection failed:", e);
    }
    const fresh = candidates.filter(
      (o) => !isOverlapDismissed(overlapPairKey(task.id, o.other_task_id)),
    );
    if (fresh.length > 0) {
      setOverlapState({ overlaps: fresh, forceRun });
      return;
    }
    startTask.mutate({ taskId: task.id, forceRun });
  };

  const onOverlapProceed = () => {
    if (overlapState) {
      // Mark the (starting, other) pairs dismissed so re-clicks within
      // this session bypass the dialog entirely.
      dismissOverlapPairs(
        overlapState.overlaps.map((o) =>
          overlapPairKey(task.id, o.other_task_id),
        ),
      );
      const forceRun = overlapState.forceRun;
      setOverlapState(null);
      startTask.mutate({ taskId: task.id, forceRun });
    }
  };
  const onOverlapCancel = () => setOverlapState(null);

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

  // === Preview server ====================================================
  const previewSettings = workspaceSettingsQ.data?.preview_server;
  const previewStatus = previewStatusQ.data;
  const previewAvailable = !!task.worktree_path && task.worktree_status === "active";
  const previewDisabled = !previewAvailable;
  const previewRunningForThisTask =
    previewStatus?.task_id === task.id &&
    (previewStatus.state === "running" || previewStatus.state === "starting");
  const previewRunningForOtherTask =
    !!previewStatus?.task_id &&
    previewStatus.task_id !== task.id &&
    (previewStatus.state === "running" || previewStatus.state === "starting");
  const previewLabel = previewRunningForThisTask
    ? previewStatus?.state === "starting"
      ? "Preview starting"
      : "Preview running"
    : previewRunningForOtherTask
      ? "Preview busy"
      : "Preview";
  const previewTooltip = !task.worktree_path
    ? "Task has no worktree yet."
    : task.worktree_status !== "active"
      ? "Task worktree is unavailable."
      : !previewSettings?.enabled || !previewSettings.command?.trim()
        ? "Open setup guidance for the preview server."
        : previewRunningForThisTask
          ? "Preview server is running for this task."
          : previewRunningForOtherTask
          ? "Another task has the preview server."
          : "Start or reopen the frontend dev server.";

  const terminalDisabled = !previewAvailable;
  const terminalTooltip = !task.worktree_path
    ? "Task has no worktree yet."
    : task.worktree_status !== "active"
      ? "Task worktree is unavailable."
      : "Open a terminal in this task worktree.";

  const approveAction = {
    icon: <CheckCircle weight={primary === "approve" ? "fill" : "regular"} />,
    label: "Approve",
    isPrimary: primary === "approve",
    disabled: approveDisabled,
    tooltip: approveTooltip,
    onClick: () => approve.mutate(task.id),
  };
  const passBackAction = {
    icon: <ArrowUUpLeft />,
    label: "Pass back",
    isPrimary: primary === "pass_back",
    disabled: passBackDisabled,
    tooltip: passBackTooltip,
    onClick: () => setPassBackOpen(true),
  };
  const mergeAction = {
    icon: <GitMerge weight={primary === "merge" ? "fill" : "regular"} />,
    label: "Merge",
    isPrimary: primary === "merge",
    disabled: mergeDisabled,
    tooltip: mergeTooltip,
    onClick: () => setMergeOpen(true),
  };
  const primaryAction =
    primary === "approve"
      ? approveAction
      : primary === "pass_back"
        ? passBackAction
        : primary === "merge"
          ? mergeAction
          : null;
  const secondaryInlineActions = [approveAction, passBackAction, mergeAction].filter(
    (action) => !action.isPrimary && !action.disabled,
  );
  const overflowActions = [approveAction, passBackAction, mergeAction].filter(
    (action) => !action.isPrimary && action.disabled,
  );

  return (
    <TooltipProvider delay={200}>
      <div className="flex flex-wrap items-center gap-1">
        <ToolbarButton
          icon={runIcon}
          label={runLabel}
          // Don't lift the queued state into the primary slot — "Cancel
          // queue" is a recovery action, not the obvious next step.
          isPrimary={primary === "run" && !task.is_queued}
          disabled={runDisabled}
          tooltip={runTooltip}
          onClick={() => void tryStartTask(false)}
        />
        {primaryAction && <ToolbarButton {...primaryAction} />}
        {secondaryInlineActions.map((action) => (
          <ToolbarButton key={action.label} {...action} />
        ))}
        <ToolbarButton
          icon={<GitDiff />}
          label="Review diff"
          isPrimary={false}
          disabled={diffDisabled}
          tooltip={diffTooltip}
          onClick={onOpenDiff}
        />
        <ToolbarButton
          icon={<ArrowSquareOut />}
          label={previewLabel}
          isPrimary={false}
          disabled={previewDisabled}
          tooltip={previewTooltip}
          onClick={() => setPreviewOpen(true)}
        />
        <IconToolbarButton
          icon={<Terminal />}
          label="Open terminal"
          disabled={terminalDisabled}
          tooltip={terminalTooltip}
          onClick={onOpenTerminal}
        />

        <OverflowMenu
          task={task}
          tasksInPlan={tasksInPlanQ.data ?? []}
          phaseRunning={phaseRunning}
          implementerCompleted={implementerCompleted}
          worktreeActive={worktreeActive}
          overflowActions={overflowActions}
          rejectDisabled={rejectDisabled}
          rejectTooltip={rejectTooltip}
          onReject={() => reject.mutate(task.id)}
          onCancelPhase={(phaseRunId) => cancelPhaseRun.mutate(phaseRunId)}
          onRerunAuditor={() =>
            startTaskPhase.mutate({ taskId: task.id, phase: "auditor" })
          }
          onRunAnyway={() => void tryStartTask(true)}
          onCopyId={() => {
            void navigator.clipboard.writeText(task.id);
          }}
          onDeleteWorktree={() =>
            deleteWorktree.mutate({ taskId: task.id, force: false })
          }
          onDeleteTask={() => deleteTask.mutate(task.id)}
          deleteTaskDisabled={
            task.status === "merged" || task.status === "archived"
          }
        />
      </div>

      <FileOverlapDialog
        open={overlapState !== null}
        onOpenChange={(o) => {
          if (!o) setOverlapState(null);
        }}
        overlaps={overlapState?.overlaps ?? []}
        onProceed={onOverlapProceed}
        onCancel={onOverlapCancel}
      />

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
      <PreviewServerDialog
        task={task}
        settings={workspaceSettingsQ.data}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
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
  // Brief 4 / detail-restructure: lighter button register — outline for
  // secondary actions, solid for the single primary. Reduces visual weight
  // so the toolbar doesn't compete with the auditor verdict for attention.
  const button = (
    <Button
      size="sm"
      variant={isPrimary ? "default" : "outline"}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "gap-1",
        variant === "reject" &&
          !isPrimary &&
          !disabled &&
          "text-muted-foreground hover:text-destructive hover:border-destructive/40",
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

function IconToolbarButton({
  icon,
  label,
  disabled,
  tooltip,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled: boolean;
  tooltip: string;
  onClick: () => void;
}) {
  const button = (
    <Button
      size="icon-sm"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
    >
      {icon}
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
  tasksInPlan,
  phaseRunning,
  implementerCompleted,
  worktreeActive,
  overflowActions,
  rejectDisabled,
  rejectTooltip,
  onReject,
  onCancelPhase,
  onRerunAuditor,
  onRunAnyway,
  onCopyId,
  onDeleteWorktree,
  onDeleteTask,
  deleteTaskDisabled,
}: {
  task: Task;
  tasksInPlan: Task[];
  phaseRunning: PhaseRun | undefined;
  implementerCompleted: boolean;
  worktreeActive: boolean;
  overflowActions: Array<{
    icon: React.ReactNode;
    label: string;
    disabled: boolean;
    tooltip: string;
    onClick: () => void;
  }>;
  rejectDisabled: boolean;
  rejectTooltip: string;
  onReject: () => void;
  onCancelPhase: (phaseRunId: string) => void;
  onRerunAuditor: () => void;
  onRunAnyway: () => void;
  onCopyId: () => void;
  onDeleteWorktree: () => void;
  onDeleteTask: () => void;
  deleteTaskDisabled: boolean;
}) {
  // Brief 4 / M7: "Edit dependencies" lives in the overflow when the
  // dependencies section isn't rendered (no deps + not blocked); we still
  // want it available there even when the section *is* rendered, so users
  // have a single discoverable place that always works. Local open-state
  // for the popover so dropdown autoclose doesn't kill it.
  const [editDepsOpen, setEditDepsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <>
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={(props) => (
            <span {...props} className="inline-flex">
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="outline"
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
      <DropdownMenuContent align="start" className="min-w-[240px]">
        {overflowActions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            disabled={action.disabled}
            onClick={action.onClick}
            title={action.tooltip}
          >
            {action.icon}
            <span className="flex-1">{action.label}</span>
          </DropdownMenuItem>
        ))}
        {overflowActions.length > 0 && <DropdownMenuSeparator />}

        <DropdownMenuItem
          disabled={rejectDisabled}
          onClick={onReject}
          title={rejectTooltip}
          variant="destructive"
        >
          <XCircle />
          <span className="flex-1">Reject</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Phase actions */}
        <DropdownMenuItem
          disabled={!phaseRunning}
          onClick={() => phaseRunning && onCancelPhase(phaseRunning.id)}
        >
          <Stop />
          <span className="flex-1">Cancel running phase</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={
            !implementerCompleted ||
            !!phaseRunning ||
            task.status === "merged" ||
            task.status === "approved" ||
            task.status === "cancelled" ||
            task.status === "archived"
          }
          onClick={onRerunAuditor}
        >
          <Play />
          <span className="flex-1">Re-run auditor only</span>
        </DropdownMenuItem>
        {/* Brief 4 / M6: "Run anyway (ignore dependencies)" — escape hatch
            only relevant when the task is currently blocked. We surface it
            for queued tasks too, since a queued user might decide they
            want to break out of the queue. */}
        {(task.is_blocked || task.is_queued) && (
          <DropdownMenuItem
            disabled={
              !!phaseRunning ||
              task.status === "merged" ||
              task.status === "cancelled"
            }
            onClick={onRunAnyway}
            variant="destructive"
          >
            <Warning />
            <span className="flex-1">Run anyway (ignore dependencies)</span>
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        {/* Dependencies — always available so the user can add deps to a
            task that doesn't have any yet (the inline section is hidden in
            that case per the brief). */}
        <DropdownMenuItem
          disabled={
            task.status === "merged" || task.status === "archived"
          }
          onClick={() => setEditDepsOpen(true)}
        >
          <Pencil />
          <span className="flex-1">Edit dependencies</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Utility actions */}
        <DropdownMenuItem onClick={onCopyId}>
          <Copy />
          <span className="flex-1">Copy task ID</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={
            !worktreeActive ||
            !!phaseRunning ||
            task.worktree_init_status === "running"
          }
          variant="destructive"
          onClick={onDeleteWorktree}
        >
          <Trash />
          <span className="flex-1">Delete worktree</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={deleteTaskDisabled}
          variant="destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash />
          <span className="flex-1">Delete task</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <DependencyEditDialog
      task={task}
      candidates={tasksInPlan}
      open={editDepsOpen}
      onOpenChange={setEditDepsOpen}
    />
    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this task?</DialogTitle>
          <DialogDescription>
            {phaseRunning
              ? "The running phase will be cancelled and the worktree removed. The task will be archived and hidden from views; the audit trail is kept."
              : "The worktree will be removed and the task archived (hidden from views). The audit trail is kept."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setDeleteOpen(false);
              onDeleteTask();
            }}
          >
            Delete task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
