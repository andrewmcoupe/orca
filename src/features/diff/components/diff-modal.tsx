import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { SidebarSimple, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTaskDiff, useTaskDiffLiveUpdates } from "../hooks";
import type {
  AnchorMapping,
  HighlightedDiffFile,
  HighlightedDiffLine,
  MappedConcern,
  TaskDiffWithMappings,
} from "../types";

type ViewMode = "split" | "unified";

const viewModeKey = (workspaceId: string) =>
  `diff-modal-view-mode:${workspaceId}`;
const railKey = (workspaceId: string) => `diff-modal-rail:${workspaceId}`;

const SEVERITY_BAR: Record<string, string> = {
  blocking: "bg-red-500",
  advisory: "bg-amber-500",
};

type Props = {
  workspaceId: string;
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the modal scrolls to and pulses the concern at this index after
   *  opening. The parent should bump this each time it requests an open. */
  initialConcernIndex?: number;
};

export function DiffModal({
  workspaceId,
  taskId,
  open,
  onOpenChange,
  initialConcernIndex,
}: Props) {
  const diffQ = useTaskDiff(taskId);
  useTaskDiffLiveUpdates(taskId, !!diffQ.data?.is_live);

  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    (readString(viewModeKey(workspaceId), "split") as ViewMode) === "unified"
      ? "unified"
      : "split",
  );
  const [railOpen, setRailOpen] = useState<boolean>(() =>
    readBoolean(railKey(workspaceId), true),
  );

  const [focusedFileIdx, setFocusedFileIdx] = useState(0);
  const [focusedConcernIdx, setFocusedConcernIdx] = useState<number | null>(
    null,
  );

  // Persist the view mode + rail state per workspace.
  useEffect(() => {
    try {
      window.localStorage.setItem(viewModeKey(workspaceId), viewMode);
    } catch {
      /* ignore */
    }
  }, [workspaceId, viewMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem(railKey(workspaceId), railOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [workspaceId, railOpen]);

  // When the parent supplies an initial concern, snap to it once the diff
  // loads and the modal is open.
  const lastInitial = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!open) {
      lastInitial.current = undefined;
      return;
    }
    if (
      initialConcernIndex == null ||
      initialConcernIndex === lastInitial.current
    )
      return;
    if (!diffQ.data) return;
    lastInitial.current = initialConcernIndex;
    setFocusedConcernIdx(initialConcernIndex);
    focusFileForConcern(diffQ.data, initialConcernIndex, setFocusedFileIdx);
    // Defer the scroll until after the file content has rendered.
    window.requestAnimationFrame(() => {
      scrollToConcern(initialConcernIndex);
    });
  }, [open, initialConcernIndex, diffQ.data]);

  // Global cmd+shift+D toggle. Listens at the window level so it works whether
  // or not the modal currently has focus.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const key = ev.key.toLowerCase();
      if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && key === "d") {
        ev.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className={cn(
            "bg-background fixed left-1/2 top-1/2 z-50 flex h-[90vh] w-[92vw] max-w-[1600px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden border outline-none",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0",
          )}
        >
          <ModalHeader
            data={diffQ.data}
            taskTitle={undefined}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            railOpen={railOpen}
            onRailToggle={() => setRailOpen((o) => !o)}
            onClose={() => onOpenChange(false)}
          />
          <ModalKeyboardLayer
            data={diffQ.data}
            focusedFileIdx={focusedFileIdx}
            setFocusedFileIdx={setFocusedFileIdx}
            focusedConcernIdx={focusedConcernIdx}
            setFocusedConcernIdx={setFocusedConcernIdx}
            onClose={() => onOpenChange(false)}
          >
            <div className="flex min-h-0 flex-1">
              <FileTree
                files={diffQ.data?.diff.files ?? []}
                concerns={diffQ.data?.mapped_concerns ?? []}
                focusedIdx={focusedFileIdx}
                onFocus={setFocusedFileIdx}
              />
              <main className="flex min-w-0 flex-1 flex-col">
                {diffQ.isLoading || !diffQ.data ? (
                  <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
                    Loading diff…
                  </div>
                ) : diffQ.data.diff.files.length === 0 ? (
                  <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
                    No changes.
                  </div>
                ) : (
                  <DiffArea
                    file={diffQ.data.diff.files[focusedFileIdx]}
                    fileIndex={focusedFileIdx}
                    concerns={diffQ.data.mapped_concerns}
                    viewMode={viewMode}
                  />
                )}
              </main>
              {railOpen && diffQ.data && (
                <ConcernsRail
                  data={diffQ.data}
                  focusedConcernIdx={focusedConcernIdx}
                  onSelect={(idx) => {
                    setFocusedConcernIdx(idx);
                    focusFileForConcern(diffQ.data!, idx, setFocusedFileIdx);
                    window.requestAnimationFrame(() => scrollToConcern(idx));
                  }}
                />
              )}
            </div>
          </ModalKeyboardLayer>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ModalHeader({
  data,
  taskTitle,
  viewMode,
  onViewModeChange,
  railOpen,
  onRailToggle,
  onClose,
}: {
  data: TaskDiffWithMappings | undefined;
  taskTitle: string | undefined;
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  railOpen: boolean;
  onRailToggle: () => void;
  onClose: () => void;
}) {
  const base = data?.diff.base_commit?.slice(0, 7) ?? "—";
  const head = data?.diff.head_commit?.slice(0, 7) ?? "—";
  return (
    <div className="bg-background flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <DialogPrimitive.Title className="text-[11px] font-medium uppercase tracking-[0.08em]">
        Review diff
      </DialogPrimitive.Title>
      {taskTitle && (
        <span className="text-muted-foreground truncate text-xs">
          · {taskTitle}
        </span>
      )}
      <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
        {base} … {head}
      </span>
      <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
        <span className="text-emerald-500">+{data?.diff.additions ?? 0}</span>{" "}
        <span className="text-red-500">−{data?.diff.deletions ?? 0}</span>
      </span>
      <div className="ml-auto flex items-center gap-1">
        <ViewModeToggle value={viewMode} onChange={onViewModeChange} />
        <Button
          size="xs"
          variant="ghost"
          title={railOpen ? "Hide concerns rail" : "Show concerns rail"}
          onClick={onRailToggle}
          className="size-6 p-0"
        >
          <SidebarSimple
            className={cn("size-3.5", railOpen && "rotate-180")}
          />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          title="Close"
          onClick={onClose}
          className="size-6 p-0"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ViewModeToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  return (
    <div className="border flex h-6 overflow-hidden rounded-none">
      {(["split", "unified"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "px-2 text-[10px] uppercase tracking-[0.08em]",
            value === m
              ? "bg-foreground text-background"
              : "bg-background text-muted-foreground hover:bg-muted/40",
          )}
        >
          {m === "split" ? "Side" : "Unified"}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keyboard layer
// ---------------------------------------------------------------------------

function ModalKeyboardLayer({
  data,
  focusedFileIdx,
  setFocusedFileIdx,
  focusedConcernIdx,
  setFocusedConcernIdx,
  onClose,
  children,
}: {
  data: TaskDiffWithMappings | undefined;
  focusedFileIdx: number;
  setFocusedFileIdx: (n: number) => void;
  focusedConcernIdx: number | null;
  setFocusedConcernIdx: (n: number | null) => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (!data) return;
      const concernCount = data.mapped_concerns.length;
      const fileCount = data.diff.files.length;
      const key = e.key;

      if (key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      // j / down: next concern. k / up: previous.
      if (concernCount > 0 && (key === "j" || key === "ArrowDown")) {
        e.preventDefault();
        const next =
          focusedConcernIdx == null
            ? 0
            : Math.min(concernCount - 1, focusedConcernIdx + 1);
        setFocusedConcernIdx(next);
        focusFileForConcern(data, next, setFocusedFileIdx);
        window.requestAnimationFrame(() => scrollToConcern(next));
        return;
      }
      if (concernCount > 0 && (key === "k" || key === "ArrowUp")) {
        e.preventDefault();
        const prev =
          focusedConcernIdx == null
            ? 0
            : Math.max(0, focusedConcernIdx - 1);
        setFocusedConcernIdx(prev);
        focusFileForConcern(data, prev, setFocusedFileIdx);
        window.requestAnimationFrame(() => scrollToConcern(prev));
        return;
      }

      // Tab / Shift+Tab: cycle files.
      if (key === "Tab" && fileCount > 0) {
        e.preventDefault();
        const dir = e.shiftKey ? -1 : 1;
        const next = (focusedFileIdx + dir + fileCount) % fileCount;
        setFocusedFileIdx(next);
        return;
      }

      // 'e': pulse the focused concern marker (no inline popover — the rail
      // already shows the rationale). Just re-scroll + re-pulse.
      if (key === "e" && focusedConcernIdx != null) {
        e.preventDefault();
        scrollToConcern(focusedConcernIdx);
      }
    },
    [
      data,
      focusedConcernIdx,
      focusedFileIdx,
      onClose,
      setFocusedConcernIdx,
      setFocusedFileIdx,
    ],
  );

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      // The dialog autoFocuses something inside; rely on event bubbling so we
      // catch keys regardless of which sub-element has focus.
      onKeyDown={onKey}
      className="flex min-h-0 flex-1 outline-none"
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File tree (left rail)
// ---------------------------------------------------------------------------

function FileTree({
  files,
  concerns,
  focusedIdx,
  onFocus,
}: {
  files: HighlightedDiffFile[];
  concerns: MappedConcern[];
  focusedIdx: number;
  onFocus: (n: number) => void;
}) {
  // Pre-compute the highest-severity dot per file index.
  const sevByFile = new Map<number, "blocking" | "advisory">();
  for (const c of concerns) {
    const m: AnchorMapping = c.mapping;
    if (m.kind !== "on_diff_line" && m.kind !== "on_unchanged_line") continue;
    const idx = m.file_index;
    const cur = sevByFile.get(idx);
    if (c.concern.severity === "blocking") sevByFile.set(idx, "blocking");
    else if (!cur && c.concern.severity === "advisory")
      sevByFile.set(idx, "advisory");
  }

  return (
    <nav className="bg-muted/10 w-[220px] shrink-0 overflow-auto border-r">
      <div className="text-muted-foreground/80 sticky top-0 z-[1] bg-muted/10 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.06em]">
        Files ({files.length})
      </div>
      <ul>
        {files.map((f, i) => {
          const sev = sevByFile.get(i);
          return (
            <li key={`${f.path}-${i}`}>
              <button
                type="button"
                onClick={() => onFocus(i)}
                className={cn(
                  "flex w-full items-center gap-1.5 px-2.5 py-1 text-left",
                  i === focusedIdx
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:bg-muted/40",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    sev === "blocking"
                      ? "bg-red-500"
                      : sev === "advisory"
                        ? "bg-amber-500"
                        : "bg-transparent",
                  )}
                />
                <span className="truncate font-mono text-[11px]" title={f.path}>
                  {f.path}
                </span>
                <span className="ml-auto font-mono text-[9px] tabular-nums">
                  <span className="text-emerald-500">+{f.additions}</span>{" "}
                  <span className="text-red-500">−{f.deletions}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Diff area (focused file, split or unified)
// ---------------------------------------------------------------------------

function DiffArea({
  file,
  fileIndex,
  concerns,
  viewMode,
}: {
  file: HighlightedDiffFile;
  fileIndex: number;
  concerns: MappedConcern[];
  viewMode: ViewMode;
}) {
  // Concerns landing on hunk lines of *this* file.
  const onLineByKey = useMemo(() => {
    const map = new Map<string, { concern: MappedConcern; index: number }>();
    concerns.forEach((c, idx) => {
      if (c.mapping.kind !== "on_diff_line") return;
      if (c.mapping.file_index !== fileIndex) return;
      map.set(`${c.mapping.hunk_index}:${c.mapping.line_index}`, {
        concern: c,
        index: idx,
      });
    });
    return map;
  }, [concerns, fileIndex]);

  if (file.is_binary) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
        Binary file not shown.
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto text-[12px]">
      {viewMode === "unified" ? (
        <UnifiedView file={file} concerns={onLineByKey} />
      ) : (
        <SplitView file={file} concerns={onLineByKey} />
      )}
    </div>
  );
}

type LineConcern = { concern: MappedConcern; index: number };

function UnifiedView({
  file,
  concerns,
}: {
  file: HighlightedDiffFile;
  concerns: Map<string, LineConcern>;
}) {
  return (
    <div className="font-mono leading-[1.55]">
      {file.hunks.map((hunk, hi) => (
        <div key={hi}>
          {hi > 0 && <ModalHunkSeparator />}
          {hunk.header && (
            <div className="text-muted-foreground/80 bg-muted/20 px-2 py-0.5 text-[10px]">
              @@ {hunk.header} @@
            </div>
          )}
          {hunk.lines.map((line, li) => (
            <ModalDiffLine
              key={li}
              line={line}
              concern={concerns.get(`${hi}:${li}`)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ModalDiffLine({
  line,
  concern,
}: {
  line: HighlightedDiffLine;
  concern?: LineConcern;
}) {
  const bg =
    line.kind === "added"
      ? "bg-emerald-500/8"
      : line.kind === "removed"
        ? "bg-red-500/8"
        : undefined;
  const sigil = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  return (
    <div
      data-concern-key={concern ? concernKey(concern.index) : undefined}
      className={cn("flex items-stretch", bg)}
    >
      <ModalAnchorBar concern={concern?.concern} />
      <span className="text-muted-foreground/60 w-12 shrink-0 select-none px-2 text-right text-[10px] tabular-nums">
        {line.old_lineno ?? ""}
      </span>
      <span className="text-muted-foreground/60 w-12 shrink-0 select-none px-2 text-right text-[10px] tabular-nums">
        {line.new_lineno ?? ""}
      </span>
      <span
        aria-hidden
        className={cn(
          "text-muted-foreground/60 shrink-0 select-none px-1 text-[11px]",
          line.kind === "added" && "text-emerald-600 dark:text-emerald-400",
          line.kind === "removed" && "text-red-600 dark:text-red-400",
        )}
      >
        {sigil}
      </span>
      <span
        className="min-w-0 flex-1 whitespace-pre overflow-x-auto pr-3 text-[12px]"
        dangerouslySetInnerHTML={{ __html: line.html || "&nbsp;" }}
      />
    </div>
  );
}

function ModalAnchorBar({ concern }: { concern?: MappedConcern }) {
  if (!concern) return <span className="w-1.5 shrink-0" />;
  return (
    <span
      title={`${concern.concern.severity} · ${concern.concern.category}: ${concern.concern.rationale}`}
      className={cn(
        "block w-1.5 shrink-0 cursor-help",
        SEVERITY_BAR[concern.concern.severity] ?? "bg-zinc-500",
      )}
    />
  );
}

function ModalHunkSeparator() {
  return (
    <div className="text-muted-foreground/50 select-none border-y bg-muted/10 px-2 py-0.5 text-center text-[10px]">
      …
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split / side-by-side view
// ---------------------------------------------------------------------------

type Pair = {
  left: HighlightedDiffLine | null;
  right: HighlightedDiffLine | null;
};

function pairLines(lines: HighlightedDiffLine[]): Pair[] {
  const rows: Pair[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "context") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const removed: HighlightedDiffLine[] = [];
    while (i < lines.length && lines[i].kind === "removed") {
      removed.push(lines[i]);
      i++;
    }
    const added: HighlightedDiffLine[] = [];
    while (i < lines.length && lines[i].kind === "added") {
      added.push(lines[i]);
      i++;
    }
    const max = Math.max(removed.length, added.length);
    for (let j = 0; j < max; j++) {
      rows.push({ left: removed[j] ?? null, right: added[j] ?? null });
    }
  }
  return rows;
}

function SplitView({
  file,
  concerns,
}: {
  file: HighlightedDiffFile;
  concerns: Map<string, LineConcern>;
}) {
  return (
    <div className="font-mono leading-[1.55]">
      {file.hunks.map((hunk, hi) => {
        const pairs = pairLines(hunk.lines);
        return (
          <div key={hi}>
            {hi > 0 && <ModalHunkSeparator />}
            {hunk.header && (
              <div className="text-muted-foreground/80 bg-muted/20 px-2 py-0.5 text-[10px]">
                @@ {hunk.header} @@
              </div>
            )}
            <div>
              {pairs.map((p, pi) => (
                <SplitRow
                  key={pi}
                  pair={p}
                  hunk={hi}
                  hunkLines={hunk.lines}
                  concerns={concerns}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SplitRow({
  pair,
  hunk,
  hunkLines,
  concerns,
}: {
  pair: Pair;
  hunk: number;
  hunkLines: HighlightedDiffLine[];
  concerns: Map<string, LineConcern>;
}) {
  // Find the concern keyed on the *right* side's line index in the original
  // hunk.lines array (auditor anchors point at the post-change file).
  const rightLineIdx = pair.right ? hunkLines.indexOf(pair.right) : -1;
  const concern =
    rightLineIdx >= 0 ? concerns.get(`${hunk}:${rightLineIdx}`) : undefined;

  return (
    <div
      data-concern-key={concern ? concernKey(concern.index) : undefined}
      className="grid grid-cols-2 gap-px bg-border/60"
    >
      <SplitCell line={pair.left} side="left" />
      <SplitCell line={pair.right} side="right" concern={concern?.concern} />
    </div>
  );
}

function SplitCell({
  line,
  side,
  concern,
}: {
  line: HighlightedDiffLine | null;
  side: "left" | "right";
  concern?: MappedConcern;
}) {
  if (!line) {
    return <div className="bg-muted/5" />;
  }
  const bg =
    line.kind === "added"
      ? "bg-emerald-500/10"
      : line.kind === "removed"
        ? "bg-red-500/10"
        : "bg-background";
  const lineNo = side === "left" ? line.old_lineno : line.new_lineno;
  return (
    <div className={cn("flex items-stretch", bg)}>
      {side === "right" ? (
        <ModalAnchorBar concern={concern} />
      ) : (
        <span className="w-1.5 shrink-0" />
      )}
      <span className="text-muted-foreground/60 w-10 shrink-0 select-none px-1.5 text-right text-[10px] tabular-nums">
        {lineNo ?? ""}
      </span>
      <span
        className="min-w-0 flex-1 whitespace-pre overflow-x-auto pr-3 text-[12px]"
        dangerouslySetInnerHTML={{ __html: line.html || "&nbsp;" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concerns rail
// ---------------------------------------------------------------------------

function ConcernsRail({
  data,
  focusedConcernIdx,
  onSelect,
}: {
  data: TaskDiffWithMappings;
  focusedConcernIdx: number | null;
  onSelect: (idx: number) => void;
}) {
  const { auditor_verdict: verdict, mapped_concerns: concerns } = data;
  const anchored = concerns.filter(
    (c) =>
      c.mapping.kind === "on_diff_line" ||
      c.mapping.kind === "on_unchanged_line" ||
      c.mapping.kind === "file_not_in_diff",
  );
  const general = concerns.filter((c) => c.mapping.kind === "unmapped");

  return (
    <aside className="bg-muted/10 w-[300px] shrink-0 overflow-auto border-l">
      {verdict ? (
        <div className="border-b p-3">
          <div className="text-muted-foreground/80 mb-1 text-[10px] uppercase tracking-[0.06em]">
            Auditor verdict
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em]",
                verdict.verdict === "approve"
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : verdict.verdict === "reject"
                    ? "bg-red-500/15 text-red-700 dark:text-red-300"
                    : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
              )}
            >
              {verdict.verdict}
            </span>
            <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
              {Math.round(verdict.confidence * 100)}%
            </span>
          </div>
          {verdict.summary && (
            <p className="mt-2 text-[12px] leading-relaxed">
              {verdict.summary}
            </p>
          )}
        </div>
      ) : null}

      <ul>
        {data.mapped_concerns.map((c, idx) => {
          // Skip pure unmapped here — we list those at the bottom under
          // "General concerns". This keeps the main rail pointing at the diff.
          if (c.mapping.kind === "unmapped") return null;
          const focused = focusedConcernIdx === idx;
          return (
            <li key={idx}>
              <button
                type="button"
                onClick={() => onSelect(idx)}
                className={cn(
                  "block w-full border-b px-3 py-2 text-left",
                  focused
                    ? "bg-foreground/10"
                    : "hover:bg-muted/40",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "block size-1.5 shrink-0 rounded-full",
                      SEVERITY_BAR[c.concern.severity] ?? "bg-zinc-500",
                    )}
                  />
                  <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                    {c.concern.severity} · {c.concern.category}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed">
                  {c.concern.rationale}
                </p>
                <ConcernAnchorLabel concern={c} />
              </button>
            </li>
          );
        })}
      </ul>

      {general.length > 0 && (
        <div className="border-t">
          <div className="text-muted-foreground/80 px-3 py-1.5 text-[10px] uppercase tracking-[0.06em]">
            General concerns ({general.length})
          </div>
          {general.map((c, idx) => (
            <div key={idx} className="border-b px-3 py-2 last:border-b-0">
              <div className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                {c.concern.severity} · {c.concern.category}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed">
                {c.concern.rationale}
              </p>
            </div>
          ))}
        </div>
      )}

      {anchored.length === 0 && general.length === 0 && (
        <p className="text-muted-foreground p-3 text-xs">No concerns.</p>
      )}
    </aside>
  );
}

function ConcernAnchorLabel({ concern }: { concern: MappedConcern }) {
  const m = concern.mapping;
  if (m.kind === "on_diff_line" || m.kind === "on_unchanged_line") {
    const a = concern.concern.anchor;
    if (!a) return null;
    return (
      <p className="text-muted-foreground mt-1 font-mono text-[10px] tabular-nums">
        {a.path}:{a.line}
      </p>
    );
  }
  if (m.kind === "file_not_in_diff") {
    return (
      <p className="text-muted-foreground mt-1 font-mono text-[10px] tabular-nums">
        {m.path}:{m.line} <span className="opacity-60">· not in diff</span>
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function concernKey(idx: number): string {
  return `c-${idx}`;
}

function focusFileForConcern(
  data: TaskDiffWithMappings,
  concernIdx: number,
  setFocusedFileIdx: (n: number) => void,
) {
  const m = data.mapped_concerns[concernIdx]?.mapping;
  if (!m) return;
  if (m.kind === "on_diff_line" || m.kind === "on_unchanged_line") {
    setFocusedFileIdx(m.file_index);
  }
}

function scrollToConcern(idx: number) {
  const el = document.querySelector(
    `[data-concern-key="${concernKey(idx)}"]`,
  ) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  // Brief pulse to draw the eye.
  el.classList.add("ring-2", "ring-amber-500", "ring-inset");
  window.setTimeout(() => {
    el.classList.remove("ring-2", "ring-amber-500", "ring-inset");
  }, 700);
}

function readString(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

