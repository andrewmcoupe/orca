import { useNavigate, useParams } from "@tanstack/react-router";
import { useActiveBriefings, useCancelBriefingGeneration } from "../hooks";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Briefing } from "../types";

/**
 * Workspace-chrome indicator: a discreet pill in the header that's only
 * visible when at least one briefing is generating. Clicking it either
 * navigates straight to the only running briefing (n === 1) or opens a
 * popover listing each, with a per-row stop button (n > 1).
 *
 * The component is deliberately read-only with respect to start/cancel
 * UX flow — the canonical place to drive a briefing is its own page. The
 * indicator just exists so the user knows generations they kicked off
 * elsewhere are still running, and gives them a single click back to the
 * relevant page (or a quick stop without leaving where they are).
 *
 * Source of truth: `useActiveBriefings()` filtered by `is_generating`.
 * The global `BriefingsLiveUpdatesProvider` keeps that query fresh.
 */
export function InflightBriefingsIndicator() {
  const { workspaceId } = useParams({ strict: false }) as {
    workspaceId?: string;
  };
  const { data } = useActiveBriefings();
  const inflight = (data ?? []).filter((b) => b.is_generating);

  if (inflight.length === 0) return null;
  if (!workspaceId) return null; // We're outside a workspace context — nothing useful to link to.

  if (inflight.length === 1) {
    return <SingleBriefingPill briefing={inflight[0]} workspaceId={workspaceId} />;
  }
  return <MultipleBriefingsPill briefings={inflight} workspaceId={workspaceId} />;
}

function SingleBriefingPill({
  briefing,
  workspaceId,
}: {
  briefing: Briefing;
  workspaceId: string;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() =>
        navigate({
          to: "/workspace/$workspaceId/briefings/new",
          params: { workspaceId },
          search: { id: briefing.id },
        })
      }
      className="text-foreground/80 hover:text-foreground hover:bg-muted/60 flex h-5 items-center gap-1.5 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[11px] transition-colors"
      title={inflightTooltip(briefing)}
      aria-label={`Briefing generating: ${labelFor(briefing)}. Click to open.`}
    >
      <PulseDot />
      <span className="truncate max-w-[180px]">{labelFor(briefing)}</span>
      <span className="text-muted-foreground tabular-nums">
        {kindLabel(briefing.generation_kind)}
      </span>
    </button>
  );
}

function MultipleBriefingsPill({
  briefings,
  workspaceId,
}: {
  briefings: Briefing[];
  workspaceId: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="text-foreground/80 hover:text-foreground hover:bg-muted/60 flex h-5 items-center gap-1.5 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[11px] transition-colors"
            aria-label={`${briefings.length} briefings generating. Click to expand.`}
          >
            <PulseDot />
            <span>{briefings.length} briefings drafting…</span>
          </button>
        }
      />
      <PopoverContent align="end" className="w-96 p-2">
        <div className="space-y-1">
          <p className="text-muted-foreground px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide">
            Generating
          </p>
          <ul className="space-y-1">
            {briefings.map((b) => (
              <BriefingRow key={b.id} briefing={b} workspaceId={workspaceId} />
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BriefingRow({
  briefing,
  workspaceId,
}: {
  briefing: Briefing;
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const cancel = useCancelBriefingGeneration();
  const open = () =>
    navigate({
      to: "/workspace/$workspaceId/briefings/new",
      params: { workspaceId },
      search: { id: briefing.id },
    });
  return (
    <li className="hover:bg-muted/40 flex items-center gap-2 rounded-sm p-2">
      <button
        type="button"
        onClick={open}
        className="min-w-0 flex-1 text-left"
        title="Open briefing"
      >
        <p className="truncate text-sm font-medium">{labelFor(briefing)}</p>
        <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[11px]">
          <Badge variant="secondary" className="font-mono text-[10px]">
            {briefing.provider}:{briefing.model}
          </Badge>
          <span>·</span>
          <span>{kindLabel(briefing.generation_kind)}</span>
        </div>
      </button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          cancel.mutate(briefing.id);
        }}
        disabled={cancel.isPending && cancel.variables === briefing.id}
        title="Stop this generation"
      >
        Stop
      </Button>
    </li>
  );
}

/** Animated pulse to signal "live activity." Pure CSS, no JS animation. */
function PulseDot() {
  return (
    <span className="relative inline-flex h-2 w-2 items-center justify-center">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
    </span>
  );
}

function labelFor(b: Briefing): string {
  const titled = b.current_draft?.title?.trim();
  if (titled) return titled;
  const firstLine = b.initial_description.trim().split("\n")[0] ?? "";
  if (!firstLine) return "Untitled briefing";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function kindLabel(kind: Briefing["generation_kind"]): string {
  switch (kind) {
    case "initial":
      return "Drafting";
    case "refine":
      return "Refining";
    default:
      return "Working";
  }
}

function inflightTooltip(b: Briefing): string {
  return `${kindLabel(b.generation_kind)} (${b.provider}:${b.model}). Click to open.`;
}
