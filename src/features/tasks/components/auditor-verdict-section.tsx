import { Badge } from "@/components/ui/badge";
import { ContentColumn } from "@/components/layout/content-column";
import { cn } from "@/lib/utils";
import { diffModalController } from "@/features/diff/modal-controller";
import { useLatestAuditorVerdict } from "../hooks";
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

/**
 * Auditor verdict card — purely informational. The action buttons
 * (approve / pass back / reject) live in the task action toolbar; the user
 * goes there when they want to act, comes here when they want to read why the
 * auditor said what it said.
 */
export function AuditorVerdictSection({ taskId }: { taskId: string }) {
  const verdictQ = useLatestAuditorVerdict(taskId);
  if (verdictQ.isLoading || !verdictQ.data) return null;
  const v = verdictQ.data;
  const kind = v.verdict as AuditorVerdictKind;

  return (
    <section className="space-y-2">
      <h2 className="text-muted-foreground/70 text-[10px] font-medium uppercase tracking-[0.08em]">
        Auditor verdict
      </h2>
      <ContentColumn className="bg-muted/20 space-y-2.5 border p-[14px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "h-[18px] rounded-sm border px-2 text-[10px] font-medium uppercase tracking-[0.08em]",
              VERDICT_STYLES[kind] ?? VERDICT_STYLES.revise,
            )}
          >
            {String(v.verdict)}
          </Badge>
          <span className="text-muted-foreground text-[11px] tabular-nums">
            confidence{" "}
            <span className="font-mono">
              {Math.round(v.confidence * 100)}%
            </span>
          </span>
        </div>
        {v.summary.trim() && (
          <p className="text-[13px] leading-[1.5]">{v.summary}</p>
        )}
        {v.concerns.length > 0 && (
          <ul className="space-y-1.5">
            {v.concerns.map((c, idx) => (
              <ConcernRow
                key={idx}
                taskId={taskId}
                concernIndex={idx}
                concern={c}
              />
            ))}
          </ul>
        )}
      </ContentColumn>
    </section>
  );
}

function ConcernRow({
  taskId,
  concernIndex,
  concern,
}: {
  taskId: string;
  concernIndex: number;
  concern: AuditorConcern;
}) {
  // Click jumps into the diff modal, scrolled to this concern. Replaces the
  // previous "open in external editor" affordance — the modal puts the line
  // and the rationale together without leaving the app.
  const onOpen = () => {
    diffModalController.open({ taskId, concernIndex });
  };
  return (
    <li className="flex items-start gap-2">
      <Badge
        variant="outline"
        className={cn(
          "mt-[3px] h-[16px] shrink-0 rounded-sm border px-1.5 text-[10px] font-medium uppercase tracking-[0.06em]",
          SEVERITY_STYLES[concern.severity] ?? SEVERITY_STYLES.advisory,
        )}
      >
        {concern.severity}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[12px] font-medium">{concern.category}</span>
          {concern.anchor && (
            <button
              type="button"
              onClick={onOpen}
              className="text-primary/80 hover:text-primary font-mono text-[11px] underline-offset-2 hover:underline"
            >
              {concern.anchor.path}:{concern.anchor.line}
            </button>
          )}
        </div>
        <p className="text-muted-foreground text-[12px] leading-[1.5]">
          {concern.rationale}
        </p>
      </div>
    </li>
  );
}
