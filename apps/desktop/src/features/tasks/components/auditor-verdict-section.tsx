import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

// The verdict header picks up a tinted wash via these utility classes
// (defined in App.css). The body stays on the regular surface so longer
// feedback remains easy to read.
const VERDICT_TINT_CLASSES: Record<string, string> = {
  approve: "verdict-tint-success",
  revise: "verdict-tint-warning",
  reject: "verdict-tint-destructive",
};

const SEVERITY_STYLES: Record<string, string> = {
  blocking: "text-destructive border-destructive/40",
  advisory: "border-none text-muted-foreground",
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
      <ContentColumn className="overflow-hidden rounded-lg border bg-card">
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 px-[14px] py-2.5",
            VERDICT_TINT_CLASSES[kind] ?? VERDICT_TINT_CLASSES.revise,
          )}
        >
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
        {(v.summary.trim() || v.concerns.length > 0) && (
          <div className="space-y-2.5 p-[14px]">
            {v.summary.trim() && (
              <p className="text-[13px] leading-[1.5] font-serif text-muted-foreground">
                {v.summary}
              </p>
            )}
            {v.concerns.length > 0 && (
              <ul className="space-y-4">
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
          </div>
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
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1">
          <p
            className={cn(
              "shrink-0 text-[12px] font-medium tracking-[0.06em]",
              SEVERITY_STYLES[concern.severity] ?? SEVERITY_STYLES.advisory,
            )}
          >
            {concern.severity}
          </p>
          &middot;
          <span className="text-[12px] font-medium text-muted-foreground">
            {concern.category}
          </span>
        </div>
        <p className="text-muted-foreground text-[12px] leading-[1.5] font-serif">
          {concern.rationale}
        </p>
        {concern.anchor && (
          <Button
            variant="ghost"
            type="button"
            onClick={onOpen}
            className="h-auto rounded-sm border-0 px-0 py-0 font-mono text-[11px] font-normal text-primary/80 underline-offset-2 hover:bg-transparent hover:text-primary hover:underline"
          >
            {concern.anchor.path}:{concern.anchor.line}
          </Button>
        )}
      </div>
    </li>
  );
}
