import { useEffect, useRef, useState } from "react";
import { ArrowsOut, Check, Copy, Terminal } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePhaseRunOutput } from "@/features/phase-runs/hooks";
import type { PhaseRun } from "@/features/phase-runs/types";
import { ProviderModelLabel } from "@/features/providers/components/provider-logo";

/**
 * Full-screen terminal-style view of a phase run's stdout/stderr stream.
 * Auto-scrolls to the bottom while the run is live so the user sees new
 * output as it lands; once the user manually scrolls away from the bottom we
 * stop forcing scroll so they can read older lines without being yanked
 * back. Reads the same query inline previews use, so the dialog opens with
 * already-cached data when available.
 */
export function PhaseRunOutputDialog({
  open,
  onOpenChange,
  phaseRun,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  phaseRun: PhaseRun;
}) {
  // Only fetch while the dialog is open — there's no sense paying for the
  // chunk fetch on tasks where the user hasn't asked to see the terminal.
  const output = usePhaseRunOutput(phaseRun.id, { enabled: open });
  const chunks = output.data ?? [];
  const stream = chunks.map((c) => c.chunk).join("");
  const lastChunk = chunks.length > 0 ? chunks[chunks.length - 1] : null;
  const totalBytes = stream.length;

  const preRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [copied, setCopied] = useState(false);
  const isRunning = phaseRun.status === "running";

  // Heartbeat: while running, retick once a second so the "idle" timer keeps
  // counting up between chunks. Without this the user couldn't distinguish
  // a stalled run from a quiet one — the indicator would freeze on the last
  // chunk's timestamp and only update when a new chunk arrived.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || !isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, isRunning]);

  const idleMs = lastChunk
    ? now - lastChunk.created_at
    : isRunning
      ? now - phaseRun.started_at
      : 0;

  useEffect(() => {
    if (!open) return;
    const el = preRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [open, stream]);

  useEffect(() => {
    if (open) stickToBottomRef.current = true;
  }, [open]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 24;
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(stream);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; silently no-op */
    }
  };

  const onJumpToBottom = () => {
    const el = preRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] w-[min(92vw,1100px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        showCloseButton={false}
      >
        <DialogHeader className="bg-zinc-950 border-zinc-800 flex flex-row items-center gap-2 border-b px-3 py-2 text-zinc-200">
          <Terminal className="size-4 text-emerald-400" aria-hidden="true" />
          <DialogTitle className="inline-flex min-w-0 items-center gap-1 text-xs font-medium text-zinc-100">
            <span>{phaseRun.phase}</span>
            <span className="text-zinc-500">·</span>
            <ProviderModelLabel
              provider={phaseRun.provider}
              model={phaseRun.model}
              separator="/"
              logoClassName="size-3"
            />
          </DialogTitle>
          <DialogDescription className="text-[11px] text-zinc-400">
            {phaseRun.status}
            {isRunning && (
              <span className="ml-2 inline-flex items-center gap-1 text-emerald-400">
                <span className="bg-emerald-400 inline-block size-1.5 animate-pulse rounded-full" />
                live
              </span>
            )}
            <span className="ml-2 text-zinc-500">
              · {chunks.length} chunk{chunks.length === 1 ? "" : "s"}
              {totalBytes > 0 && ` · ${formatBytes(totalBytes)}`}
            </span>
            {isRunning && (
              <span
                className={
                  "ml-2 inline-flex items-center gap-1 " +
                  idleSeverityClass(idleMs)
                }
                title={
                  lastChunk
                    ? `Last output ${formatIdle(idleMs)} ago — if this keeps growing, the LLM may be hanging.`
                    : "No output yet from this phase."
                }
              >
                <span
                  className={
                    "inline-block size-1.5 rounded-full " +
                    idleDotClass(idleMs)
                  }
                  aria-hidden="true"
                />
                idle {formatIdle(idleMs)}
              </span>
            )}
          </DialogDescription>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={onCopy}
              className="text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
              disabled={!stream}
            >
              {copied ? (
                <>
                  <Check className="size-3" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-3" /> Copy
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={onJumpToBottom}
              className="text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
              disabled={!stream}
              title="Jump to latest output"
            >
              <ArrowsOut className="size-3" /> Bottom
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onOpenChange(false)}
              className="text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
            >
              Close
            </Button>
          </div>
        </DialogHeader>
        <pre
          ref={preRef}
          onScroll={onScroll}
          className="scrollbar-styled bg-zinc-950 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-relaxed text-zinc-100 selection:bg-emerald-500/30"
        >
          {stream || (
            <span className="text-zinc-500">
              {isRunning
                ? "Waiting for the agent to produce output…"
                : "(no output)"}
            </span>
          )}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Idle-time threshold buckets — chosen to match the kinds of pauses a healthy
 * LLM can plausibly take. <10s is normal between chunks. 10–30s is borderline.
 * 30–60s suggests it's stuck. >60s is almost certainly a hang. The subprocess
 * module's own silence timeout will eventually kill it, but the user wants to
 * notice well before that fires.
 */
function idleSeverityClass(idleMs: number): string {
  if (idleMs < 10_000) return "text-zinc-500";
  if (idleMs < 30_000) return "text-amber-300";
  return "text-red-400";
}

function idleDotClass(idleMs: number): string {
  if (idleMs < 10_000) return "bg-zinc-500";
  if (idleMs < 30_000) return "bg-amber-400";
  return "bg-red-400 animate-pulse";
}

function formatIdle(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
