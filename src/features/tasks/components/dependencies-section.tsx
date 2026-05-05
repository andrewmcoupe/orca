import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Warning } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTasksInPlan, useUpdateTaskDependencies } from "../hooks";
import { TaskStatusBadge } from "../presentation";
import {
  parseDependencyError,
  type DependencyValidationError,
  type Task,
} from "../types";
import { cn } from "@/lib/utils";

/**
 * Brief 4 / M7: per-task dependency declarations. Lives in the task detail
 * view. Hidden by default when the task has no dependencies AND isn't
 * blocked — then the "Edit dependencies" affordance is reachable from the
 * overflow menu on the toolbar instead. When dependencies are non-empty
 * (or the task is blocked), the section renders prominently.
 */
export function DependenciesSection({
  workspaceId,
  task,
}: {
  workspaceId: string;
  task: Task;
}) {
  const tasksQ = useTasksInPlan(task.plan_id);
  const allTasks = tasksQ.data ?? [];
  const taskById = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of allTasks) m.set(t.id, t);
    return m;
  }, [allTasks]);

  const deps = task.depends_on
    .map((id) => taskById.get(id))
    .filter((t): t is Task => !!t);

  // The brief: "hidden when the task has no dependencies AND isn't blocked."
  // Hide the whole section in that case; the overflow menu still surfaces an
  // "Edit dependencies" entry for users who want to add some.
  const empty = task.depends_on.length === 0 && !task.is_blocked;
  if (empty) return null;

  const blockedCount = deps.filter((d) => d.status !== "merged").length;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-muted-foreground/70 text-[10px] font-medium uppercase tracking-[0.08em]">
          Dependencies
        </h2>
        {task.is_blocked && (
          <BlockedByBadge count={blockedCount || task.depends_on.length} />
        )}
      </div>
      <div className="bg-muted/20 border p-2 space-y-1">
        {deps.length === 0 ? (
          <p className="text-muted-foreground text-[11px] italic">
            Depends on tasks that no longer exist in this plan. Edit to clean up.
          </p>
        ) : (
          deps.map((d) => (
            <DependencyRow
              key={d.id}
              dep={d}
              workspaceId={workspaceId}
              planId={task.plan_id}
            />
          ))
        )}
        <div className="flex justify-end pt-1">
          <DependencyEditPopover task={task} candidates={allTasks} />
        </div>
      </div>
    </section>
  );
}

export function BlockedByBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium tabular-nums text-amber-900 dark:text-amber-200">
      <Warning weight="fill" className="size-2.5" />
      Blocked by {count}
    </span>
  );
}

function DependencyRow({
  dep,
  workspaceId,
  planId,
}: {
  dep: Task;
  workspaceId: string;
  planId: string;
}) {
  const merged = dep.status === "merged";
  return (
    <div className="flex items-center justify-between gap-2 px-1 py-0.5 text-xs">
      <Link
        to="/workspace/$workspaceId/plan/$planId/task/$taskId"
        params={{ workspaceId, planId, taskId: dep.id }}
        className={cn(
          "min-w-0 flex-1 truncate hover:underline",
          merged ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {dep.title}
      </Link>
      <TaskStatusBadge status={dep.status} />
    </div>
  );
}

/** "Edit dependencies" popover with its own trigger — used by the inline
 * Dependencies section. The dropdown-menu path uses
 * {@link DependencyEditDialog} with externally-controlled state instead. */
export function DependencyEditPopover({
  task,
  candidates,
}: {
  task: Task;
  candidates: Task[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button size="sm" variant="ghost" className="gap-1">
            {task.depends_on.length === 0 ? <Plus /> : <Pencil />}
            {task.depends_on.length === 0
              ? "Add dependencies"
              : "Edit dependencies"}
          </Button>
        }
      />
      <PopoverContent className="w-96" align="end">
        <DependencyEditor
          key={open ? "open" : "closed"}
          task={task}
          candidates={candidates}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Externally-controlled Dialog wrapper around the same editor body —
 * used by the toolbar's overflow menu where the dropdown's lifecycle
 * fights with a popover trigger. The Dialog detaches the editor from
 * the menu, so it can stay open after the menu auto-closes. */
export function DependencyEditDialog({
  task,
  candidates,
  open,
  onOpenChange,
}: {
  task: Task;
  candidates: Task[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit dependencies</DialogTitle>
          <DialogDescription>
            The pipeline won't start this task until every selected task has
            merged.
          </DialogDescription>
        </DialogHeader>
        <DependencyEditor
          key={open ? "open" : "closed"}
          task={task}
          candidates={candidates}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The actual editor body — list + filter + save/cancel. Re-mounted via
 * `key` whenever the parent opens it, so local state always starts fresh
 * from `task.depends_on`. */
function DependencyEditor({
  task,
  candidates,
  onClose,
}: {
  task: Task;
  candidates: Task[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(task.depends_on),
  );
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<DependencyValidationError | string | null>(
    null,
  );
  const update = useUpdateTaskDependencies();

  // Sync local selection when the task's deps change underneath us (e.g.
  // an event from the queue manager mutates is_blocked, triggering a
  // refetch). We don't want to clobber a user's in-progress edit, so
  // only resync when nothing is dirty.
  useEffect(() => {
    if (!update.isPending) {
      setSelected((current) => {
        const dirty =
          current.size !== task.depends_on.length ||
          [...current].some((id) => !task.depends_on.includes(id));
        return dirty ? current : new Set(task.depends_on);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.depends_on.join(",")]);

  const eligible = candidates
    .filter((t) => t.id !== task.id && t.plan_id === task.plan_id)
    .filter(
      (t) => !filter || t.title.toLowerCase().includes(filter.toLowerCase()),
    );

  const dirty =
    selected.size !== task.depends_on.length ||
    [...selected].some((id) => !task.depends_on.includes(id));

  const onSave = () => {
    setError(null);
    update.mutate(
      { taskId: task.id, dependsOn: [...selected] },
      {
        onSuccess: () => onClose(),
        onError: (err) => {
          const parsed = parseDependencyError(err);
          setError(parsed ?? String(err));
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter…"
        className="w-full border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-foreground/20"
      />
      <div className="scrollbar-styled max-h-72 overflow-y-auto border divide-y">
        {eligible.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground italic">
            {filter
              ? "No tasks match."
              : "No other tasks exist in this plan yet."}
          </p>
        ) : (
          eligible.map((t) => (
            <DependencyCheckbox
              key={t.id}
              task={t}
              checked={selected.has(t.id)}
              onToggle={() => {
                setSelected((s) => {
                  const next = new Set(s);
                  if (next.has(t.id)) next.delete(t.id);
                  else next.add(t.id);
                  return next;
                });
              }}
            />
          ))
        )}
      </div>
      {error && <DependencyErrorMessage error={error} />}
      <div className="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          disabled={update.isPending}
        >
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function DependencyCheckbox({
  task,
  checked,
  onToggle,
}: {
  task: Task;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/30 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="size-3 cursor-pointer accent-foreground"
      />
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <TaskStatusBadge status={task.status} />
    </label>
  );
}

function DependencyErrorMessage({
  error,
}: {
  error: DependencyValidationError | string;
}) {
  if (typeof error === "string") {
    return (
      <p className="border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
        {error}
      </p>
    );
  }
  let message: string;
  switch (error.kind) {
    case "Cycle":
      message = `This dependency would create a cycle: ${error.details.path.join(" → ")}. Remove one of these dependencies first.`;
      break;
    case "CrossPlan":
      message = `Dependencies must be in the same plan. ${error.details.offending_task_ids.length} selection${error.details.offending_task_ids.length === 1 ? "" : "s"} crosses plan boundaries.`;
      break;
    case "NotFound":
      message = `Some referenced tasks no longer exist: ${error.details.join(", ")}.`;
      break;
    case "SelfDependency":
      message = "A task can't depend on itself.";
      break;
    case "Duplicate":
      message = `Duplicate dependency selections: ${error.details.join(", ")}.`;
      break;
    case "Db":
      message = `Database error: ${error.details}`;
      break;
  }
  return (
    <p className="border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
      {message}
    </p>
  );
}
