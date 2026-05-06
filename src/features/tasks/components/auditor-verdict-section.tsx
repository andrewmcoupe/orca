import { Badge } from "@/components/ui/badge";
import { ContentColumn } from "@/components/layout/content-column";
import { cn } from "@/lib/utils";
import { diffModalController } from "@/features/diff/modal-controller";
import { useLatestAuditorVerdict } from "../hooks";
import type { AuditorConcern, AuditorVerdictKind } from "../types";

const VERDICT_BADGE_STYLES: Record<string, string> = {
  approve: "bg-success/15 text-success border-success/40",
  revise: "bg-warning/15 text-warning border-warning/40",
  reject: "bg-destructive/15 text-destructive border-destructive/40",
};

// The card surface itself picks up a tinted wash via these utility classes
// (defined in App.css). The mix is against `--background`, so the same rule
// produces a barely-tinted pale wash in light mode and a subtle deepening
// of the surface in dark mode.
const VERDICT_TINT_CLASSES: Record<string, string> = {
  approve: "verdict-tint-success",
  revise: "verdict-tint-warning",
  reject: "verdict-tint-destructive",
};

const SEVERITY_STYLES: Record<string, string> = {
  blocking: "bg-destructive/15 text-destructive border-destructive/40",
  advisory: "bg-muted text-muted-foreground border-border",
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
      <h2 className="text-muted-foreground font-medium">Auditor verdict</h2>
      <ContentColumn
        className={cn(
          "space-y-2.5 border p-[14px]",
          VERDICT_TINT_CLASSES[kind] ?? VERDICT_TINT_CLASSES.revise,
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "h-[18px] rounded-sm border px-2 text-[10px] font-medium uppercase tracking-[0.08em]",
              VERDICT_BADGE_STYLES[kind] ?? VERDICT_BADGE_STYLES.revise,
            )}
          >
            {String(v.verdict)}
          </Badge>
          <span className="text-muted-foreground text-[11px] tabular-nums">
            confidence{" "}
            <span className="font-mono">{Math.round(v.confidence * 100)}%</span>
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
