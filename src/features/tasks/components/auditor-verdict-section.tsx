import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { tasksApi } from "../api";
import {
  useApproveTaskAnyway,
  useLatestAuditorVerdict,
  usePassBackToImplementer,
  useRejectTask,
} from "../hooks";
import type { AuditorConcern, AuditorVerdictKind } from "../types";

const VERDICT_STYLES: Record<string, string> = {
  approve:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  revise:
    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  reject:
    "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
};

const SEVERITY_STYLES: Record<string, string> = {
  blocking:
    "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  advisory:
    "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
};

export function AuditorVerdictSection({ taskId }: { taskId: string }) {
  const verdictQ = useLatestAuditorVerdict(taskId);
  const passBack = usePassBackToImplementer();
  const reject = useRejectTask();
  const approveAnyway = useApproveTaskAnyway();

  if (verdictQ.isLoading || !verdictQ.data) return null;
  const v = verdictQ.data;
  const kind = v.verdict as AuditorVerdictKind;
  const showActions = kind === "revise" || kind === "reject";
  const pending =
    passBack.isPending || reject.isPending || approveAnyway.isPending;

  return (
    <section className="space-y-3">
      <h2 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
        Auditor verdict
      </h2>
      <div className="bg-muted/20 space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "h-5 rounded-sm border px-1.5 text-[10px] uppercase tracking-wide",
              VERDICT_STYLES[kind] ?? VERDICT_STYLES.revise,
            )}
          >
            {String(v.verdict)}
          </Badge>
          <span className="text-muted-foreground text-xs tabular-nums">
            confidence {Math.round(v.confidence * 100)}%
          </span>
        </div>
        {v.summary.trim() && (
          <p className="text-sm leading-relaxed">{v.summary}</p>
        )}
        {v.concerns.length > 0 && (
          <ul className="space-y-2">
            {v.concerns.map((c, idx) => (
              <ConcernRow key={idx} taskId={taskId} concern={c} />
            ))}
          </ul>
        )}
        {showActions && (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button
              size="sm"
              onClick={() => passBack.mutate(taskId)}
              disabled={pending}
            >
              Pass back to implementer
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => approveAnyway.mutate(taskId)}
              disabled={pending}
            >
              Approve anyway
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => reject.mutate(taskId)}
              disabled={pending}
            >
              Reject
            </Button>
            {(passBack.error || reject.error || approveAnyway.error) && (
              <p className="text-destructive text-xs">
                {String(
                  passBack.error ?? reject.error ?? approveAnyway.error,
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ConcernRow({
  taskId,
  concern,
}: {
  taskId: string;
  concern: AuditorConcern;
}) {
  const onOpen = () => {
    if (!concern.anchor) return;
    void tasksApi.openInEditor(
      taskId,
      concern.anchor.path,
      concern.anchor.line,
    );
  };
  return (
    <li className="flex items-start gap-2 text-sm">
      <Badge
        variant="outline"
        className={cn(
          "mt-0.5 h-5 rounded-sm border px-1.5 text-[10px] uppercase tracking-wide",
          SEVERITY_STYLES[concern.severity] ?? SEVERITY_STYLES.advisory,
        )}
      >
        {concern.severity}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-medium">{concern.category}</span>
          {concern.anchor && (
            <button
              type="button"
              onClick={onOpen}
              className="text-muted-foreground hover:text-foreground font-mono text-[11px] underline-offset-2 hover:underline"
            >
              {concern.anchor.path}:{concern.anchor.line}
            </button>
          )}
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {concern.rationale}
        </p>
      </div>
    </li>
  );
}
