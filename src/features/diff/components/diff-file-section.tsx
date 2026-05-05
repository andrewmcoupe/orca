import { useState } from "react";
import { CaretDown, CaretRight, FileX } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { HighlightedDiffFile } from "../types";
import type { ConcernOnFile } from "./diff-panel";

const STATUS_LABEL: Record<string, string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

const STATUS_STYLE: Record<string, string> = {
  added: "text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  modified: "text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10",
  deleted: "text-red-600 dark:text-red-400 border-red-500/30 bg-red-500/10",
  renamed: "text-sky-600 dark:text-sky-400 border-sky-500/30 bg-sky-500/10",
};

const SEVERITY_BAR: Record<string, string> = {
  blocking: "bg-red-500",
  advisory: "bg-amber-500",
};

type Props = {
  file: HighlightedDiffFile;
  concerns: ConcernOnFile[];
  /** When true, the file body renders even on the panel — defaults to true. The
   *  modal sets this per-focused-file. */
  defaultOpen?: boolean;
};

export function DiffFileSection({ file, concerns, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  // Index concerns landing on (hunkIdx, lineIdx) inside this file.
  const concernByHunkLine = new Map<string, ConcernOnFile>();
  for (const c of concerns) {
    if (c.kind === "diff" && c.hunkIndex != null && c.lineIndex != null) {
      concernByHunkLine.set(`${c.hunkIndex}:${c.lineIndex}`, c);
    }
  }

  const hasUnchangedConcerns = concerns.some((c) => c.kind === "unchanged");

  return (
    <section className="border-b">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="bg-background hover:bg-muted sticky top-0 z-[1] flex w-full items-center gap-1.5 border-b px-2.5 py-1.5 text-left"
      >
        {open ? (
          <CaretDown className="size-3 shrink-0" />
        ) : (
          <CaretRight className="size-3 shrink-0" />
        )}
        <span
          className="truncate font-mono text-[11px]"
          title={file.path}
        >
          {file.old_path && file.old_path !== file.path ? (
            <span>
              <span className="text-muted-foreground">{file.old_path}</span>
              <span className="text-muted-foreground"> → </span>
              <span>{file.path}</span>
            </span>
          ) : (
            file.path
          )}
        </span>
        <span
          className={cn(
            "ml-auto rounded-sm border px-1 text-[9px] font-medium uppercase tracking-[0.06em]",
            STATUS_STYLE[file.status],
          )}
        >
          {STATUS_LABEL[file.status] ?? file.status}
        </span>
        <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
          <span className="text-emerald-500">+{file.additions}</span>{" "}
          <span className="text-red-500">−{file.deletions}</span>
        </span>
        {concerns.length > 0 && (
          <span
            className="bg-amber-500/15 text-amber-700 dark:text-amber-400 rounded-sm border-amber-500/30 px-1 font-mono text-[9px] font-medium"
            title={`${concerns.length} concern${concerns.length === 1 ? "" : "s"}`}
          >
            {concerns.length}
          </span>
        )}
      </button>
      {open && (
        <div className="scrollbar-styled overflow-x-auto text-[11px]">
          {file.is_binary ? (
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 font-mono text-[11px]">
              <FileX className="size-3" />
              Binary file not shown.
            </div>
          ) : file.hunks.length === 0 ? (
            <div className="text-muted-foreground px-3 py-2 font-mono text-[11px]">
              No textual changes.
            </div>
          ) : (
            <TooltipProvider delay={150}>
              {file.hunks.map((hunk, hi) => (
                <div key={hi}>
                  {hi > 0 && <HunkSeparator />}
                  {hunk.header && (
                    <div className="text-muted-foreground/80 bg-muted/20 px-2 py-0.5 font-mono text-[10px]">
                      @@ {hunk.header} @@
                    </div>
                  )}
                  {hunk.lines.map((line, li) => {
                    const concern = concernByHunkLine.get(`${hi}:${li}`);
                    return (
                      <DiffLineRow
                        key={li}
                        kind={line.kind}
                        oldNo={line.old_lineno}
                        newNo={line.new_lineno}
                        html={line.html}
                        concern={concern}
                      />
                    );
                  })}
                </div>
              ))}
              {hasUnchangedConcerns && (
                <UnchangedAnchorsInFile
                  file={file}
                  concerns={concerns.filter((c) => c.kind === "unchanged")}
                />
              )}
            </TooltipProvider>
          )}
        </div>
      )}
    </section>
  );
}

function HunkSeparator() {
  return (
    <div className="text-muted-foreground/50 select-none border-y bg-muted/10 px-2 py-0.5 text-center font-mono text-[10px]">
      …
    </div>
  );
}

function DiffLineRow({
  kind,
  oldNo,
  newNo,
  html,
  concern,
}: {
  kind: "context" | "added" | "removed";
  oldNo: number | null;
  newNo: number | null;
  html: string;
  concern?: ConcernOnFile;
}) {
  const bg =
    kind === "added"
      ? "bg-emerald-500/8"
      : kind === "removed"
        ? "bg-red-500/8"
        : undefined;
  const sigil = kind === "added" ? "+" : kind === "removed" ? "−" : " ";

  return (
    <div
      className={cn(
        "group/line flex items-stretch font-mono leading-[1.5]",
        bg,
      )}
      data-line-kind={kind}
      data-new-lineno={newNo ?? undefined}
    >
      <AnchorGutter concern={concern} />
      <LineNumber n={oldNo} />
      <LineNumber n={newNo} />
      <span
        aria-hidden
        className={cn(
          "text-muted-foreground/60 shrink-0 select-none px-1 text-[10px]",
          kind === "added" && "text-emerald-600 dark:text-emerald-400",
          kind === "removed" && "text-red-600 dark:text-red-400",
        )}
      >
        {sigil}
      </span>
      <span
        className="flex-1 whitespace-pre pr-2 text-[11px]"
        // syntect output is already escaped; we trust it.
        dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }}
      />
    </div>
  );
}

function LineNumber({ n }: { n: number | null }) {
  return (
    <span className="text-muted-foreground/60 w-9 shrink-0 select-none px-1 text-right text-[10px] tabular-nums">
      {n ?? ""}
    </span>
  );
}

function AnchorGutter({ concern }: { concern?: ConcernOnFile }) {
  if (!concern) {
    return <span className="w-1 shrink-0" />;
  }
  const sev = concern.concern.severity;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "block w-1 shrink-0 cursor-help",
              SEVERITY_BAR[sev] ?? "bg-zinc-500",
            )}
            data-concern-anchor
          />
        }
      />
      <TooltipContent side="left" className="max-w-sm">
        <ConcernPopover concern={concern} />
      </TooltipContent>
    </Tooltip>
  );
}

function ConcernPopover({ concern }: { concern: ConcernOnFile }) {
  const c = concern.concern;
  return (
    <div className="space-y-1 text-left">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "rounded-sm px-1 text-[9px] font-medium uppercase tracking-[0.06em]",
            c.severity === "blocking"
              ? "bg-red-500 text-white"
              : "bg-amber-500 text-black",
          )}
        >
          {c.severity}
        </span>
        <span className="text-[10px] uppercase tracking-[0.06em] text-zinc-300">
          {c.category}
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-100">{c.rationale}</p>
    </div>
  );
}

function UnchangedAnchorsInFile({
  file,
  concerns,
}: {
  file: HighlightedDiffFile;
  concerns: ConcernOnFile[];
}) {
  return (
    <div className="border-t bg-muted/10 py-1">
      <div className="text-muted-foreground/80 px-3 py-1 text-[10px] uppercase tracking-[0.06em]">
        Concerns on unchanged lines
      </div>
      {concerns.map((c, i) => {
        const lineNo = c.lineInFile ?? 0;
        return (
          <div
            key={i}
            className="group/line flex items-stretch font-mono leading-[1.5]"
          >
            <AnchorGutter concern={c} />
            <LineNumber n={null} />
            <LineNumber n={lineNo} />
            <span
              aria-hidden
              className="text-muted-foreground/40 shrink-0 select-none px-1 text-[10px]"
            >
              ·
            </span>
            <span
              className="text-muted-foreground flex-1 whitespace-pre pr-2 text-[11px]"
              dangerouslySetInnerHTML={{
                __html:
                  highlightLineFromFile(file, lineNo) ??
                  escapeHtml(c.unchangedContent ?? ""),
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

function highlightLineFromFile(
  file: HighlightedDiffFile,
  oneIndexedLine: number,
): string | null {
  if (oneIndexedLine <= 0) return null;
  const arr = file.new_lines_html;
  if (!arr) return null;
  return arr[oneIndexedLine - 1] ?? null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
