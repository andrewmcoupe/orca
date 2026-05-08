import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TaskStatus } from "./types";

const STATUS_STYLES: Record<TaskStatus, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  running: "bg-success/15 text-success border-success/40",
  awaiting_review: "bg-warning/15 text-warning border-warning/40",
  approved: "bg-success/15 text-success border-success/40",
  // `merged` reads as a terminal/neutral-positive state distinct from `approved`.
  // Reuse `--primary` so it picks up the theme's headline ink tone in both modes
  // without introducing a fourth chromatic role.
  merged: "bg-primary/10 text-primary border-primary/30",
  cancelled: "bg-muted text-muted-foreground border-border",
  archived: "bg-muted/60 text-muted-foreground border-border",
  failed: "bg-destructive/15 text-destructive border-destructive/40",
};

export function TaskStatusBadge({ status }: { status: TaskStatus | string }) {
  const cls =
    (STATUS_STYLES as Record<string, string>)[status] ?? STATUS_STYLES.draft;
  return (
    <Badge
      variant="outline"
      className={cn("rounded-sm border px-1.5 text-[10px] tracking-wide", cls)}
    >
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
