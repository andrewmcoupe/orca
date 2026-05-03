import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { diffModalController } from "@/features/diff/modal-controller";
import {
  useApproveTaskAnyway,
  useLatestAuditorVerdict,
  usePassBackToImplementer,
  useRejectTask,
  useTask,
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
  const [feedback, setFeedback] = useState("");

  const taskQ = useTask(taskId);

  if (verdictQ.isLoading || !verdictQ.data) return null;
  const v = verdictQ.data;
  const kind = v.verdict as AuditorVerdictKind;
  // Suppress action buttons once the user has already acted on this verdict
  // (the task status moved to a terminal-ish state). Without this guard the
  // verdict section would keep offering to re-approve / re-reject after the
  // fact.
  const taskStatus = taskQ.data?.status;
  const alreadyResolved =
    taskStatus === "approved" ||
    taskStatus === "merged" ||
    taskStatus === "cancelled" ||
    taskStatus === "archived";
  const showActions =
    !alreadyResolved &&
    (kind === "approve" || kind === "revise" || kind === "reject");
  // The verdict alone doesn't change task state — the user always confirms.
  // On "approve" we surface a single confirmation button; on revise/reject we
  // show the full set (pass-back / approve-anyway / reject) with a feedback
  // box for pass-back.
  const showFeedback = kind === "revise" || kind === "reject";
  const pending =
    passBack.isPending || reject.isPending || approveAnyway.isPending;

  const onPassBack = () => {
    const trimmed = feedback.trim();
    passBack.mutate(
      { taskId, userFeedback: trimmed.length > 0 ? trimmed : null },
      { onSuccess: () => setFeedback("") },
    );
  };

  return (
    <section className="space-y-2">
      <h2 className="text-muted-foreground/70 font-mono text-[10px] font-medium uppercase tracking-[0.08em]">
        Auditor verdict
      </h2>
      <div className="bg-muted/20 space-y-2.5 border p-[14px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "h-[18px] rounded-sm border px-2 font-mono text-[10px] font-medium uppercase tracking-[0.08em]",
              VERDICT_STYLES[kind] ?? VERDICT_STYLES.revise,
            )}
          >
            {String(v.verdict)}
          </Badge>
          <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
            confidence {Math.round(v.confidence * 100)}%
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
        {showActions && (
          <div className="space-y-2 pt-2">
            {showFeedback && (
              <div className="space-y-1.5">
                <Label
                  htmlFor="passback-feedback"
                  className="text-muted-foreground text-[11px] uppercase tracking-wide"
                >
                  Your feedback (optional)
                </Label>
                <Textarea
                  id="passback-feedback"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  rows={3}
                  placeholder="Anything to add or override? Combined with the auditor's concerns when passing back. The implementer treats your feedback as authoritative if it conflicts."
                  disabled={pending}
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {kind === "approve" ? (
                <Button
                  size="sm"
                  onClick={() => approveAnyway.mutate(taskId)}
                  disabled={pending}
                >
                  {approveAnyway.isPending
                    ? "Approving…"
                    : "Approve & ready to merge"}
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={onPassBack} disabled={pending}>
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
                </>
              )}
              {(passBack.error || reject.error || approveAnyway.error) && (
                <p className="text-destructive text-xs">
                  {String(
                    passBack.error ?? reject.error ?? approveAnyway.error,
                  )}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
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
          "mt-[3px] h-[16px] shrink-0 rounded-sm border px-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.06em]",
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
