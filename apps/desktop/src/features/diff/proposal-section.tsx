import { useMemo, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/layout/disclosure";
import {
  useTaskDiff,
  useTaskDiffLiveUpdates,
} from "@/features/diff/hooks";
import { cn } from "@/lib/utils";
import type {
  HighlightedDiffFile,
  HighlightedDiffHunk,
  HighlightedDiffLine,
} from "./types";

type Props = {
  taskId: string;
  open: boolean;
  lastReviewedBeforeOpen: number | null;
  initialConcernIndex?: number;
  onOpenChange: (open: boolean) => void;
};

type ChangeMode = "all" | "since_last_review";
type ViewMode = "unified" | "side_by_side";

export function shouldShowSinceLastReview(
  computedAt: number,
  lastReviewedAt: number | null,
) {
  return lastReviewedAt == null || computedAt > lastReviewedAt;
}

export function ProposalSection({
  taskId,
  open,
  lastReviewedBeforeOpen,
  initialConcernIndex,
  onOpenChange,
}: Props) {
  const diffQ = useTaskDiff(open ? taskId : undefined);
  useTaskDiffLiveUpdates(open ? taskId : undefined, open && !!diffQ.data?.is_live);
  const [changeMode, setChangeMode] = useState<ChangeMode>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("unified");

  const files = useMemo(() => {
    const diff = diffQ.data?.diff;
    if (!diff) return [];
    if (
      changeMode === "since_last_review" &&
      !shouldShowSinceLastReview(diff.computed_at, lastReviewedBeforeOpen)
    ) {
      return [];
    }
    return diff.files;
  }, [changeMode, diffQ.data, lastReviewedBeforeOpen]);

  const focusedConcern = initialConcernIndex ?? null;

  return (
    <Disclosure
      title="Proposal"
      summary="Review changes"
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-sm border bg-background p-0.5">
            <SegmentButton
              active={changeMode === "all"}
              onClick={() => setChangeMode("all")}
            >
              All changes
            </SegmentButton>
            <SegmentButton
              active={changeMode === "since_last_review"}
              onClick={() => setChangeMode("since_last_review")}
            >
              Since last review
            </SegmentButton>
          </div>
          <div className="inline-flex rounded-sm border bg-background p-0.5">
            <SegmentButton
              active={viewMode === "unified"}
              onClick={() => setViewMode("unified")}
            >
              Unified
            </SegmentButton>
            <SegmentButton
              active={viewMode === "side_by_side"}
              onClick={() => setViewMode("side_by_side")}
            >
              Side by side
            </SegmentButton>
          </div>
        </div>

        {focusedConcern !== null && (
          <p className="text-muted-foreground text-xs">
            Opened from auditor concern {focusedConcern + 1}.
          </p>
        )}

        {diffQ.isLoading && (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <CircleNotch className="size-4 animate-spin" />
            Loading changes…
          </div>
        )}

        {diffQ.error && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-sm border p-3 text-sm">
            Could not load changes: {String(diffQ.error)}
          </div>
        )}

        {diffQ.data && files.length === 0 && (
          <div className="bg-muted/20 text-muted-foreground rounded-sm border border-dashed p-6 text-center text-sm">
            No changes in this view.
          </div>
        )}

        {diffQ.data && files.length > 0 && (
          <div className="space-y-2">
            <div className="text-muted-foreground font-mono text-[11px]">
              {diffQ.data.diff.files.length} files · +{diffQ.data.diff.additions}{" "}
              -{diffQ.data.diff.deletions}
            </div>
            {files.map((file) => (
              <ProposalFile key={`${file.old_path ?? ""}:${file.path}`} file={file} viewMode={viewMode} />
            ))}
          </div>
        )}
      </div>
    </Disclosure>
  );
}

function SegmentButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      className="h-7 rounded-sm px-2 text-xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ProposalFile({
  file,
  viewMode,
}: {
  file: HighlightedDiffFile;
  viewMode: ViewMode;
}) {
  return (
    <details className="rounded-sm border bg-background" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs">{file.path}</div>
          {file.old_path && (
            <div className="text-muted-foreground truncate font-mono text-[10px]">
              renamed from {file.old_path}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="rounded-sm text-[10px]">
            {file.status}
          </Badge>
          <span className="font-mono text-[11px]">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{file.additions}
            </span>{" "}
            <span className="text-red-600 dark:text-red-400">
              -{file.deletions}
            </span>
          </span>
        </div>
      </summary>
      {file.is_binary ? (
        <div className="text-muted-foreground border-t p-3 text-sm">
          Binary file changed.
        </div>
      ) : (
        <div className="border-t">
          {file.hunks.map((hunk, index) => (
            <ProposalHunk
              key={`${hunk.old_start}:${hunk.new_start}:${index}`}
              hunk={hunk}
              viewMode={viewMode}
            />
          ))}
        </div>
      )}
    </details>
  );
}

function ProposalHunk({
  hunk,
  viewMode,
}: {
  hunk: HighlightedDiffHunk;
  viewMode: ViewMode;
}) {
  return (
    <div className="border-t first:border-t-0">
      <div className="bg-muted/30 flex items-center justify-between gap-3 px-3 py-1.5">
        <code className="text-muted-foreground text-[11px]">
          -{hunk.old_start},{hunk.old_lines} +{hunk.new_start},{hunk.new_lines}
          {hunk.header ? ` ${hunk.header}` : ""}
        </code>
        <AuthorBadge />
      </div>
      {viewMode === "unified" ? (
        <div className="overflow-x-auto">
          {hunk.lines.map((line, index) => (
            <UnifiedLine key={`${line.old_lineno}:${line.new_lineno}:${index}`} line={line} />
          ))}
        </div>
      ) : (
        <SideBySideLines lines={hunk.lines} />
      )}
    </div>
  );
}

function AuthorBadge() {
  return (
    <span
      className="rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
      title="Author attribution defaults to human when no agent identity is available for this hunk."
    >
      human
    </span>
  );
}

function UnifiedLine({ line }: { line: HighlightedDiffLine }) {
  return (
    <div className={cn("grid grid-cols-[48px_48px_1fr] font-mono text-[11px]", lineClass(line.kind))}>
      <span className="select-none px-2 text-right text-muted-foreground/60">
        {line.old_lineno ?? ""}
      </span>
      <span className="select-none border-r px-2 text-right text-muted-foreground/60">
        {line.new_lineno ?? ""}
      </span>
      <code
        className="whitespace-pre px-2"
        dangerouslySetInnerHTML={{ __html: `${linePrefix(line.kind)}${line.html}` }}
      />
    </div>
  );
}

function SideBySideLines({ lines }: { lines: HighlightedDiffLine[] }) {
  return (
    <div className="overflow-x-auto">
      {lines.map((line, index) => (
        <div
          key={`${line.old_lineno}:${line.new_lineno}:${index}`}
          className="grid grid-cols-[48px_minmax(0,1fr)_48px_minmax(0,1fr)] font-mono text-[11px]"
        >
          <span className="select-none px-2 text-right text-muted-foreground/60">
            {line.old_lineno ?? ""}
          </span>
          <code
            className={cn("whitespace-pre border-r px-2", line.kind === "removed" && lineClass(line.kind))}
            dangerouslySetInnerHTML={{
              __html: line.kind === "added" ? "" : line.html,
            }}
          />
          <span className="select-none px-2 text-right text-muted-foreground/60">
            {line.new_lineno ?? ""}
          </span>
          <code
            className={cn("whitespace-pre px-2", line.kind === "added" && lineClass(line.kind))}
            dangerouslySetInnerHTML={{
              __html: line.kind === "removed" ? "" : line.html,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function linePrefix(kind: HighlightedDiffLine["kind"]) {
  if (kind === "added") return "+";
  if (kind === "removed") return "-";
  return " ";
}

function lineClass(kind: HighlightedDiffLine["kind"]) {
  if (kind === "added") return "bg-emerald-500/10";
  if (kind === "removed") return "bg-red-500/10";
  return "";
}
