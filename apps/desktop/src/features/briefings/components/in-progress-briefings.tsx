import { Sparkle } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProviderModelLabel } from "@/features/providers/components/provider-logo";
import { useActiveBriefings } from "../hooks";

/**
 * Shown above the plans list. Lists briefings whose status is still `active` so
 * the user can resume an in-progress flow they navigated away from. Hidden
 * entirely when there are none — no header, no empty state.
 *
 * Live updates are handled by the workspace-level
 * `BriefingsLiveUpdatesProvider` — no per-component listener needed.
 */
export function InProgressBriefings({
  onContinue,
}: {
  onContinue: (briefingId: string) => void;
}) {
  const { data } = useActiveBriefings();

  if (!data || data.length === 0) return null;

  return (
    <section
      aria-label="In-progress briefings"
      className="border-border bg-muted/20 space-y-2 border p-3"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
          <Sparkle className="size-3" weight="fill" />
          In-progress briefings
        </h2>
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {data.length}
        </span>
      </div>
      <ul className="space-y-1.5">
        {data.map((b) => {
          const title =
            b.current_draft?.title?.trim() ||
            untitledFor(b.initial_description);
          return (
            <li
              key={b.id}
              className="border-border bg-card flex items-center justify-between gap-3 border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{title}</p>
                <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-[11px]">
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    <ProviderModelLabel
                      provider={b.provider}
                      model={b.model}
                      separator="/"
                      logoClassName="size-2.5"
                    />
                  </Badge>
                  <span>
                    {b.generation_count > 0
                      ? `Draft ${b.generation_count}`
                      : "Generating first draft…"}
                  </span>
                  <span>·</span>
                  <span>{relativeTime(b.updated_at)}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onContinue(b.id)}
              >
                Continue
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function untitledFor(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return "Untitled briefing";
  const firstLine = trimmed.split("\n")[0];
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function relativeTime(epochSeconds: number): string {
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
