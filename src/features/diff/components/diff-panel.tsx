import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsOutSimple,
  ArrowsInSimple,
  ArrowClockwise,
  CaretRight,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  useRefreshTaskDiff,
  useTaskDiff,
  useTaskDiffLiveUpdates,
} from "../hooks";
import type {
  AnchorMapping,
  HighlightedDiffFile,
  MappedConcern,
  TaskDiffWithMappings,
} from "../types";
import { DiffFileSection } from "./diff-file-section";
import { UnchangedConcernsSection } from "./unchanged-concerns-section";

const MIN_WIDTH = 240;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;
const COLLAPSED_WIDTH = 32;

const widthKey = (workspaceId: string) => `diff-panel-width:${workspaceId}`;
const collapsedKey = (workspaceId: string) =>
  `diff-panel-collapsed:${workspaceId}`;

type Props = {
  workspaceId: string;
  taskId: string;
  /** Imperative handle: parent (task detail) calls this to open the modal. */
  onOpenModal?: () => void;
};

export function DiffPanel({ workspaceId, taskId, onOpenModal }: Props) {
  const [width, setWidth] = useState<number>(() =>
    readNumber(widthKey(workspaceId), DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH),
  );
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    readBoolean(collapsedKey(workspaceId), false),
  );

  const diffQ = useTaskDiff(taskId);
  const refresh = useRefreshTaskDiff();
  useTaskDiffLiveUpdates(taskId, !!diffQ.data?.is_live);

  // Persist width / collapsed state.
  useEffect(() => {
    try {
      window.localStorage.setItem(widthKey(workspaceId), String(width));
    } catch {
      /* quota or private mode — ignore */
    }
  }, [workspaceId, width]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        collapsedKey(workspaceId),
        collapsed ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [workspaceId, collapsed]);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const onMove = (ev: MouseEvent) => {
        // The handle is on the left edge: dragging left widens the panel.
        const delta = startX - ev.clientX;
        const next = clamp(startW + delta, MIN_WIDTH, MAX_WIDTH);
        setWidth(next);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width],
  );

  const effectiveWidth = collapsed ? COLLAPSED_WIDTH : width;

  return (
    <aside
      className="bg-card sticky top-0 self-start flex shrink-0 border-l"
      style={{
        width: effectiveWidth,
        // The workspace layout's header is h-7 (1.75rem). Subtract it so the
        // panel fills the visible viewport without overflowing the page.
        height: "calc(100vh - 1.75rem)",
      }}
    >
      {!collapsed && (
        <button
          type="button"
          aria-label="Resize diff panel"
          onMouseDown={onResizeStart}
          className="hover:bg-primary/40 absolute -left-[3px] top-0 h-full w-[6px] cursor-col-resize select-none"
          tabIndex={-1}
        />
      )}
      {collapsed ? (
        <CollapsedRail
          onExpand={() => setCollapsed(false)}
          onOpenModal={onOpenModal}
        />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col bg-card">
          <PanelHeader
            data={diffQ.data}
            isFetching={diffQ.isFetching || refresh.isPending}
            onCollapse={() => setCollapsed(true)}
            onRefresh={() => refresh.mutate(taskId)}
            onOpenModal={onOpenModal}
          />
          <PanelBody
            taskId={taskId}
            data={diffQ.data}
            isLoading={diffQ.isLoading}
            error={diffQ.error}
          />
        </div>
      )}
    </aside>
  );
}

function CollapsedRail({
  onExpand,
  onOpenModal,
}: {
  onExpand: () => void;
  onOpenModal?: () => void;
}) {
  return (
    <div className="text-muted-foreground flex h-full w-full flex-col items-center gap-2 py-2">
      <button
        type="button"
        onClick={onExpand}
        className="hover:text-foreground hover:bg-muted/40 flex w-full flex-col items-center gap-2 py-1"
        title="Expand diff panel"
      >
        <ArrowsOutSimple className="size-3.5" />
        <span
          className="text-[10px] uppercase tracking-[0.16em]"
          style={{ writingMode: "vertical-rl" }}
        >
          Diff
        </span>
      </button>
      {onOpenModal ? (
        <button
          type="button"
          onClick={onOpenModal}
          className="hover:text-foreground hover:bg-muted/40 mt-auto flex w-full flex-col items-center gap-2 py-1"
          title="Review diff in modal"
        >
          <CaretRight className="size-3.5" />
          <span
            className="text-[10px] uppercase tracking-[0.16em]"
            style={{ writingMode: "vertical-rl" }}
          >
            Review
          </span>
        </button>
      ) : null}
    </div>
  );
}

function PanelHeader({
  data,
  isFetching,
  onCollapse,
  onRefresh,
  onOpenModal,
}: {
  data: TaskDiffWithMappings | undefined;
  isFetching: boolean;
  onCollapse: () => void;
  onRefresh: () => void;
  onOpenModal?: () => void;
}) {
  const fileCount = data?.diff.files.length ?? 0;
  const baseShort = data?.diff.base_commit?.slice(0, 7) ?? "—";
  const adds = data?.diff.additions ?? 0;
  const dels = data?.diff.deletions ?? 0;

  return (
    <div className="bg-background sticky top-0 z-[1] border-b">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <span className="text-muted-foreground/70 text-[10px] font-medium uppercase tracking-[0.08em]">
          Diff
        </span>
        <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
          {fileCount} {fileCount === 1 ? "file" : "files"}
        </span>
        {data?.is_live ? <LiveDot /> : null}
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            size="xs"
            variant="ghost"
            title="Refresh"
            onClick={onRefresh}
            className="size-6 p-0"
          >
            <ArrowClockwise
              className={cn("size-3", isFetching && "animate-spin")}
            />
          </Button>
          {onOpenModal ? (
            <Button
              size="xs"
              variant="ghost"
              title="Review in modal"
              onClick={onOpenModal}
              className="h-6 gap-1 px-1.5 text-[10px] uppercase tracking-[0.08em]"
            >
              Review
              <CaretRight className="size-3" />
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            title="Collapse"
            onClick={onCollapse}
            className="size-6 p-0"
          >
            <ArrowsInSimple className="size-3" />
          </Button>
        </div>
      </div>
      <div className="text-muted-foreground flex items-center gap-2 px-2.5 pb-1.5 font-mono text-[10px] tabular-nums">
        <span>vs {baseShort}</span>
        <span className="text-emerald-500">+{adds}</span>
        <span className="text-red-500">−{dels}</span>
      </div>
    </div>
  );
}

function LiveDot() {
  return (
    <span
      className="bg-emerald-500/80 ml-1 inline-block size-1.5 animate-pulse rounded-full"
      title="Live — phase running"
    />
  );
}

function PanelBody({
  taskId,
  data,
  isLoading,
  error,
}: {
  taskId: string;
  data: TaskDiffWithMappings | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  // Preserve scroll position across reactive updates: when `data.computed_at`
  // changes (a live update has landed), keep the user's vertical position in the
  // scroll container instead of resetting it.
  const ref = useRef<HTMLDivElement | null>(null);
  const lastComputed = useRef<number>(data?.diff.computed_at ?? 0);
  useEffect(() => {
    const el = ref.current;
    if (!el || !data) return;
    if (data.diff.computed_at !== lastComputed.current) {
      // Don't yank scroll. The DOM has already updated, but if the layout
      // shrank above our scroll position, requestAnimationFrame lets us
      // measure-and-restore on the next frame.
      const top = el.scrollTop;
      window.requestAnimationFrame(() => {
        if (ref.current) ref.current.scrollTop = top;
      });
      lastComputed.current = data.diff.computed_at;
    }
  }, [data]);

  if (error) {
    return (
      <div className="text-destructive p-4 text-xs">
        Failed to load diff: {String(error)}
      </div>
    );
  }
  if (isLoading || !data) {
    return <PanelSkeleton />;
  }

  if (data.diff.source.kind === "unavailable") {
    return (
      <div className="text-muted-foreground p-4 text-xs leading-relaxed">
        {emptyMessage(data.diff.source.reason)}
      </div>
    );
  }

  if (data.diff.files.length === 0 && unchangedConcernsOf(data).length === 0) {
    return <div className="text-muted-foreground p-4 text-xs">No changes.</div>;
  }

  // Index concerns by file so each section can render its own anchors.
  const byFile = groupConcernsByFile(data.mapped_concerns, data.diff.files);
  const unchanged = unchangedConcernsOf(data);

  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto">
      {data.diff.files.map((file, idx) => (
        <DiffFileSection
          key={`${file.path}-${idx}`}
          file={file}
          concerns={byFile.get(idx) ?? []}
        />
      ))}
      {unchanged.length > 0 && (
        <UnchangedConcernsSection taskId={taskId} concerns={unchanged} />
      )}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="flex-1 space-y-2 p-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="bg-muted/50 h-3 w-full animate-pulse rounded-sm"
          style={{ width: `${60 + ((i * 17) % 35)}%` }}
        />
      ))}
    </div>
  );
}

function emptyMessage(reason: string): string {
  if (/no base commit/.test(reason)) {
    return "Diff will appear once the implementer has run.";
  }
  if (/no worktree/.test(reason)) {
    return "Diff unavailable — branch was removed.";
  }
  return `Diff unavailable: ${reason}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readNumber(
  key: string,
  fallback: number,
  lo: number,
  hi: number,
): number {
  try {
    const raw = window.localStorage.getItem(key);
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n)) return clamp(n, lo, hi);
  } catch {
    /* ignore */
  }
  return fallback;
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

// ---------------------------------------------------------------------------
// Concern grouping
// ---------------------------------------------------------------------------

export type ConcernOnFile = {
  concern: MappedConcern["concern"];
  /** "diff" anchors land on a hunk line; "unchanged" anchors are within the file
   * but outside any hunk. */
  kind: "diff" | "unchanged";
  hunkIndex?: number;
  lineIndex?: number;
  lineInFile?: number;
  unchangedContent?: string;
};

function groupConcernsByFile(
  mapped: MappedConcern[],
  files: HighlightedDiffFile[],
): Map<number, ConcernOnFile[]> {
  void files;
  const map = new Map<number, ConcernOnFile[]>();
  for (const m of mapped) {
    const a: AnchorMapping = m.mapping;
    if (a.kind === "on_diff_line") {
      const list = map.get(a.file_index) ?? [];
      list.push({
        concern: m.concern,
        kind: "diff",
        hunkIndex: a.hunk_index,
        lineIndex: a.line_index,
      });
      map.set(a.file_index, list);
    } else if (a.kind === "on_unchanged_line") {
      const list = map.get(a.file_index) ?? [];
      list.push({
        concern: m.concern,
        kind: "unchanged",
        lineInFile: a.line_in_file,
        unchangedContent: a.content,
      });
      map.set(a.file_index, list);
    }
  }
  return map;
}

function unchangedConcernsOf(data: TaskDiffWithMappings): MappedConcern[] {
  return data.mapped_concerns.filter(
    (m) => m.mapping.kind === "file_not_in_diff",
  );
}
