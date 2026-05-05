import { useState } from "react";
import { Lock, Terminal } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  useCancelPhaseRun,
  usePhaseRunOutput,
} from "@/features/phase-runs/hooks";
import { PhaseRunOutputDialog } from "@/features/phase-runs/components/phase-run-output-dialog";
import type { PhaseRun } from "@/features/phase-runs/types";
import {
  PERMISSION_MODE_LABEL,
  type PermissionMode,
} from "@/features/workspaces/types";
import { cn } from "@/lib/utils";

const STATUS_BADGE: Record<string, string> = {
  running:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  completed:
    "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  cancelled:
    "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
};

export function PhaseRunCard({ phaseRun }: { phaseRun: PhaseRun }) {
  const output = usePhaseRunOutput(phaseRun.id);
  const cancel = useCancelPhaseRun();
  const [terminalOpen, setTerminalOpen] = useState(false);

  const stream = (output.data ?? []).map((c) => c.chunk).join("");

  return (
    <div className="bg-card overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">{phaseRun.phase}</span>
        <span className="text-muted-foreground text-xs">
          {phaseRun.provider} · {phaseRun.model}
        </span>
        {phaseRun.permission_mode && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            ·
            {phaseRun.permission_mode === "plan" && (
              <Lock className="size-3" aria-label="read-only" />
            )}
            <span>
              mode:{" "}
              {PERMISSION_MODE_LABEL[
                phaseRun.permission_mode as PermissionMode
              ] ?? phaseRun.permission_mode}
            </span>
          </span>
        )}
        <Badge
          variant="outline"
          className={cn(
            "ml-auto h-5 rounded-sm border px-1.5 text-[10px] uppercase tracking-wide",
            STATUS_BADGE[phaseRun.status] ?? STATUS_BADGE.cancelled,
          )}
        >
          {phaseRun.status}
        </Badge>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setTerminalOpen(true)}
          title="Open full output in a terminal-style window"
        >
          <Terminal className="size-3" />
          Output
        </Button>
        {phaseRun.status === "running" && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => cancel.mutate(phaseRun.id)}
            disabled={cancel.isPending}
          >
            Cancel
          </Button>
        )}
      </div>
      {phaseRun.summary && (
        <p className="text-muted-foreground border-b px-3 py-2 text-xs">
          {phaseRun.summary}
        </p>
      )}
      {phaseRun.error_message && (
        <PhaseRunErrorBanner
          errorKind={phaseRun.error_kind}
          errorMessage={phaseRun.error_message}
        />
      )}
      <pre className="bg-zinc-950 text-zinc-100 max-h-64 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed">
        {stream || <span className="text-zinc-500">(no output)</span>}
      </pre>

      <PhaseRunOutputDialog
        open={terminalOpen}
        onOpenChange={setTerminalOpen}
        phaseRun={phaseRun}
      />
    </div>
  );
}

/**
 * Surfaces a PhaseRunFailed event with an error_kind-aware message. Stall
 * variants get a longer, more diagnostic line — they imply a stuck or hung
 * agent and the user usually wants to know which timeout fired before they
 * decide whether to retry.
 */
function PhaseRunErrorBanner({
  errorKind,
  errorMessage,
}: {
  errorKind: string | null;
  errorMessage: string;
}) {
  const friendly = friendlyForErrorKind(errorKind, errorMessage);
  return (
    <div className="text-destructive border-b px-3 py-2 text-xs">
      <p className="font-medium">{friendly.headline}</p>
      {friendly.detail && (
        <p className="text-destructive/80 mt-0.5">{friendly.detail}</p>
      )}
    </div>
  );
}

type FriendlyError = { headline: string; detail: string | null };

function friendlyForErrorKind(
  kind: string | null,
  message: string,
): FriendlyError {
  // The subprocess module reports stall durations in the message body. We
  // surface them in a human-readable form because "killed after 5 minutes" is
  // far more useful than a raw error_kind enum value.
  if (kind === "stalled_no_output") {
    return {
      headline: `Phase killed: no output for ${extractMinutesFromMessage(message) ?? "the silence timeout"}.`,
      detail:
        "The agent may have been waiting for input or stuck. Retrying with a different model or a longer silence timeout often helps.",
    };
  }
  if (kind === "stalled_wall_clock") {
    return {
      headline: `Phase killed: ran for ${extractMinutesFromMessage(message) ?? "the wall-clock timeout"}.`,
      detail:
        "The agent may have been stuck in a loop. Retrying or raising the wall-clock timeout in workspace settings may help.",
    };
  }
  if (kind === "user_cancelled") {
    return { headline: "Phase cancelled by user.", detail: null };
  }
  return {
    headline: `${kind ?? "error"}: ${message}`,
    detail: null,
  };
}

/**
 * Pull a "5 minutes" / "1.5 minutes" string out of the subprocess module's
 * "produced no output for 300000ms" / "ran for 1800000ms (wall-clock timeout)"
 * messages, so the UI can render minutes rather than millis.
 */
function extractMinutesFromMessage(message: string): string | null {
  const match = /(\d+(?:\.\d+)?)\s*ms/.exec(message);
  if (!match) return null;
  const ms = parseFloat(match[1]);
  if (!isFinite(ms) || ms <= 0) return null;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = ms / 60_000;
  if (Math.abs(minutes - Math.round(minutes)) < 0.05) {
    return `${Math.round(minutes)} minutes`;
  }
  return `${minutes.toFixed(1)} minutes`;
}
