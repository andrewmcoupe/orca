import { useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import { deriveTaskReviewState } from "@/features/tasks/task-domain";
import type { Task } from "@/features/tasks/types";
import { useCatchUpTask } from "@/features/tasks/hooks";
import { MergeDialog } from "@/features/tasks/components/merge-dialog";
import { PassBackDialog } from "@/features/tasks/components/pass-back-dialog";
import { usePhaseRuns } from "@/features/phase-runs/hooks";
import { useTaskDiff, useTaskDiffLiveUpdates } from "./hooks";
import type {
  AuditorCriterionMapping,
  AuditorUnmappedHunk,
  HighlightedDiffFile,
} from "./types";
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
  const mappings = verdict?.criterion_mappings as AuditorCriterionMapping[] | undefined;
  const unmapped = verdict?.unmapped_hunks as AuditorUnmappedHunk[] | undefined;
  const criteria = useMemo(
    () => parseAcceptanceCriteria(task.spec_markdown),
    [task.spec_markdown],
  );
  const criterionItems = useMemo(
    () => buildCriterionReviewItems(criteria, mappings),
    [criteria, mappings],
  );
  const hasCriterionView = criteria.length > 0 && hasUsableCriterionMapping(criterionItems);
  const effectiveMode = hasCriterionView ? mode : "by_file";
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
    const raw = window.localStorage.getItem(reviewStorageKey(currentRevisionKey));
    setReviewed(new Set(raw ? JSON.parse(raw) : []));
  }, [currentRevisionKey]);

  useEffect(() => {
    if (!currentRevisionKey || effectiveMode !== "by_criterion" || selection === "other") return;
    const timer = window.setTimeout(() => {
      setReviewed((prev) => {
        if (prev.has(selection)) return prev;
        const next = new Set(prev);
        next.add(selection);
        window.localStorage.setItem(reviewStorageKey(currentRevisionKey), JSON.stringify([...next]));
        return next;
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [currentRevisionKey, effectiveMode, selection]);

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
        setMode((next) => (next === "by_criterion" ? "by_file" : "by_criterion"));
      } else if (event.key === "s") {
        event.preventDefault();
        setSpecOpen((next) => !next);
      } else if (event.key === "r" && selection !== "other") {
        event.preventDefault();
        toggleReviewed(selection, currentRevisionKey, setReviewed);
      } else if (/^[1-9]$/.test(event.key)) {
        const next = criterionItems[Number(event.key) - 1];
        if (next) {
          event.preventDefault();
          setSelection(next.id);
          setMode("by_criterion");
        }
      } else if (event.key === "0" && (unmapped?.length ?? 0) > 0) {
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
  }, [criterionItems, currentRevisionKey, onExit, selection, task.status, unmapped?.length]);

  const selectedItem = criterionItems.find((item) => item.id === selection) ?? criterionItems[0] ?? null;
  const selectedFiles = useMemo(() => {
    if (!diff) return [];
    if (effectiveMode === "by_file") return diff.files;
    if (selection === "other") return filesForHunkRefs(diff, hunkRefsForUnmapped(unmapped));
    if (!selectedItem) return [];
    return filesForHunkRefs(diff, selectedItem.hunkRefs);
  }, [diff, effectiveMode, selectedItem, selection, unmapped]);

  const reviewedCount = criterionItems.filter((item) => reviewed.has(item.id)).length;
  const primary = primaryAction(reviewState);

  return (
    <div className="bg-background text-foreground fixed inset-x-0 top-9 bottom-0 z-50 flex min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button type="button" variant="ghost" size="sm" onClick={onExit} className="h-8 gap-1.5">
          <ArrowLeft className="size-4" />
          Exit
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{task.title}</div>
          <div className="text-muted-foreground text-[11px]">
            Reviewed {reviewedCount} of {criterionItems.length || 0} criteria
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => setHelpOpen(true)}>
          <Keyboard className="size-4" />
          Shortcuts
        </Button>
        {primary === "catch_up" ? (
          <Button type="button" size="sm" onClick={() => catchUp.mutate(task.id)} disabled={catchUp.isPending}>
            Catch up
          </Button>
        ) : primary === "land" ? (
          <Button type="button" size="sm" onClick={() => setLandOpen(true)}>
            Land
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={() => setPassBackOpen(true)}>
            Pass back
          </Button>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r bg-muted/15">
          <div className="border-b p-2">
            <div className="inline-flex w-full rounded-sm border bg-background p-0.5">
              <RailSegment active={effectiveMode === "by_criterion"} disabled={!hasCriterionView} onClick={() => setMode("by_criterion")}>
                By criterion
              </RailSegment>
              <RailSegment active={effectiveMode === "by_file"} onClick={() => setMode("by_file")}>
                By file
              </RailSegment>
            </div>
            {!hasCriterionView && (
              <p className="text-muted-foreground mt-2 text-xs">
                Acceptance-criterion view unavailable. The auditor did not produce a usable mapping for this proposal.
              </p>
            )}
          </div>

          {hasCriterionView && (
            <div className="scrollbar-styled min-h-0 flex-1 overflow-auto p-2">
              <div className="mb-2 px-1 text-[11px] font-medium uppercase text-muted-foreground">
                Criteria
              </div>
              <div className="space-y-1">
                {criterionItems.map((item) => (
                  <CriterionRow
                    key={item.id}
                    item={item}
                    selected={effectiveMode === "by_criterion" && selection === item.id}
                    reviewed={reviewed.has(item.id)}
                    onSelect={() => {
                      setSelection(item.id);
                      setMode("by_criterion");
                    }}
                    onToggleReviewed={() => toggleReviewed(item.id, currentRevisionKey, setReviewed)}
                  />
                ))}
              </div>
              {(unmapped?.length ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSelection("other");
                    setMode("by_criterion");
                  }}
                  className={cn(
                    "mt-4 flex w-full items-center justify-between rounded-sm px-2 py-2 text-left text-sm",
                    selection === "other" && effectiveMode === "by_criterion"
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Warning className="size-4" />
                    Other changes
                  </span>
                  <Badge variant="outline" className="rounded-sm text-[10px]">
                    {unmapped?.length} items
                  </Badge>
                </button>
              )}
            </div>
          )}

          <div className="space-y-2 border-t p-2">
            <ReferencePanel title="Spec" open={specOpen} onOpenChange={setSpecOpen}>
              <Markdown className="text-xs">{task.spec_markdown}</Markdown>
            </ReferencePanel>
            <ReferencePanel title="Verdict" open={verdictOpen} onOpenChange={setVerdictOpen}>
              <p className="text-xs text-muted-foreground">{verdict?.summary ?? "No verdict yet."}</p>
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
                    Criterion review will appear after the auditor finishes.
                    For now, you can inspect the proposal by file.
                  </div>
                )}
                <ReviewHeading
                  mode={effectiveMode}
                  selectedItem={selection === "other" ? null : selectedItem}
                  unmapped={selection === "other" ? unmapped : undefined}
                />
                <div className="space-y-4">
                  {selectedFiles.map((file) => (
                    <ReviewFile key={`${file.old_path ?? ""}:${file.path}`} file={file} />
                  ))}
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      {helpOpen && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}
      <MergeDialog taskId={task.id} taskTitle={task.title} open={landOpen} onOpenChange={setLandOpen} />
      <PassBackDialog taskId={task.id} open={passBackOpen} onOpenChange={setPassBackOpen} />
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
      size="sm"
      variant={active ? "secondary" : "ghost"}
      disabled={disabled}
      className="h-7 flex-1 rounded-sm px-2 text-xs"
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
    <button
      type="button"
      title={item.title}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left text-sm",
        selected ? "bg-primary/10 text-primary" : "hover:bg-muted",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.index}. {item.title}</span>
        {item.notes && <span className="mt-1 block truncate text-[11px] text-muted-foreground">{item.notes}</span>}
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          onToggleReviewed();
        }}
        className={cn(
          "mt-0.5 size-3 rounded-full border",
          reviewed ? "border-primary bg-primary" : "border-muted-foreground/40",
        )}
        aria-label={reviewed ? "Mark criterion unreviewed" : "Mark criterion reviewed"}
      />
    </button>
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
      <h2 className="text-base font-medium">{selectedItem?.title ?? "Criterion"}</h2>
      {selectedItem?.notes && <p className="mt-1 text-xs text-muted-foreground">{selectedItem.notes}</p>}
    </div>
  );
}

function ReviewFile({ file }: { file: HighlightedDiffFile }) {
  const [showFull, setShowFull] = useState(false);
  const lines = useMemo(() => buildReviewLines(file, showFull), [file, showFull]);
  const changeCount = file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind !== "context").length, 0);

  return (
    <section className="overflow-hidden rounded-sm border bg-background">
      <header className="flex items-center gap-3 border-b bg-muted/20 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</code>
        <Badge variant="outline" className="rounded-sm text-[10px]">{file.status}</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">+{file.additions} -{file.deletions}</span>
        <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
          <ArrowUp className="size-3" />
          <ArrowDown className="size-3" />
          {changeCount} changes
        </span>
        {(file.new_lines_html?.length ?? 0) > LONG_FILE_LINE_THRESHOLD && (
          <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-xs" onClick={() => setShowFull((next) => !next)}>
            {showFull ? "Collapse context" : "Show full file"}
          </Button>
        )}
      </header>
      {file.is_binary ? (
        <div className="p-4 text-sm text-muted-foreground">Binary file changed.</div>
      ) : (
        <div className="overflow-x-auto py-1">
          {lines.map((line, index) =>
            line.kind === "gap" ? (
              <button
                key={line.key}
                type="button"
                className="grid w-full grid-cols-[64px_minmax(0,1fr)] bg-muted/20 font-mono text-[11px] text-muted-foreground hover:bg-muted/40"
                onClick={() => setShowFull(true)}
              >
                <span />
                <span className="px-3 py-1 text-left">+{line.count} lines</span>
              </button>
            ) : (
              <div
                key={`${line.kind}:${line.lineNumber ?? "x"}:${index}`}
                className={cn(
                  "grid grid-cols-[64px_minmax(0,1fr)] font-mono text-[11px] leading-5",
                  line.kind === "removed" && "bg-red-500/5 text-muted-foreground/60 line-through",
                  line.kind === "line" && line.added && "border-l-2 border-l-emerald-500/60 bg-emerald-500/5",
                  line.kind === "line" && !line.changed && "opacity-35 hover:opacity-100 focus-within:opacity-100",
                )}
              >
                <span className="select-none border-r px-2 text-right text-muted-foreground/60">
                  {line.lineNumber ?? ""}
                </span>
                <span className="whitespace-pre px-3" dangerouslySetInnerHTML={{ __html: line.html || " " }} />
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function buildReviewLines(file: HighlightedDiffFile, showFull: boolean): ReviewLine[] {
  const newLines = file.new_lines_html ?? [];
  const changed = new Set<number>();
  const removedByPosition = new Map<number, { html: string; lineNumber: number | null }[]>();

  for (const hunk of file.hunks) {
    let insertionPoint = hunk.new_start;
    for (const line of hunk.lines) {
      if (line.kind === "added" && line.new_lineno != null) {
        changed.add(line.new_lineno);
        insertionPoint = line.new_lineno;
      } else if (line.kind === "context" && line.new_lineno != null) {
        insertionPoint = line.new_lineno;
      } else if (line.kind === "removed") {
        const bucket = removedByPosition.get(insertionPoint) ?? [];
        bucket.push({ html: line.html, lineNumber: line.old_lineno });
        removedByPosition.set(insertionPoint, bucket);
      }
    }
  }

  const visible = showFull || newLines.length <= LONG_FILE_LINE_THRESHOLD
    ? null
    : visibleLineSet(newLines.length, changed);

  const out: ReviewLine[] = [];
  let hiddenCount = 0;
  let hiddenStart = 0;
  const flushGap = (line: number) => {
    if (hiddenCount > 0) {
      out.push({ kind: "gap", count: hiddenCount, key: `${hiddenStart}:${line}` });
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
      out.push({ kind: "removed", ...removed });
    }
    out.push({
      kind: "line",
      lineNumber,
      html: newLines[i] ?? "",
      changed: changed.has(lineNumber),
      added: changed.has(lineNumber),
    });
  }
  flushGap(newLines.length + 1);
  for (const removed of removedByPosition.get(newLines.length) ?? []) {
    out.push({ kind: "removed", ...removed });
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
      {open && <div className="max-h-56 overflow-auto border-t p-2">{children}</div>}
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
    ["Enter", "Open land dialog"],
    ["Esc", "Exit review"],
  ];
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-sm border bg-background p-4 shadow-lg" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">Shortcuts</h2>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onClose}>Close</Button>
        </div>
        <div className="space-y-2">
          {shortcuts.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">{label}</span>
              <kbd className="rounded-sm border bg-muted px-1.5 py-0.5 font-mono text-[11px]">{key}</kbd>
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
    window.localStorage.setItem(reviewStorageKey(currentRevisionKey), JSON.stringify([...next]));
    return next;
  });
}
