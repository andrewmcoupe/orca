import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePhaseRuns } from "@/features/phase-runs/hooks";
import { MergeDialog } from "@/features/tasks/components/merge-dialog";
import { PassBackDialog } from "@/features/tasks/components/pass-back-dialog";
import { useCatchUpTask } from "@/features/tasks/hooks";
import { deriveTaskReviewState } from "@/features/tasks/task-domain";
import type { Task } from "@/features/tasks/types";
import { cn } from "@/lib/utils";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Circle,
  Keyboard,
  Warning,
  X,
} from "@phosphor-icons/react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTaskDiff, useTaskDiffLiveUpdates } from "./hooks";
import {
  buildCriterionReviewItems,
  filesForHunkRefs,
  hasUsableCriterionMapping,
  hunkRefsForUnmapped,
  parseAcceptanceCriteria,
  revisionKey,
  type CriterionReviewItem,
  type ReviewMode,
  type ReviewSelection,
} from "./review-model";
import type {
  AuditorCriterionMapping,
  AuditorUnmappedHunk,
  HighlightedDiffFile,
} from "./types";

type Props = {
  task: Task;
  workspaceId: string;
  onExit: () => void;
};

type ReviewLine =
  | {
      kind: "line";
      lineNumber: number | null;
      html: string;
      changed: boolean;
      added: boolean;
      modified: boolean;
      previousHtml?: string;
      previousLineNumber?: number | null;
    }
  | {
      kind: "removed";
      html: string;
      lineNumber: number | null;
    }
  | {
      kind: "gap";
      count: number;
      key: string;
    };

const CONTEXT_LINES = 5;
const LONG_FILE_LINE_THRESHOLD = 100;

export function ProposalReviewSurface({ task, workspaceId, onExit }: Props) {
  const [diffEnabled, setDiffEnabled] = useState(false);
  const diffQ = useTaskDiff(task.id, diffEnabled);
  useTaskDiffLiveUpdates(
    diffEnabled ? task.id : undefined,
    !!diffQ.data?.is_live,
  );
  const phaseRuns = usePhaseRuns(workspaceId, task.id);
  const runs = phaseRuns.data ?? [];
  const activeRun = runs.find((r) => r.status === "running");
  const latestRun = runs[0] ?? null;
  const reviewState = deriveTaskReviewState({ task, activeRun, latestRun });
  const catchUp = useCatchUpTask();

  const [mode, setMode] = useState<ReviewMode>("by_criterion");
  const [selection, setSelection] = useState<ReviewSelection>("ac_1");
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());
  const [helpOpen, setHelpOpen] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [verdictOpen, setVerdictOpen] = useState(false);
  const [landOpen, setLandOpen] = useState(false);
  const [passBackOpen, setPassBackOpen] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setDiffEnabled(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const diff = diffQ.data?.diff ?? null;
  const verdict = diffQ.data?.auditor_verdict ?? null;
  const mappings = verdict?.criterion_mappings as
    | AuditorCriterionMapping[]
    | undefined;
  const unmapped = verdict?.unmapped_hunks as AuditorUnmappedHunk[] | undefined;
  const criteria = useMemo(
    () => parseAcceptanceCriteria(task.spec_markdown),
    [task.spec_markdown],
  );
  const criterionItems = useMemo(
    () => buildCriterionReviewItems(criteria, mappings),
    [criteria, mappings],
  );
  const hasCriterionView =
    criteria.length > 0 && hasUsableCriterionMapping(criterionItems);
  const effectiveMode = hasCriterionView ? mode : "by_file";
  const hasOtherSection = (unmapped?.length ?? 0) > 0;
  const reviewSectionIds = useMemo(
    () => [
      ...criterionItems.map((item) => item.id),
      ...(hasOtherSection ? ["other"] : []),
    ],
    [criterionItems, hasOtherSection],
  );
  const currentRevisionKey = diff
    ? revisionKey(task.id, diff.head_commit, verdict?.phase_run_id)
    : null;

  useEffect(() => {
    if (!hasCriterionView || selection === "other") return;
    if (!criterionItems.some((item) => item.id === selection)) {
      setSelection(criterionItems[0]?.id ?? "other");
    }
  }, [criterionItems, hasCriterionView, selection]);

  useEffect(() => {
    if (!currentRevisionKey) return;
    const raw = window.localStorage.getItem(
      reviewStorageKey(currentRevisionKey),
    );
    setReviewed(new Set(raw ? JSON.parse(raw) : []));
  }, [currentRevisionKey]);

  useEffect(() => {
    if (!currentRevisionKey || effectiveMode !== "by_criterion") return;
    if (selection === "other" && !hasOtherSection) return;
    if (
      selection !== "other" &&
      !criterionItems.some((item) => item.id === selection)
    )
      return;
    const timer = window.setTimeout(() => {
      setReviewed((prev) => {
        if (prev.has(selection)) return prev;
        const next = new Set(prev);
        next.add(selection);
        window.localStorage.setItem(
          reviewStorageKey(currentRevisionKey),
          JSON.stringify([...next]),
        );
        return next;
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [
    criterionItems,
    currentRevisionKey,
    effectiveMode,
    hasOtherSection,
    selection,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onExit();
      } else if (event.key === "?") {
        event.preventDefault();
        setHelpOpen((next) => !next);
      } else if (event.key === "v") {
        event.preventDefault();
        setMode((next) =>
          next === "by_criterion" ? "by_file" : "by_criterion",
        );
      } else if (event.key === "s") {
        event.preventDefault();
        setSpecOpen((next) => !next);
      } else if (event.key === "r" && reviewSectionIds.includes(selection)) {
        event.preventDefault();
        toggleReviewed(selection, currentRevisionKey, setReviewed);
      } else if (/^[1-9]$/.test(event.key)) {
        const next = criterionItems[Number(event.key) - 1];
        if (next) {
          event.preventDefault();
          setSelection(next.id);
          setMode("by_criterion");
        }
      } else if (event.key === "0" && hasOtherSection) {
        event.preventDefault();
        setSelection("other");
        setMode("by_criterion");
      } else if (event.key === "Enter" && task.status === "approved") {
        event.preventDefault();
        setLandOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    criterionItems,
    currentRevisionKey,
    hasOtherSection,
    onExit,
    reviewSectionIds,
    selection,
    task.status,
  ]);

  const selectedItem =
    criterionItems.find((item) => item.id === selection) ??
    criterionItems[0] ??
    null;
  const selectedFiles = useMemo(() => {
    if (!diff) return [];
    if (effectiveMode === "by_file") return diff.files;
    if (selection === "other")
      return filesForHunkRefs(diff, hunkRefsForUnmapped(unmapped));
    if (!selectedItem) return [];
    return filesForHunkRefs(diff, selectedItem.hunkRefs);
  }, [diff, effectiveMode, selectedItem, selection, unmapped]);

  const reviewedCount = reviewSectionIds.filter((id) =>
    reviewed.has(id),
  ).length;
  const primary = primaryAction(reviewState);

  return (
    <div className="bg-background text-foreground fixed inset-x-0 top-9 bottom-0 z-50 flex min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onExit}
          className="h-8 gap-1.5"
        >
          <ArrowLeft className="size-4" />
          Exit
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{task.title}</div>
          <div className="text-muted-foreground text-[11px]">
            Reviewed {reviewedCount} of {reviewSectionIds.length || 0} sections
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => setHelpOpen(true)}
        >
          <Keyboard className="size-4" />
          Shortcuts
        </Button>
        {primary === "catch_up" ? (
          <Button
            variant={"outline"}
            type="button"
            size="sm"
            onClick={() => catchUp.mutate(task.id)}
            disabled={catchUp.isPending}
          >
            Catch up
          </Button>
        ) : primary === "land" ? (
          <Button type="button" size="sm" onClick={() => setLandOpen(true)}>
            Land
          </Button>
        ) : (
          <Button
            variant={"outline"}
            type="button"
            size="sm"
            onClick={() => setPassBackOpen(true)}
          >
            Pass back
          </Button>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r bg-muted/15">
          <div className="border-b p-2">
            <div className="inline-flex gap-1 w-full rounded-sm border bg-background p-0.5">
              <RailSegment
                active={effectiveMode === "by_criterion"}
                disabled={!hasCriterionView}
                onClick={() => setMode("by_criterion")}
              >
                By criterion
              </RailSegment>
              <RailSegment
                active={effectiveMode === "by_file"}
                onClick={() => setMode("by_file")}
              >
                By file
              </RailSegment>
            </div>
            {!hasCriterionView && (
              <p className="text-muted-foreground mt-2 text-xs">
                Acceptance-criterion view unavailable. The auditor did not
                produce a usable mapping for this proposal.
              </p>
            )}
          </div>

          {hasCriterionView && (
            <div className="scrollbar-styled min-h-0 flex-1 overflow-auto p-2">
              <div className="mb-2 px-1 text-[11px] font-medium uppercase text-muted-foreground">
                Criteria
              </div>
              <TooltipProvider delay={150}>
                <div className="space-y-1">
                  {criterionItems.map((item) => (
                    <CriterionRow
                      key={item.id}
                      item={item}
                      selected={
                        effectiveMode === "by_criterion" &&
                        selection === item.id
                      }
                      reviewed={reviewed.has(item.id)}
                      onSelect={() => {
                        setSelection(item.id);
                        setMode("by_criterion");
                      }}
                      onToggleReviewed={() =>
                        toggleReviewed(item.id, currentRevisionKey, setReviewed)
                      }
                    />
                  ))}
                </div>
                {hasOtherSection && (
                  <OtherChangesRow
                    count={unmapped?.length ?? 0}
                    selected={
                      selection === "other" && effectiveMode === "by_criterion"
                    }
                    reviewed={reviewed.has("other")}
                    onSelect={() => {
                      setSelection("other");
                      setMode("by_criterion");
                    }}
                    onToggleReviewed={() =>
                      toggleReviewed("other", currentRevisionKey, setReviewed)
                    }
                  />
                )}
              </TooltipProvider>
            </div>
          )}

          <div className="space-y-2 border-t p-2">
            <ReferencePanel
              title="Spec"
              open={specOpen}
              onOpenChange={setSpecOpen}
            >
              <Markdown className="text-xs">{task.spec_markdown}</Markdown>
            </ReferencePanel>
            <ReferencePanel
              title="Verdict"
              open={verdictOpen}
              onOpenChange={setVerdictOpen}
            >
              <p className="text-xs text-muted-foreground">
                {verdict?.summary ?? "No verdict yet."}
              </p>
            </ReferencePanel>
          </div>
        </aside>

        <main className="scrollbar-styled min-h-0 overflow-auto">
          <div className="mx-auto max-w-[1180px] space-y-4 p-5">
            {(!diffEnabled || diffQ.isLoading) && (
              <p className="text-sm text-muted-foreground">Loading proposal…</p>
            )}
            {diffQ.error && (
              <p className="rounded-sm border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                Could not load proposal: {String(diffQ.error)}
              </p>
            )}
            {diff && selectedFiles.length === 0 && (
              <div className="rounded-sm border border-dashed p-8 text-center text-sm text-muted-foreground">
                No mapped changes in this view.
              </div>
            )}
            {diff && selectedFiles.length > 0 && (
              <>
                {!verdict && (
                  <div className="border-border bg-muted/20 rounded-sm border px-3 py-2 text-xs text-muted-foreground">
                    Criterion review will appear after the auditor finishes. For
                    now, you can inspect the proposal by file.
                  </div>
                )}
                <ReviewHeading
                  mode={effectiveMode}
                  selectedItem={selection === "other" ? null : selectedItem}
                  unmapped={selection === "other" ? unmapped : undefined}
                />
                <div className="space-y-4">
                  {selectedFiles.map((file) => (
                    <ReviewFile
                      key={`${file.old_path ?? ""}:${file.path}`}
                      file={file}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      {helpOpen && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}
      <MergeDialog
        taskId={task.id}
        taskTitle={task.title}
        open={landOpen}
        onOpenChange={setLandOpen}
      />
      <PassBackDialog
        taskId={task.id}
        open={passBackOpen}
        onOpenChange={setPassBackOpen}
      />
    </div>
  );
}

function RailSegment({
  active,
  disabled,
  children,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant={active ? "secondary" : "ghost"}
      disabled={disabled}
      className="flex-1 text-xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function CriterionRow({
  item,
  selected,
  reviewed,
  onSelect,
  onToggleReviewed,
}: {
  item: CriterionReviewItem;
  selected: boolean;
  reviewed: boolean;
  onSelect: () => void;
  onToggleReviewed: () => void;
}) {
  const Icon = item.mapping === null ? Circle : item.satisfied ? Check : X;
  return (
    <div
      role="button"
      tabIndex={0}
      title={item.title}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-sm border-l-[3px] px-2 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-l-primary bg-primary/10 text-foreground"
          : "border-l-transparent hover:border-l-primary/40 hover:bg-muted/70",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {item.index}. {item.title}
        </span>
        {item.notes && (
          <span className="mt-1 block truncate text-[11px] text-muted-foreground">
            {item.notes}
          </span>
        )}
      </span>
      <ReviewedToggle
        reviewed={reviewed}
        reviewedLabel="Reviewed. Click or press r to mark unreviewed."
        unreviewedLabel="Not yet reviewed. Scroll all hunks or press r to mark reviewed."
        ariaLabel={
          reviewed ? "Mark criterion unreviewed" : "Mark criterion reviewed"
        }
        onToggle={onToggleReviewed}
      />
    </div>
  );
}

function OtherChangesRow({
  count,
  selected,
  reviewed,
  onSelect,
  onToggleReviewed,
}: {
  count: number;
  selected: boolean;
  reviewed: boolean;
  onSelect: () => void;
  onToggleReviewed: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "mt-4 flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm border-l-[3px] px-2 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-l-primary bg-primary/10 text-foreground"
          : "border-l-transparent hover:border-l-primary/40 hover:bg-muted/70",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Warning className="size-4 shrink-0" />
        <span className="truncate">Other changes</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Badge variant="outline" className="rounded-sm text-[10px]">
          {count} items
        </Badge>
        <ReviewedToggle
          reviewed={reviewed}
          reviewedLabel="Reviewed. Click or press r to mark unreviewed."
          unreviewedLabel="Not yet reviewed. Review unmapped changes or press r to mark reviewed."
          ariaLabel={
            reviewed
              ? "Mark other changes unreviewed"
              : "Mark other changes reviewed"
          }
          onToggle={onToggleReviewed}
        />
      </span>
    </div>
  );
}

function ReviewedToggle({
  reviewed,
  reviewedLabel,
  unreviewedLabel,
  ariaLabel,
  onToggle,
}: {
  reviewed: boolean;
  reviewedLabel: string;
  unreviewedLabel: string;
  ariaLabel: string;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className={cn(
              "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              reviewed
                ? "border-primary text-primary"
                : "border-muted-foreground/40 text-muted-foreground hover:border-primary/60 hover:text-foreground",
            )}
            aria-label={ariaLabel}
          >
            {reviewed ? (
              <Check className="size-3.5" />
            ) : (
              <span className="size-1.5 rounded-full bg-current" />
            )}
          </button>
        )}
      />
      <TooltipContent side="right" className="text-[11px]">
        {reviewed ? reviewedLabel : unreviewedLabel}
      </TooltipContent>
    </Tooltip>
  );
}

function ReviewHeading({
  mode,
  selectedItem,
  unmapped,
}: {
  mode: ReviewMode;
  selectedItem: CriterionReviewItem | null;
  unmapped?: AuditorUnmappedHunk[];
}) {
  if (mode === "by_file") {
    return <h2 className="text-base font-medium">All proposal changes</h2>;
  }
  if (unmapped) {
    return (
      <div>
        <h2 className="text-base font-medium">Other changes</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Unmapped work grouped outside the acceptance criteria.
        </p>
      </div>
    );
  }
  return (
    <div>
      <h2 className="text-base font-medium">
        {selectedItem?.title ?? "Criterion"}
      </h2>
      {selectedItem?.notes && (
        <p className="mt-1 text-xs text-muted-foreground">
          {selectedItem.notes}
        </p>
      )}
    </div>
  );
}

function ReviewFile({ file }: { file: HighlightedDiffFile }) {
  const [showFull, setShowFull] = useState(false);
  const lines = useMemo(
    () => buildReviewLines(file, showFull),
    [file, showFull],
  );
  const changeCount = file.hunks.reduce(
    (sum, hunk) =>
      sum + hunk.lines.filter((line) => line.kind !== "context").length,
    0,
  );

  return (
    <section className="overflow-hidden rounded-sm border bg-background">
      <header className="flex items-center gap-3 border-b bg-muted/20 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {file.path}
        </code>
        <Badge variant="outline" className="rounded-sm text-[10px]">
          {file.status}
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">
          +{file.additions} -{file.deletions}
        </span>
        <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
          <ArrowUp className="size-3" />
          <ArrowDown className="size-3" />
          {changeCount} changes
        </span>
        {(file.new_lines_html?.length ?? 0) > LONG_FILE_LINE_THRESHOLD && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-sm px-2 text-xs"
            onClick={() => setShowFull((next) => !next)}
          >
            {showFull ? "Collapse context" : "Show full file"}
          </Button>
        )}
      </header>
      {file.is_binary ? (
        <div className="p-4 text-sm text-muted-foreground">
          Binary file changed.
        </div>
      ) : (
        <div className="overflow-x-auto py-1">
          {lines.map((line, index) =>
            line.kind === "gap" ? (
              <button
                key={line.key}
                type="button"
                className="grid w-full grid-cols-[64px_minmax(0,1fr)] bg-muted/20 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setShowFull(true)}
              >
                <span />
                <span className="px-3 py-1 text-left">
                  <span className="mr-1 text-foreground/50">›</span>+
                  {line.count} lines
                </span>
              </button>
            ) : (
              <ReviewCodeLine
                key={`${line.kind}:${line.lineNumber ?? "x"}:${index}`}
                line={line}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function ReviewCodeLine({
  line,
}: {
  line: Exclude<ReviewLine, { kind: "gap" }>;
}) {
  if (line.kind === "removed") {
    return (
      <div className="grid grid-cols-[64px_minmax(0,1fr)] font-mono text-[11px] leading-5 opacity-25 transition-opacity hover:opacity-55">
        <span className="select-none border-r px-2 text-right text-muted-foreground/60">
          {line.lineNumber ?? ""}
        </span>
        <span
          className="whitespace-pre px-3 line-through"
          dangerouslySetInnerHTML={{ __html: line.html || " " }}
        />
      </div>
    );
  }

  return (
    <div className="group">
      <div
        className={cn(
          "grid grid-cols-[64px_minmax(0,1fr)] font-mono text-[11px] leading-5 transition-opacity",
          line.changed
            ? "text-foreground opacity-100"
            : "opacity-30 hover:opacity-70 focus-within:opacity-70",
        )}
      >
        <span className="select-none border-r px-2 text-right text-muted-foreground/60">
          {line.lineNumber ?? ""}
          {line.modified && (
            <span className="ml-1 rounded-[2px] border border-primary/50 px-1 text-[9px] font-medium text-primary">
              M
            </span>
          )}
        </span>
        <span
          className="whitespace-pre px-3"
          dangerouslySetInnerHTML={{ __html: line.html || " " }}
        />
      </div>
      {line.modified && line.previousHtml != null && (
        <div className="hidden grid-cols-[64px_minmax(0,1fr)] font-mono text-[11px] leading-5 opacity-25 group-hover:grid group-focus-within:grid">
          <span className="select-none border-r px-2 text-right text-muted-foreground/60">
            {line.previousLineNumber ?? ""}
          </span>
          <span
            className="whitespace-pre px-3 line-through"
            dangerouslySetInnerHTML={{ __html: line.previousHtml || " " }}
          />
        </div>
      )}
    </div>
  );
}

function buildReviewLines(
  file: HighlightedDiffFile,
  showFull: boolean,
): ReviewLine[] {
  const newLines = file.new_lines_html ?? [];
  const changed = new Set<number>();
  const modifiedByLine = new Map<
    number,
    { html: string; lineNumber: number | null }
  >();
  const pairedRemoved = new Set<string>();
  const removedByPosition = new Map<
    number,
    { html: string; lineNumber: number | null; key: string }[]
  >();

  file.hunks.forEach((hunk, hunkIndex) => {
    const pendingRemoved: {
      html: string;
      lineNumber: number | null;
      key: string;
    }[] = [];
    hunk.lines.forEach((line, lineIndex) => {
      const key = `${hunkIndex}:${lineIndex}`;
      if (line.kind === "removed") {
        pendingRemoved.push({
          html: line.html,
          lineNumber: line.old_lineno,
          key,
        });
        return;
      }
      if (line.kind === "added" && line.new_lineno != null) {
        changed.add(line.new_lineno);
        const previous = pendingRemoved.shift();
        if (previous) {
          modifiedByLine.set(line.new_lineno, previous);
          pairedRemoved.add(previous.key);
        }
        return;
      }
      if (line.kind === "context") {
        pendingRemoved.length = 0;
      }
    });
  });

  file.hunks.forEach((hunk, hunkIndex) => {
    let insertionPoint = hunk.new_start;
    hunk.lines.forEach((line, lineIndex) => {
      const key = `${hunkIndex}:${lineIndex}`;
      if (line.kind === "added" && line.new_lineno != null) {
        insertionPoint = line.new_lineno;
      } else if (line.kind === "context" && line.new_lineno != null) {
        insertionPoint = line.new_lineno;
      } else if (line.kind === "removed" && !pairedRemoved.has(key)) {
        const bucket = removedByPosition.get(insertionPoint) ?? [];
        bucket.push({ html: line.html, lineNumber: line.old_lineno, key });
        removedByPosition.set(insertionPoint, bucket);
      }
    });
  });

  const visible =
    showFull || newLines.length <= LONG_FILE_LINE_THRESHOLD
      ? null
      : visibleLineSet(newLines.length, changed);

  const out: ReviewLine[] = [];
  let hiddenCount = 0;
  let hiddenStart = 0;
  const flushGap = (line: number) => {
    if (hiddenCount > 0) {
      out.push({
        kind: "gap",
        count: hiddenCount,
        key: `${hiddenStart}:${line}`,
      });
      hiddenCount = 0;
    }
  };

  for (let i = 0; i < newLines.length; i += 1) {
    const lineNumber = i + 1;
    const isVisible = visible === null || visible.has(lineNumber);
    if (!isVisible) {
      if (hiddenCount === 0) hiddenStart = lineNumber;
      hiddenCount += 1;
      continue;
    }
    flushGap(lineNumber);
    for (const removed of removedByPosition.get(lineNumber - 1) ?? []) {
      out.push({
        kind: "removed",
        html: removed.html,
        lineNumber: removed.lineNumber,
      });
    }
    out.push({
      kind: "line",
      lineNumber,
      html: newLines[i] ?? "",
      changed: changed.has(lineNumber),
      added: changed.has(lineNumber),
      modified: modifiedByLine.has(lineNumber),
      previousHtml: modifiedByLine.get(lineNumber)?.html,
      previousLineNumber: modifiedByLine.get(lineNumber)?.lineNumber,
    });
  }
  flushGap(newLines.length + 1);
  for (const removed of removedByPosition.get(newLines.length) ?? []) {
    out.push({
      kind: "removed",
      html: removed.html,
      lineNumber: removed.lineNumber,
    });
  }
  return out;
}

function visibleLineSet(lineCount: number, changed: Set<number>) {
  const visible = new Set<number>();
  for (const line of changed) {
    const start = Math.max(1, line - CONTEXT_LINES);
    const end = Math.min(lineCount, line + CONTEXT_LINES);
    for (let n = start; n <= end; n += 1) visible.add(n);
  }
  return visible;
}

function ReferencePanel({
  title,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-sm border bg-background">
      <button
        type="button"
        className="flex w-full items-center justify-between px-2 py-1.5 text-xs font-medium"
        onClick={() => onOpenChange(!open)}
      >
        {title}
        <span className="text-muted-foreground">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="max-h-56 overflow-auto border-t p-2">{children}</div>
      )}
    </div>
  );
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    ["1-9", "Jump to criterion"],
    ["0", "Open other changes"],
    ["v", "Toggle view mode"],
    ["r", "Toggle reviewed"],
    ["s", "Toggle spec"],
    ["Esc", "Exit review"],
  ];
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-sm border bg-background p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">Shortcuts</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
        <div className="space-y-2">
          {shortcuts.map(([key, label]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <span className="text-muted-foreground">{label}</span>
              <kbd className="rounded-sm border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function primaryAction(reviewState: string) {
  if (reviewState === "needs_catch_up") return "catch_up";
  if (reviewState === "ready_to_land") return "land";
  return "pass_back";
}

function reviewStorageKey(key: string) {
  return `orca:proposal-review:${key}`;
}

function toggleReviewed(
  criterionId: string,
  currentRevisionKey: string | null,
  setReviewed: Dispatch<SetStateAction<Set<string>>>,
) {
  if (!currentRevisionKey) return;
  setReviewed((prev) => {
    const next = new Set(prev);
    if (next.has(criterionId)) {
      next.delete(criterionId);
    } else {
      next.add(criterionId);
    }
    window.localStorage.setItem(
      reviewStorageKey(currentRevisionKey),
      JSON.stringify([...next]),
    );
    return next;
  });
}
