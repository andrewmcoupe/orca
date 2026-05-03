import { useState } from "react";
import { CaretDown, CaretRight, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  useRetryWorktreeInit,
  useSkipWorktreeInit,
} from "@/features/tasks/hooks";
import type { Task } from "@/features/tasks/types";

/**
 * Renders the worktree-init step that runs between worktree creation and the
 * first phase. The section is intentionally quiet on success (one collapsed
 * line, easily ignored) and loud on failure (expanded by default, with retry
 * and skip affordances). Nothing renders when init has never run — no need to
 * tell the user about a step that hasn't happened yet.
 */
export function WorktreeInitSection({ task }: { task: Task }) {
  const status = task.worktree_init_status;
  // No init has run for this worktree yet — keep the UI quiet.
  if (!status) return null;
  if (status === "initialized") {
    return <InitializedRow task={task} />;
  }
  if (status === "failed") {
    return <FailedRow task={task} />;
  }
  return null;
}

function InitializedRow({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const cmd = task.worktree_init_command ?? "";
  const dur = task.worktree_init_duration_ms;
  const skipped = task.worktree_init_detection_kind === "user_skipped";

  return (
    <div className="bg-muted/20 border text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="hover:bg-muted/30 flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <CaretDown className="size-3 shrink-0" />
        ) : (
          <CaretRight className="size-3 shrink-0" />
        )}
        <CheckCircle className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="text-muted-foreground">Initialized</span>
        <span className="text-muted-foreground">·</span>
        <code className="truncate font-mono">{cmd}</code>
        {!skipped && dur != null && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground tabular-nums">
              {formatDuration(dur)}
            </span>
          </>
        )}
      </button>
      {open && task.worktree_init_output && (
        <pre className="bg-background/50 max-h-64 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-tight whitespace-pre-wrap">
          {task.worktree_init_output}
        </pre>
      )}
    </div>
  );
}

function FailedRow({ task }: { task: Task }) {
  const retry = useRetryWorktreeInit();
  const skip = useSkipWorktreeInit();
  const cmd = task.worktree_init_command ?? "";
  const exit = task.worktree_init_exit_code;
  const error = retry.error ?? skip.error;

  return (
    <div className="border-destructive/40 bg-destructive/10 space-y-2 border p-3 text-xs">
      <div className="text-destructive flex items-center gap-2 font-medium">
        <WarningCircle className="size-4 shrink-0" />
        <span>
          Initialization failed: <code className="font-mono">{cmd}</code>
          {exit != null && <> exited {exit}.</>}
        </span>
      </div>
      {task.worktree_init_output && (
        <pre className="bg-background/60 max-h-64 overflow-auto border px-3 py-2 font-mono text-[11px] leading-tight whitespace-pre-wrap">
          {task.worktree_init_output}
        </pre>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="default"
          disabled={retry.isPending || skip.isPending}
          onClick={() => retry.mutate(task.id)}
        >
          {retry.isPending ? "Retrying…" : "Retry initialization"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={retry.isPending || skip.isPending}
          onClick={() => skip.mutate(task.id)}
        >
          {skip.isPending ? "Skipping…" : "Skip and proceed"}
        </Button>
        {error && (
          <span className="text-destructive ml-1 truncate text-[11px]">
            {String(error)}
          </span>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}
