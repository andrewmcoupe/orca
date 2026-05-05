import { Button } from "@/components/ui/button";
import { useDeleteWorktree } from "@/features/tasks/hooks";
import { usePhaseRuns } from "@/features/phase-runs/hooks";
import type { Task } from "@/features/tasks/types";

export function WorktreeSection({ task }: { task: Task }) {
  const remove = useDeleteWorktree();
  const phaseRunsQ = usePhaseRuns(task.workspace_id, task.id);
  const phaseRunning = phaseRunsQ.data?.some((r) => r.status === "running");
  const initRunning = task.worktree_init_status === "running";
  const taskInProgress = phaseRunning || initRunning;

  if (!task.worktree_status) {
    return (
      <p className="text-muted-foreground text-xs">
        No worktree yet — created on first run.
      </p>
    );
  }
  if (task.worktree_status === "removed") {
    return (
      <p className="text-muted-foreground text-xs">
        Worktree removed ({task.worktree_removal_reason ?? "unknown"}).
      </p>
    );
  }

  const onDelete = async () => {
    try {
      await remove.mutateAsync({ taskId: task.id, force: false });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("uncommitted changes")) {
        const ok = window.confirm(
          "This worktree has uncommitted changes. Delete anyway?",
        );
        if (ok) {
          await remove
            .mutateAsync({ taskId: task.id, force: true })
            .catch(() => {});
        }
      }
    }
  };

  const copyPath = () => {
    if (task.worktree_path) {
      navigator.clipboard.writeText(task.worktree_path);
    }
  };

  return (
    <div className="bg-muted/20 space-y-1 border p-3 text-xs">
      <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
        Worktree
      </div>
      <div>
        <button
          type="button"
          onClick={copyPath}
          title="Copy path"
          className="hover:bg-muted truncate font-mono text-[11px] underline-offset-2 hover:underline"
        >
          {task.worktree_path}
        </button>
      </div>
      <div className="text-muted-foreground">
        Branch: <code className="font-mono">{task.worktree_branch}</code>
      </div>
      {task.worktree_base_commit && (
        <div className="text-muted-foreground">
          Base: <code>{task.worktree_base_commit.slice(0, 8)}</code>
        </div>
      )}
      <div className="pt-1">
        <Button
          variant="outline"
          size="xs"
          onClick={onDelete}
          disabled={remove.isPending || taskInProgress}
          title={
            taskInProgress
              ? initRunning
                ? "Worktree is still initialising."
                : "A phase is running — cancel it before deleting the worktree."
              : undefined
          }
        >
          Delete worktree
        </Button>
        {remove.error &&
          !String(remove.error).includes("uncommitted changes") && (
            <span className="text-destructive ml-2 text-[11px]">
              {String(remove.error)}
            </span>
          )}
      </div>
    </div>
  );
}
