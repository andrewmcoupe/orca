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
import { useTask } from "@/features/tasks/hooks";
import { TaskStatusBadge } from "@/features/tasks/presentation";
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
import { TaskEventList } from "@/features/events/components/task-event-list";
import { PhaseRunsTrail } from "@/features/phase-runs/components/phase-runs-trail";
import { DiffModal } from "@/features/diff/components/diff-modal";
import { diffModalController } from "@/features/diff/modal-controller";
import { formatRelativeTime } from "@/lib/format";
import type { Task } from "@/features/tasks/types";

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
 * reference sidebar on the right, and the review diff available as a modal.
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
  const {
    closeTerminal: closeStoredTerminal,
    group,
    hydrateTask,
    openTerminal: openStoredTerminal,
    renameTerminal,
    selectTerminal,
    toggleCollapsed,
  } = useTerminalStore();
  const terminalGroup = group(workspaceId, task.id);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalConcernIdx, setModalConcernIdx] = useState<number | undefined>(
    undefined,
  );

  const openDiffModal = (concernIdx?: number) => {
    setModalConcernIdx(concernIdx);
    setModalOpen(true);
  };

  // Bridge: anything calling `diffModalController.open` (e.g. verdict concern
  // rows) opens the modal here, scoped to the right task.
  useEffect(() => {
    return diffModalController.subscribe((req) => {
      if (req.taskId !== task.id) return;
      setModalConcernIdx(req.concernIndex);
      setModalOpen(true);
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
          onOpenDiff={() => openDiffModal()}
        />
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HeaderSlot>
        <TaskActionToolbar
          task={task}
          workspaceId={workspaceId}
          onOpenDiff={() => openDiffModal()}
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
                    <TaskStatusBadge status={task.status} />
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
              </ContentColumn>

              <ContentColumn className="mx-auto">
                <AuditorVerdictPromoted taskId={task.id} />
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
            onAddTerminal={openTerminal}
            onSelectTab={(tabId) => {
              selectTerminal(workspaceId, task.id, tabId);
            }}
            onCloseTab={closeTerminal}
            onRenameTab={(tabId, label) => {
              renameTerminal(tabId, label);
            }}
            onToggleCollapsed={() => toggleCollapsed(workspaceId, task.id)}
          />
        </div>
        <DetailSidebar sections={sidebarSections} />
      </div>

      <DiffModal
        workspaceId={workspaceId}
        taskId={task.id}
        open={modalOpen}
        onOpenChange={setModalOpen}
        initialConcernIndex={modalConcernIdx}
      />
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
function AuditorVerdictPromoted({ taskId }: { taskId: string }) {
  return <AuditorVerdictSection taskId={taskId} />;
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
        Merged into{" "}
        <code className="font-mono">{task.merge_target_branch ?? "main"}</code>{" "}
        as <CopyableSha sha={task.merged_commit_sha} />
        {task.merged_at != null && <> · {formatRelativeTime(task.merged_at)}</>}
        {task.worktree_status === "removed" && <> · worktree removed</>}
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
      title="Copy commit SHA"
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
      Last merge attempt blocked by conflicts{" "}
      {formatRelativeTime(a.attempted_at)}. {a.conflicts.length} file
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
