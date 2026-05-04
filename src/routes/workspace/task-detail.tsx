import { useEffect, useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { ContentColumn } from "@/components/layout/content-column";
import { Markdown } from "@/components/markdown";
import { workspaceLayoutRoute } from "./layout";
import { useTask } from "@/features/tasks/hooks";
import { TaskStatusBadge } from "@/features/tasks/presentation";
import { WorktreeSection } from "@/features/tasks/components/worktree-section";
import { WorktreeInitSection } from "@/features/tasks/components/worktree-init-section";
import { AuditorVerdictSection } from "@/features/tasks/components/auditor-verdict-section";
import { TaskActionToolbar } from "@/features/tasks/components/task-action-toolbar";
import {
  BlockedByBadge,
  DependenciesSection,
} from "@/features/tasks/components/dependencies-section";
import { useLatestMergeAttempt } from "@/features/tasks/merge-hooks";
import { usePhaseRuns } from "@/features/phase-runs/hooks";
import { PipelineCards } from "@/features/phase-runs/components/pipeline-cards";
import { PhaseRunsTrail } from "@/features/phase-runs/components/phase-runs-trail";
import { TaskEventList } from "@/features/events/components/task-event-list";
import { DiffPanel } from "@/features/diff/components/diff-panel";
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

function TaskDetailView({
  task,
  workspaceId,
}: {
  task: Task;
  workspaceId: string;
}) {
  const phaseRuns = usePhaseRuns(workspaceId, task.id);
  const runs = phaseRuns.data ?? [];

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

  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1 space-y-7 px-5 py-4">
        <header className="space-y-3">
          <ContentColumn>
            <TaskActionToolbar
              task={task}
              workspaceId={workspaceId}
              onOpenDiff={() => openDiffModal()}
            />
          </ContentColumn>
          <ContentColumn className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[20px] font-medium font-body">
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
          </ContentColumn>
          {task.cancel_reason && (
            <ContentColumn>
              <p className="bg-zinc-500/10 text-muted-foreground border px-3 py-2 text-[11px]">
                <span className="font-medium">Cancelled:</span>{" "}
                {task.cancel_reason}
              </p>
            </ContentColumn>
          )}
          <MergeAttemptInline taskId={task.id} task={task} />
        </header>

        {task.spec_markdown.trim() ? (
          <section className="space-y-2">
            <SectionLabel>Spec</SectionLabel>
            <ContentColumn className="bg-muted/20 border p-1">
              <Markdown className="text-xs">{task.spec_markdown}</Markdown>
            </ContentColumn>
          </section>
        ) : null}

        <ContentColumn>
          <DependenciesSection workspaceId={workspaceId} task={task} />
        </ContentColumn>

        <AuditorVerdictSection taskId={task.id} />

        <WorktreeInitSection task={task} />

        <section className="space-y-2.5">
          <SectionLabel>Pipeline</SectionLabel>
          <PipelineCards
            workspaceId={workspaceId}
            taskId={task.id}
            phaseConfig={task.current_phase_config}
            phaseRuns={runs}
          />
        </section>

        <section className="space-y-2.5">
          <SectionLabel>Audit trail</SectionLabel>
          <ContentColumn className="space-y-2.5">
            <TaskEventList workspaceId={workspaceId} taskId={task.id} />
            {phaseRuns.isLoading ? (
              <p className="text-muted-foreground text-[11px]">Loading…</p>
            ) : (
              <PhaseRunsTrail phaseRuns={runs} />
            )}
          </ContentColumn>
        </section>

        <section className="space-y-2.5">
          <SectionLabel>Worktree</SectionLabel>
          <WorktreeSection task={task} />
        </section>
      </div>
      <DiffPanel
        workspaceId={workspaceId}
        taskId={task.id}
        onOpenModal={() => {
          setModalConcernIdx(undefined);
          setModalOpen(true);
        }}
      />
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-muted-foreground/70 text-[10px] font-medium uppercase tracking-[0.08em]">
      {children}
    </h2>
  );
}

function TaskHeaderMeta({ task }: { task: Task }) {
  if (task.status === "merged" && task.merged_commit_sha) {
    // Mixed register: prose ("Merged into … as … · 13h ago") in sans, the
    // branch name and SHA in mono since they're code.
    return (
      <p className="text-muted-foreground mt-1 text-[11px] tabular-nums">
        Merged into{" "}
        <code className="font-mono">
          {task.merge_target_branch ?? "main"}
        </code>{" "}
        as <CopyableSha sha={task.merged_commit_sha} />
        {task.merged_at != null && <> · {formatRelativeTime(task.merged_at)}</>}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-[11px] tabular-nums">
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

/**
 * Surface the most recent failed merge attempt (if any) inline in the header so the
 * user remembers there's a conflict blocking the merge. We hide it once the task is
 * actually merged — the merge succeeded, the past attempt is no longer actionable.
 */
function MergeAttemptInline({ taskId, task }: { taskId: string; task: Task }) {
  const attempt = useLatestMergeAttempt(taskId);
  if (task.status === "merged") return null;
  if (!attempt.data) return null;
  // Suppress if the attempt is older than the most recent task update — heuristic
  // for "the user has done something since" (resolved, restarted pipeline, etc).
  if (attempt.data.attempted_at < task.updated_at) return null;

  const a = attempt.data;
  const truncated = a.conflicts.slice(0, 3).join(", ");
  const more =
    a.conflicts.length > 3 ? `, +${a.conflicts.length - 3} more` : "";
  return (
    <ContentColumn>
      <p className="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 border px-3 py-2 text-xs">
        Last merge attempt blocked by conflicts{" "}
        {formatRelativeTime(a.attempted_at)}. {a.conflicts.length} file
        {a.conflicts.length === 1 ? "" : "s"}:{" "}
        <code className="bg-amber-500/15 rounded-sm px-1 py-0.5 font-mono text-[0.9em]">
          {truncated}
          {more}
        </code>
      </p>
    </ContentColumn>
  );
}

export const taskDetailRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/plan/$planId/task/$taskId",
  component: TaskDetailPage,
});
