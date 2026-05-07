import { useState } from "react";
import { CaretDown, CaretRight, ArrowUUpLeft } from "@phosphor-icons/react";
import { PhaseRunCard } from "./phase-run-card";
import type { PhaseRun } from "../types";

export function PhaseRunsTrail({ phaseRuns }: { phaseRuns: PhaseRun[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (phaseRuns.length === 0) {
    return (
      <p className="text-muted-foreground text-xs italic">No phase runs yet.</p>
    );
  }

  // Chronological — oldest first, matching the brief's "audit trail" framing.
  const ordered = [...phaseRuns].sort((a, b) => a.started_at - b.started_at);
  const indexById = new Map<string, number>();
  ordered.forEach((r, i) => indexById.set(r.id, i + 1));

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <CaretDown className="size-3" />
        ) : (
          <CaretRight className="size-3" />
        )}
        Phase runs ({ordered.length})
      </button>
      {open && (
        <ol className="space-y-2">
          {ordered.map((run, i) => {
            const isExpanded = expanded === run.id;
            const retryOfIdx = run.is_retry_of
              ? indexById.get(run.is_retry_of)
              : null;
            return (
              <li key={run.id} className="space-y-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((cur) => (cur === run.id ? null : run.id))
                  }
                  className="hover:bg-muted/40 flex w-full items-center gap-2 border px-3 py-2 text-left text-xs"
                >
                  <span className="text-muted-foreground tabular-nums">
                    #{i + 1}
                  </span>
                  <span className="font-mono text-muted-foreground">
                    {run.phase}
                  </span>
                  <span className="text-muted-foreground/40">{run.status}</span>
                  {retryOfIdx && (
                    <span className="text-muted-foreground inline-flex items-center gap-1">
                      <ArrowUUpLeft className="size-3" />
                      retry of #{retryOfIdx}
                    </span>
                  )}
                  <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                    {run.id.slice(0, 12)}
                  </span>
                </button>
                {isExpanded && <PhaseRunCard phaseRun={run} />}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
