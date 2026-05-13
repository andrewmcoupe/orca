import { useEffect, useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { ContentColumn } from "@/components/layout/content-column";
import {
  DetailSidebar,
  type DetailSidebarSection,
} from "@/components/layout/detail-sidebar";
import { Disclosure } from "@/components/layout/disclosure";
import { HeaderSlot } from "@/components/layout/header-slot";
import { Markdown } from "@/components/markdown";
import { workspaceLayoutRoute } from "./layout";
import {
  useCancelTaskCatchUp,
  useRequestCollisionResolution,
  useTask,
  useTaskCollisions,
} from "@/features/tasks/hooks";
import {
  TaskReviewStateBadge,
  TaskStatusBadge,
} from "@/features/tasks/presentation";
import { WorktreeInitSection } from "@/features/tasks/components/worktree-init-section";
import { AuditorVerdictSection } from "@/features/tasks/components/auditor-verdict-section";
import { TaskActionToolbar } from "@/features/tasks/components/task-action-toolbar";
import { BlockedByBadge } from "@/features/tasks/components/dependencies-section";
import { TaskPipelineRail } from "@/features/tasks/components/task-pipeline-rail";
import {
  ArtifactsSidebarBody,
  DependenciesSidebarBody,
  DependenciesSidebarEditAction,
  hasAnyArtifacts,
} from "@/features/tasks/components/task-sidebar-sections";
import { TerminalDock } from "@/features/terminal/components/terminal-dock";
import { useTerminalStore } from "@/features/terminal/terminal-store";
import { useLatestMergeAttempt } from "@/features/tasks/merge-hooks";
import { useRecentEvents } from "@/features/events/hooks";
import { useActiveWorkspace } from "@/features/workspaces/hooks";
import { usePhaseRuns } from "@/features/phase-runs/hooks";
import type { PhaseRun } from "@/features/phase-runs/types";
import { TaskEventList } from "@/features/events/components/task-event-list";
import { PhaseRunsTrail } from "@/features/phase-runs/components/phase-runs-trail";
import { diffModalController } from "@/features/diff/modal-controller";
import { ProposalReviewSurface } from "@/features/diff/proposal-review-surface";
import { formatRelativeTime } from "@/lib/format";
import type { Task } from "@/features/tasks/types";
import { deriveTaskReviewState } from "@/features/tasks/task-domain";
import type {
  CollisionFileView,
  CollisionHunkView,
  CollisionSide,
} from "@/features/tasks/api";
import { Button } from "@/components/ui/button";

function TaskDetailPage() {
  const { workspaceId, taskId } = useParams({
    from: taskDetailRoute.id,
  });
  const taskQ = useTask(taskId);

  if (taskQ.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading task…</div>
    );
  }
  if (!taskQ.data) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Task not found.</div>
    );
  }
  return <TaskDetailView task={taskQ.data} workspaceId={workspaceId} />;
}

/**
 * Task detail layout: scrolling main column on the left, fixed-width
 * reference sidebar on the right, and the proposal available inline.
 *
 * Reading order top-to-bottom: action toolbar → title + status → auditor
 * verdict (the thing the user came to read) → spec / audit trail as
 * collapsible disclosures with state-aware default-expansion. Pipeline,
 * dependencies and artifact links live in the right sidebar so they're
 * always at-a-glance regardless of how long the verdict prose is.
 */
function TaskDetailView({
  task,
  workspaceId,
}: {
  task: Task;
  workspaceId: string;
}) {
  const phaseRuns = usePhaseRuns(workspaceId, task.id);
  const runs = phaseRuns.data ?? [];
  const activeRun = runs.find((r) => r.status === "running");
  const latestRun = runs[0] ?? null;
  const reviewState = deriveTaskReviewState({
    task,
    activeRun,
    latestRun,
  });
  const {
    closeTerminal: closeStoredTerminal,
    group,
    hydrateTask,
    openTerminal: openStoredTerminal,
    renameTerminal,
    selectTerminal,
    setHeight: setTerminalHeight,
    toggleCollapsed,
  } = useTerminalStore();
  const terminalGroup = group(workspaceId, task.id);

  const [reviewOpen, setReviewOpen] = useState(false);

  const openProposal = (_concernIdx?: number) => {
    setReviewOpen(true);
  };

  // Bridge: anything calling `diffModalController.open` (e.g. verdict concern
  // rows) opens the inline proposal here, scoped to the right task.
  useEffect(() => {
    return diffModalController.subscribe((req) => {
      if (req.taskId !== task.id) return;
      openProposal(req.concernIndex);
    });
  }, [task.id]);

  useEffect(() => {
    void hydrateTask(workspaceId, task.id);
  }, [hydrateTask, task.id, workspaceId]);

  const openTerminal = () => {
    void openStoredTerminal(workspaceId, task.id);
  };

  const closeTerminal = (tabId: string) => {
    void closeStoredTerminal(workspaceId, task.id, tabId);
  };

  const sidebarSections: DetailSidebarSection[] = [
    {
      key: "pipeline",
      title: "Pipeline",
      children: (
        <TaskPipelineRail
          workspaceId={workspaceId}
          taskId={task.id}
          phaseConfig={task.current_phase_config}
          phaseRuns={runs}
        />
      ),
    },
    {
      key: "dependencies",
      title: "Dependencies",
      action: <DependenciesSidebarEditAction task={task} />,
      children: (
        <DependenciesSidebarBody workspaceId={workspaceId} task={task} />
      ),
    },
    {
      key: "artifacts",
      title: "Artifacts",
      hidden: !hasAnyArtifacts(task, runs),
      children: (
        <ArtifactsSidebarBody
          task={task}
          phaseRuns={runs}
          onOpenDiff={() => openProposal()}
        />
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {reviewOpen && (
        <ProposalReviewSurface
          task={task}
          workspaceId={workspaceId}
          onExit={() => setReviewOpen(false)}
        />
      )}
      <HeaderSlot>
        <TaskActionToolbar
          task={task}
          workspaceId={workspaceId}
          onOpenDiff={() => openProposal()}
          onOpenTerminal={openTerminal}
        />
      </HeaderSlot>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <div className="scrollbar-styled min-h-0 min-w-0 flex-1 overflow-auto">
            <div className="space-y-6 px-6 pt-4 pb-8">
              <ContentColumn className="mx-auto min-w-0 space-y-3">
                <header className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="truncate text-[22px] font-medium tracking-tight font-body">
                      {task.title}
                    </h1>
                    {reviewState === "needs_catch_up" ||
                    reviewState === "has_collisions" ? (
                      <TaskReviewStateBadge state={reviewState} />
                    ) : (
                      <TaskStatusBadge status={task.status} />
                    )}
                    {task.is_blocked && (
                      <BlockedByBadge count={task.depends_on.length} />
                    )}
                    {task.is_queued && (
                      <span className="inline-flex items-center gap-1 rounded-sm border border-blue-500/30 bg-blue-500/10 px-1.5 py-px text-[10px] font-medium text-blue-900 dark:text-blue-200">
                        Queued
                      </span>
                    )}
                  </div>
                  <TaskHeaderMeta task={task} />
                </header>
                {task.cancel_reason && (
                  <p className="bg-zinc-500/10 text-muted-foreground border px-3 py-2 text-[11px]">
                    <span className="font-medium">Cancelled:</span>{" "}
                    {task.cancel_reason}
                  </p>
                )}
                <MergeAttemptInline taskId={task.id} task={task} />
                <CatchUpBanner task={task} />
              </ContentColumn>

              <ContentColumn className="mx-auto">
                {task.catch_up_state === "colliding" ? (
                  <CollisionsView task={task} onOpenTerminal={openTerminal} />
                ) : (
                  <AuditorVerdictPromoted task={task} activeRun={activeRun} />
                )}
              </ContentColumn>

              <ContentColumn className="mx-auto">
                <OldParentProposalNote task={task} />
              </ContentColumn>

              <ContentColumn className="mx-auto">
                <WorktreeInitSection task={task} />
              </ContentColumn>

              <ContentColumn className="mx-auto space-y-0">
                <SpecAndAuditDisclosures
                  task={task}
                  workspaceId={workspaceId}
                />
              </ContentColumn>
            </div>
          </div>
          <TerminalDock
            tabs={terminalGroup.tabs}
            activeTabId={terminalGroup.activeTabId}
            collapsed={terminalGroup.collapsed}
            heightPx={terminalGroup.heightPx}
            onAddTerminal={openTerminal}
            onSelectTab={(tabId) => {
              selectTerminal(workspaceId, task.id, tabId);
            }}
            onCloseTab={closeTerminal}
            onRenameTab={(tabId, label) => {
              renameTerminal(tabId, label);
            }}
            onToggleCollapsed={() => toggleCollapsed(workspaceId, task.id)}
            onResize={(heightPx) =>
              setTerminalHeight(workspaceId, task.id, heightPx)
            }
          />
        </div>
        <DetailSidebar sections={sidebarSections} />
      </div>
    </div>
  );
}

/**
 * Auditor verdict, promoted to immediately follow the title row. The
 * underlying section component already returns null when there is no
 * verdict yet, so this is just a thin wrapper that ensures it gets a
 * visible heading-equivalent in the new layout (it already renders one
 * internally — kept here as a hook for future tweaks).
 */
function AuditorVerdictPromoted({
  task,
  activeRun,
}: {
  task: Task;
  activeRun?: PhaseRun | null;
}) {
  if (activeRun || task.status === "running") {
    const phase = activeRun?.phase ?? "task";
    const label =
      phase === "auditor"
        ? "Auditor running"
        : phase === "implementer"
          ? "Implementation running"
          : "Task running";
    const detail =
      phase === "auditor"
        ? "A fresh auditor verdict is being produced for this proposal."
        : "The previous auditor verdict is in the audit trail and no longer applies to this rerun.";
    return (
      <section className="border-border bg-muted/20 space-y-1 border px-3 py-2">
        <h2 className="text-sm font-medium">{label}</h2>
        <p className="text-muted-foreground text-xs">{detail}</p>
      </section>
    );
  }
  return <AuditorVerdictSection taskId={task.id} />;
}

function CatchUpBanner({ task }: { task: Task }) {
  if (task.catch_up_state !== "clean" && task.catch_up_state !== "dirty") {
    return null;
  }
  return (
    <div className="border-warning/40 bg-warning/10 text-warning space-y-1 border px-3 py-2 text-xs">
      <p className="font-medium">
        Parent has moved. Catch up to re-evaluate this proposal against current
        state.
      </p>
      <p className="text-muted-foreground text-[11px]">
        New parent revision{" "}
        {task.catch_up_target_sha ? (
          <code className="font-mono">
            {task.catch_up_target_sha.slice(0, 8)}
          </code>
        ) : (
          "detected"
        )}
        . The previous auditor verdict does not carry over.
      </p>
    </div>
  );
}

function OldParentProposalNote({ task }: { task: Task }) {
  if (task.catch_up_state !== "clean" && task.catch_up_state !== "dirty") {
    return null;
  }
  return (
    <p className="text-muted-foreground border-border/70 bg-muted/20 mt-2 border px-3 py-2 text-[11px]">
      These changes are shown against the old parent. Catch up to see them
      against current state.
    </p>
  );
}

function CollisionsView({
  task,
  onOpenTerminal,
}: {
  task: Task;
  onOpenTerminal: () => void;
}) {
  const requestResolution = useRequestCollisionResolution();
  const cancelCatchUp = useCancelTaskCatchUp();
  const collisionsQ = useTaskCollisions(task.id);
  const collisions = collisionsQ.data ?? [];
  const fallbackConflicts = task.catch_up_conflicts;
  return (
    <section className="border-destructive/30 bg-background border rounded-sm">
      <div className="border-destructive/30 flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <h2 className="text-sm font-medium">Collisions</h2>
          <p className="text-muted-foreground text-[11px]">
            Catch-up needs help before this proposal can be reviewed again.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            className="bg-primary text-primary-foreground hover:bg-primary/90 h-8 px-3 text-xs"
            onClick={() => requestResolution.mutate(task.id)}
            disabled={requestResolution.isPending}
          >
            {requestResolution.isPending
              ? "Requesting resolution"
              : "Ask implementer to resolve"}
          </Button>
          <Button
            variant={"secondary"}
            type="button"
            className="border-border hover:bg-muted h-8 border px-3 text-xs"
            onClick={onOpenTerminal}
          >
            Resolve in terminal
          </Button>
          <Button
            variant={"link"}
            type="button"
            className="text-muted-foreground hover:bg-muted h-8 border border-transparent px-3 text-xs"
            onClick={() => cancelCatchUp.mutate(task.id)}
            disabled={cancelCatchUp.isPending}
          >
            Cancel catch-up
          </Button>
        </div>
      </div>
      <div className="divide-border divide-y">
        {collisionsQ.isLoading ? (
          <p className="text-muted-foreground p-3 text-xs">
            Loading collision details…
          </p>
        ) : collisions.length > 0 ? (
          collisions.map((collision) => (
            <CollisionFile key={collision.path} collision={collision} />
          ))
        ) : fallbackConflicts.length > 0 ? (
          fallbackConflicts.map((path) => (
            <div key={path} className="p-3">
              <code className="font-mono text-xs">{path}</code>
              <p className="text-muted-foreground mt-2 text-xs">
                Three-way contents are unavailable for this collision.
              </p>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground p-3 text-xs">
            Collision details are unavailable. Resolve in terminal or retry
            catch-up.
          </p>
        )}
      </div>
    </section>
  );
}

function CollisionFile({ collision }: { collision: CollisionFileView }) {
  const hunks =
    collision.collisions.length > 0
      ? collision.collisions
      : [
          {
            index: 1,
            current_parent: collision.current_parent,
            this_proposal: collision.this_proposal,
            common_ancestor: collision.common_ancestor,
          },
        ];
  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <code className="font-mono text-xs">{collision.path}</code>
        <span className="text-muted-foreground text-[10px]">
          {collision.collision_count} collision
          {collision.collision_count === 1 ? "" : "s"}
        </span>
      </div>
      <div className="space-y-3">
        {hunks.map((hunk) => (
          <CollisionHunk key={hunk.index} hunk={hunk} />
        ))}
      </div>
    </div>
  );
}

function CollisionHunk({ hunk }: { hunk: CollisionHunkView }) {
  return (
    <div className="border-border/80 border">
      <div className="border-border bg-muted/20 border-b px-2 py-1.5">
        <p className="text-muted-foreground text-[10px] font-medium">
          Collision {hunk.index}
        </p>
      </div>
      <div className="grid gap-2 xl:grid-cols-3">
        <CollisionSidePane side={hunk.current_parent} />
        <CollisionSidePane side={hunk.this_proposal} />
        <CollisionSidePane side={hunk.common_ancestor} muted />
      </div>
    </div>
  );
}

function CollisionSidePane({
  side,
  muted = false,
}: {
  side: CollisionSide;
  muted?: boolean;
}) {
  return (
    <div className="bg-muted/20 min-h-36 min-w-0 border">
      <div className="border-border flex items-center justify-between gap-2 border-b px-2 py-1.5">
        <p className="text-muted-foreground text-[10px] font-medium">
          {side.label}
        </p>
        {side.revision && (
          <code className="text-muted-foreground font-mono text-[10px]">
            {side.revision.slice(0, 8)}
          </code>
        )}
      </div>
      {side.line_start !== null && side.line_end !== null ? (
        <div className="border-border bg-background/60 flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1">
          <code className="text-muted-foreground font-mono text-[10px]">
            lines {side.line_start}
            {side.line_end === side.line_start ? "" : `-${side.line_end}`}
          </code>
          {side.attribution ? (
            <span className="border-border bg-muted/40 text-muted-foreground border px-1.5 py-0.5 text-[10px]">
              From: {side.attribution.title}
            </span>
          ) : null}
        </div>
      ) : null}
      <pre
        className={[
          "scrollbar-styled max-h-72 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] leading-relaxed",
          muted ? "text-muted-foreground" : "text-foreground",
        ].join(" ")}
      >
        {side.content}
      </pre>
    </div>
  );
}

/**
 * Spec and audit-trail disclosures. The brief specifies state-aware default
 * expansion:
 *   not_started     → spec expanded, audit trail collapsed
 *   in_progress     → spec collapsed, audit trail expanded
 *   awaiting_review → both collapsed (verdict is what matters)
 *   merged/cancelled → both collapsed
 *
 * "running" is the in-progress equivalent in this codebase's TaskStatus enum
 * (no separate `in_progress`). "draft" maps to not_started.
 */
function SpecAndAuditDisclosures({
  task,
  workspaceId,
}: {
  task: Task;
  workspaceId: string;
}) {
  const active = useActiveWorkspace();
  const events = useRecentEvents(active.data?.id ?? null);
  const phaseRuns = usePhaseRuns(workspaceId, task.id);
  // Mirrors TaskEventList's filter — same union (task events + phase-run
  // events) so the disclosure summary matches what the user sees inside.
  const phaseRunIds = new Set((phaseRuns.data ?? []).map((r) => r.id));
  const eventCount = (events.data ?? []).filter(
    (e) =>
      (e.aggregate_type === "task" && e.aggregate_id === task.id) ||
      (e.aggregate_type === "phase_run" && phaseRunIds.has(e.aggregate_id)),
  ).length;

  const status = task.status;

  const specDefaultOpen = status === "draft";
  const auditTrailDefaultOpen = status === "running";

  return (
    <div className="border-border/60 border-t">
      {task.spec_markdown.trim() ? (
        <Disclosure
          title="Spec"
          summary={specDefaultOpen ? undefined : "view acceptance criteria"}
          defaultOpen={specDefaultOpen}
        >
          <div className="bg-muted/20 rounded-sm border p-3">
            <Markdown className="text-xs">{task.spec_markdown}</Markdown>
          </div>
        </Disclosure>
      ) : null}
      <Disclosure
        title="Audit trail"
        summary={
          eventCount > 0
            ? `${eventCount} event${eventCount === 1 ? "" : "s"}`
            : "no events yet"
        }
        defaultOpen={auditTrailDefaultOpen}
      >
        <div className="space-y-2.5">
          <TaskEventList workspaceId={workspaceId} taskId={task.id} />
          {phaseRuns.isLoading ? (
            <p className="text-muted-foreground text-[11px]">Loading…</p>
          ) : (
            <PhaseRunsTrail phaseRuns={phaseRuns.data ?? []} />
          )}
        </div>
      </Disclosure>
    </div>
  );
}

/**
 * Best-effort count of "acceptance criteria" from the spec markdown.
 * Looks for a `## Acceptance criteria` (or similar) heading and counts
 * the immediate list items beneath it. Falls back to total list-item
 * count when the heading isn't present, since some specs lay out
 * criteria as a top-level checklist. The displayed count is summary
 * meta and doesn't need to be exact — the brief calls it out as
 * "{N} acceptance criteria" purely so the user can tell at a glance
 * whether the spec is small or substantial.
 */
function TaskHeaderMeta({ task }: { task: Task }) {
  if (task.status === "merged" && task.merged_commit_sha) {
    return (
      <p className="text-muted-foreground text-[12px] tabular-nums">
        Landed into{" "}
        <code className="font-mono">{task.merge_target_branch ?? "main"}</code>{" "}
        as <CopyableSha sha={task.merged_commit_sha} />
        {task.merged_at != null && <> · {formatRelativeTime(task.merged_at)}</>}
        {task.worktree_status === "removed" && <> · task files removed</>}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-[12px] tabular-nums">
      Updated {formatRelativeTime(task.updated_at)}
    </p>
  );
}

function CopyableSha({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    await navigator.clipboard.writeText(sha);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy revision SHA"
      className="hover:text-foreground font-mono underline-offset-2 hover:underline"
    >
      <code>{sha.slice(0, 8)}</code>
      {copied && (
        <span className="text-muted-foreground ml-1 text-[10px]">copied</span>
      )}
    </button>
  );
}

function MergeAttemptInline({ taskId, task }: { taskId: string; task: Task }) {
  const attempt = useLatestMergeAttempt(taskId);
  if (task.status === "merged") return null;
  if (!attempt.data) return null;
  if (attempt.data.attempted_at < task.updated_at) return null;

  const a = attempt.data;
  const truncated = a.conflicts.slice(0, 3).join(", ");
  const more =
    a.conflicts.length > 3 ? `, +${a.conflicts.length - 3} more` : "";
  return (
    <p className="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 border px-3 py-2 text-xs">
      Last land attempt has collisions {formatRelativeTime(a.attempted_at)}.{" "}
      {a.conflicts.length} file
      {a.conflicts.length === 1 ? "" : "s"}:{" "}
      <code className="bg-amber-500/15 rounded-sm px-1 py-0.5 font-mono text-[0.9em]">
        {truncated}
        {more}
      </code>
    </p>
  );
}

export const taskDetailRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plan/$planId/task/$taskId",
  component: TaskDetailPage,
});
