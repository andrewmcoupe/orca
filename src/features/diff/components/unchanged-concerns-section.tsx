import { useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useUnchangedFileContent } from "../hooks";
import type { MappedConcern } from "../types";

const SEVERITY_BAR: Record<string, string> = {
  blocking: "bg-red-500",
  advisory: "bg-amber-500",
};

type Props = {
  taskId: string;
  /** All concerns whose mapping is `file_not_in_diff`. */
  concerns: MappedConcern[];
};

/**
 * Renders the bottom-of-panel section for concerns that point at files outside
 * the diff. Each file is collapsed by default; expanding fetches the file's
 * content at HEAD and displays a few-line window around the anchor.
 */
export function UnchangedConcernsSection({ taskId, concerns }: Props) {
  // Group concerns by path so we render one row per file.
  const byPath = new Map<string, MappedConcern[]>();
  for (const c of concerns) {
    if (c.mapping.kind !== "file_not_in_diff") continue;
    const list = byPath.get(c.mapping.path) ?? [];
    list.push(c);
    byPath.set(c.mapping.path, list);
  }

  if (byPath.size === 0) return null;

  return (
    <section className="border-t">
      <div className="bg-muted/20 text-muted-foreground/80 sticky top-0 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.06em]">
        Unchanged with concerns ({byPath.size})
      </div>
      <TooltipProvider delay={150}>
        {Array.from(byPath.entries()).map(([path, group]) => (
          <UnchangedFileRow
            key={path}
            taskId={taskId}
            path={path}
            concerns={group}
          />
        ))}
      </TooltipProvider>
    </section>
  );
}

function UnchangedFileRow({
  taskId,
  path,
  concerns,
}: {
  taskId: string;
  path: string;
  concerns: MappedConcern[];
}) {
  const [open, setOpen] = useState(false);
  const fileQ = useUnchangedFileContent(taskId, open ? path : undefined, open);

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="hover:bg-muted/40 flex w-full items-center gap-1.5 px-2.5 py-1 text-left"
      >
        {open ? (
          <CaretDown className="size-3 shrink-0" />
        ) : (
          <CaretRight className="size-3 shrink-0" />
        )}
        <span className="text-muted-foreground/80 truncate font-mono text-[11px]">
          {path}
        </span>
        <span className="text-muted-foreground/60 ml-auto font-mono text-[10px]">
          unchanged · {concerns.length} concern{concerns.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="bg-muted/10">
          {fileQ.isLoading ? (
            <div className="text-muted-foreground p-2 font-mono text-[10px]">
              Loading…
            </div>
          ) : fileQ.error ? (
            <div className="text-destructive p-2 font-mono text-[10px]">
              Couldn't load file: {String(fileQ.error)}
            </div>
          ) : fileQ.data ? (
            <FileSnippets content={fileQ.data.content} concerns={concerns} />
          ) : null}
        </div>
      )}
    </div>
  );
}

const CONTEXT = 3;

function FileSnippets({
  content,
  concerns,
}: {
  content: string;
  concerns: MappedConcern[];
}) {
  const lines = content.split("\n");
  // Sort concerns by anchor line so output reads top-to-bottom.
  const sorted = [...concerns].sort((a, b) => {
    const al = a.mapping.kind === "file_not_in_diff" ? a.mapping.line : 0;
    const bl = b.mapping.kind === "file_not_in_diff" ? b.mapping.line : 0;
    return al - bl;
  });

  return (
    <div className="text-[11px]">
      {sorted.map((c, idx) => {
        if (c.mapping.kind !== "file_not_in_diff") return null;
        const target = c.mapping.line;
        const lo = Math.max(1, target - CONTEXT);
        const hi = Math.min(lines.length, target + CONTEXT);
        return (
          <div
            key={idx}
            className="border-t first:border-t-0 px-1 py-1"
          >
            {Array.from({ length: hi - lo + 1 }, (_, i) => {
              const lineNo = lo + i;
              const isAnchor = lineNo === target;
              const text = lines[lineNo - 1] ?? "";
              return (
                <div
                  key={lineNo}
                  className="flex items-stretch font-mono leading-[1.5]"
                >
                  {isAnchor ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            className={cn(
                              "block w-1 shrink-0 cursor-help",
                              SEVERITY_BAR[c.concern.severity] ?? "bg-zinc-500",
                            )}
                          />
                        }
                      />
                      <TooltipContent side="left" className="max-w-sm">
                        <div className="space-y-1 text-left">
                          <div className="text-[10px] uppercase tracking-[0.06em] text-zinc-300">
                            {c.concern.severity} · {c.concern.category}
                          </div>
                          <p className="text-[11px] text-zinc-100">
                            {c.concern.rationale}
                          </p>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="w-1 shrink-0" />
                  )}
                  <span className="text-muted-foreground/60 w-9 shrink-0 select-none px-1 text-right text-[10px] tabular-nums">
                    {lineNo}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 whitespace-pre overflow-x-auto pr-2",
                      isAnchor && "bg-amber-500/10",
                    )}
                  >
                    {text || " "}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
