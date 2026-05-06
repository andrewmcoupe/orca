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
  active: "bg-success/15 text-success border-success/40",
  paused: "bg-warning/15 text-warning border-warning/40",
  completed: "bg-primary/10 text-primary border-primary/30",
  cancelled: "bg-muted text-muted-foreground border-border",
  archived: "bg-muted/60 text-muted-foreground border-border",
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
