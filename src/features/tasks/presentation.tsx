import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TaskStatus } from "./types";

const STATUS_STYLES: Record<TaskStatus, string> = {
  draft:
    "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
  running:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  awaiting_review:
    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  merged:
    "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  cancelled:
    "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
  archived:
    "bg-zinc-500/10 text-muted-foreground border-zinc-500/20",
  failed:
    "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
};

export function TaskStatusBadge({ status }: { status: TaskStatus | string }) {
  const cls =
    (STATUS_STYLES as Record<string, string>)[status] ?? STATUS_STYLES.draft;
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 rounded-sm border px-1.5 text-[10px] uppercase tracking-wide",
        cls,
      )}
    >
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
