import {
  FileText,
  GithubLogo,
  Kanban,
  LinkSimple,
  PencilSimple,
  Sparkle,
  type Icon,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import type { PlanSource, PlanStatus } from "./types";
import { cn } from "@/lib/utils";

const SOURCE_ICONS: Record<PlanSource, Icon> = {
  manual: PencilSimple,
  prd_file: FileText,
  linear: LinkSimple,
  github_issue: GithubLogo,
  briefing: Sparkle,
};

const SOURCE_LABEL: Record<PlanSource, string> = {
  manual: "Manual",
  prd_file: "PRD",
  linear: "Linear",
  github_issue: "GitHub",
  briefing: "Briefing",
};

export function PlanSourceIcon({
  source,
  className,
}: {
  source: PlanSource | string;
  className?: string;
}) {
  const SourceIcon =
    (SOURCE_ICONS as Record<string, Icon>)[source] ?? Kanban;
  return (
    <SourceIcon
      className={cn("text-muted-foreground size-3.5 shrink-0", className)}
      aria-label={(SOURCE_LABEL as Record<string, string>)[source] ?? source}
    />
  );
}

const STATUS_STYLES: Record<PlanStatus, string> = {
  active:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  paused:
    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  completed:
    "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  cancelled:
    "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
  archived:
    "bg-zinc-500/10 text-muted-foreground border-zinc-500/20",
};

export function PlanStatusBadge({ status }: { status: PlanStatus | string }) {
  const cls =
    (STATUS_STYLES as Record<string, string>)[status] ?? STATUS_STYLES.cancelled;
  return (
    <Badge
      variant="outline"
      className={cn("h-5 rounded-sm border px-1.5 text-[10px] uppercase tracking-wide", cls)}
    >
      {status}
    </Badge>
  );
}
