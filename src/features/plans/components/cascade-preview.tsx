import type { UseQueryResult } from "@tanstack/react-query";
import type { PlanCascadePreview } from "@/features/plans/api";

export function CascadePreview({
  previewQ,
  actionVerb,
  emptyHint,
}: {
  previewQ: UseQueryResult<PlanCascadePreview[]>;
  actionVerb: "cancelled" | "archived";
  emptyHint: string;
}) {
  if (previewQ.isLoading) {
    return (
      <p className="text-muted-foreground text-xs">Checking active tasks…</p>
    );
  }
  const tasks = previewQ.data ?? [];
  if (tasks.length === 0) {
    return <p className="text-muted-foreground text-xs">{emptyHint}</p>;
  }
  const runningCount = tasks.filter((t) => t.has_running_phase_run).length;

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {tasks.length} task{tasks.length === 1 ? "" : "s"} will be{" "}
          {actionVerb}
          {runningCount > 0 && (
            <>
              {" "}— {runningCount} currently running phase run
              {runningCount === 1 ? "" : "s"} will be cancelled.
            </>
          )}
        </p>
      </div>
      <ul className="scrollbar-styled bg-muted/30 max-h-44 space-y-1 overflow-auto rounded-md border p-2 text-xs">
        {tasks.map((t) => (
          <li key={t.task_id} className="flex min-w-0 items-center gap-2">
            <span
              className={
                t.has_running_phase_run
                  ? "size-1.5 shrink-0 rounded-full bg-success"
                  : "size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              }
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
              {t.status}
            </span>
          </li>
        ))}
      </ul>
      {tasks.some((t) => t.worktree_path) && (
        <p className="bg-warning/10 text-foreground rounded-md border border-warning/40 p-2 text-xs">
          Worktrees are <strong>not</strong> deleted automatically. Remove
          them manually with{" "}
          <code className="font-mono">git worktree remove &lt;path&gt;</code>{" "}
          once you've saved any uncommitted work.
        </p>
      )}
    </div>
  );
}
