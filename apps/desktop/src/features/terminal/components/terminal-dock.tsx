import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { CaretDown, CaretUp, Plus, Terminal, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { terminalApi } from "@/features/terminal/api";
import type {
  TerminalExitEvent,
  TerminalLabelEvent,
  TerminalOutputEvent,
  TerminalSessionInfo,
} from "@/features/terminal/types";
import type { TerminalTab } from "@/features/terminal/terminal-store";

export function TerminalDock({
  tabs,
  activeTabId,
  collapsed,
  heightPx,
  onAddTerminal,
  onSelectTab,
  onCloseTab,
  onRenameTab,
  onToggleCollapsed,
  onResize,
}: {
  tabs: TerminalTab[];
  activeTabId: string | null;
  collapsed: boolean;
  heightPx: number | null;
  onAddTerminal: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab: (tabId: string, label: string) => void;
  onToggleCollapsed: () => void;
  onResize: (heightPx: number) => void;
}) {
  const dockRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const startResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (collapsed || event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button")) return;
      const dock = dockRef.current;
      if (!dock) return;
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: dock.getBoundingClientRect().height,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [collapsed],
  );

  const updateResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const dock = dockRef.current;
      if (!drag || !dock || drag.pointerId !== event.pointerId) return;
      const parentHeight =
        dock.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
      const maxHeight = Math.max(180, parentHeight - 120);
      const nextHeight = clamp(
        drag.startHeight + drag.startY - event.clientY,
        160,
        maxHeight,
      );
      onResize(nextHeight);
    },
    [onResize],
  );

  const stopResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  if (tabs.length === 0) return null;

  const style: CSSProperties | undefined =
    !collapsed && heightPx
      ? { height: `${heightPx}px`, maxHeight: "calc(100% - 120px)" }
      : undefined;

  return (
    <section
      ref={dockRef}
      className={cn(
        "bg-sidebar text-sidebar-foreground flex min-h-0 shrink-0 flex-col overflow-hidden border-t shadow-[0_-12px_30px_rgba(0,0,0,0.12)]",
        collapsed ? "h-10" : "h-[min(42vh,360px)]",
      )}
      style={style}
      aria-label="Task terminals"
    >
      <div
        className="bg-sidebar flex h-10 shrink-0 cursor-row-resize touch-none items-center border-b"
        onPointerDown={startResize}
        onPointerMove={updateResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        title="Drag to resize terminals"
      >
        <div className="scrollbar-styled flex min-w-0 flex-1 overflow-x-auto">
          {tabs.map((tab, index) => (
            <TerminalTabButton
              key={tab.id}
              tab={tab}
              index={index}
              active={tab.id === activeTabId}
              onSelect={() => onSelectTab(tab.id)}
              onClose={() => onCloseTab(tab.id)}
            />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l px-2">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onAddTerminal}
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Open another terminal"
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onToggleCollapsed}
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
            title={collapsed ? "Expand terminals" : "Collapse terminals"}
          >
            {collapsed ? (
              <CaretUp className="size-3.5" />
            ) : (
              <CaretDown className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-sidebar",
          collapsed && "hidden",
        )}
      >
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            terminalId={tab.id}
            active={tab.id === activeTabId && !collapsed}
            onLabelChange={(label) => onRenameTab(tab.id, label)}
            onMissing={() => onCloseTab(tab.id)}
          />
        ))}
      </div>
    </section>
  );
}

function TerminalTabButton({
  tab,
  index,
  active,
  onSelect,
  onClose,
}: {
  tab: TerminalTab;
  index: number;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-10 min-w-0 max-w-52 items-center gap-1.5 border-r px-3 text-left font-mono text-[11px] tracking-normal",
        active
          ? "bg-muted text-foreground"
          : "bg-sidebar text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
      title={tab.title}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <Terminal className="text-success size-3 shrink-0" />
        <span className="text-muted-foreground/60 shrink-0">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground grid size-5 shrink-0 place-items-center"
        aria-label={`Close ${tab.title}`}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function TerminalPane({
  terminalId,
  active,
  onLabelChange,
  onMissing,
}: {
  terminalId: string;
  active: boolean;
  onLabelChange: (label: string) => void;
  onMissing: () => void;
}) {
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onLabelChangeRef = useRef(onLabelChange);
  const onMissingRef = useRef(onMissing);
  const activeRef = useRef(active);
  const lastSizeRef = useRef({ cols: 120, rows: 18 });
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onLabelChangeRef.current = onLabelChange;
  }, [onLabelChange]);

  useEffect(() => {
    onMissingRef.current = onMissing;
  }, [onMissing]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!containerEl) return;

    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const term = new XTerm({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 10_000,
      theme: {
        background: cssVar("--terminal-background"),
        foreground: cssVar("--terminal-foreground"),
        cursor: cssVar("--terminal-green"),
        selectionBackground: cssVar("--terminal-selection"),
        black: cssVar("--terminal-black"),
        red: cssVar("--terminal-red"),
        green: cssVar("--terminal-green"),
        yellow: cssVar("--terminal-yellow"),
        blue: cssVar("--terminal-blue"),
        magenta: cssVar("--terminal-magenta"),
        cyan: cssVar("--terminal-cyan"),
        white: cssVar("--terminal-white"),
        brightBlack: cssVar("--terminal-muted"),
        brightRed: cssVar("--terminal-red"),
        brightGreen: cssVar("--terminal-green"),
        brightYellow: cssVar("--terminal-yellow"),
        brightBlue: cssVar("--terminal-blue"),
        brightMagenta: cssVar("--terminal-magenta"),
        brightCyan: cssVar("--terminal-cyan"),
        brightWhite: cssVar("--terminal-foreground"),
      },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(containerEl);
    termRef.current = term;

    const fitAndResize = () => {
      if (containerEl.offsetParent === null) return;
      try {
        fit.fit();
        const dims = { cols: term.cols, rows: term.rows };
        lastSizeRef.current = dims;
        void terminalApi.resize(terminalId, dims.cols, dims.rows);
      } catch {
        /* xterm can throw while layout settles; the next observer tick recovers. */
      }
    };

    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(containerEl);
    requestAnimationFrame(fitAndResize);

    const dataDisposable = term.onData((data) => {
      void terminalApi.write(terminalId, data).catch((err: unknown) => {
        setError(errorMessage(err));
      });
    });

    term.writeln("\x1b[90mattaching terminal...\x1b[0m");

    void (async () => {
      try {
        const attached = await terminalApi.attach(terminalId);
        if (cancelled) return;
        setSession(attached);
        onLabelChangeRef.current(attached.label);
        term.clear();
        for (const chunk of attached.scrollback) {
          term.write(chunk);
        }
        void terminalApi.resize(
          terminalId,
          lastSizeRef.current.cols,
          lastSizeRef.current.rows,
        );
        if (activeRef.current) term.focus();

        unlisteners.push(
          await listen<TerminalOutputEvent>("terminal_output", (event) => {
            if (event.payload.terminal_id !== terminalId) return;
            term.write(event.payload.data);
          }),
        );
        unlisteners.push(
          await listen<TerminalLabelEvent>("terminal_label", (event) => {
            if (event.payload.terminal_id !== terminalId) return;
            onLabelChangeRef.current(event.payload.label);
          }),
        );
        unlisteners.push(
          await listen<TerminalExitEvent>("terminal_exit", (event) => {
            if (event.payload.terminal_id !== terminalId) return;
            setSession((current) =>
              current ? { ...current, exited: true } : current,
            );
            term.writeln("");
            term.writeln(
              `\x1b[90mterminal exited${
                event.payload.exit_code === null
                  ? ""
                  : ` with code ${event.payload.exit_code}`
              }\x1b[0m`,
            );
          }),
        );
      } catch (err) {
        const message = errorMessage(err);
        setError(message);
        term.writeln(`\x1b[31m${message}\x1b[0m`);
        onMissingRef.current();
      }
    })();

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      for (const unlisten of unlisteners) unlisten();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      setSession(null);
      setError(null);
    };
  }, [containerEl, terminalId]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* layout may still be settling */
      }
      termRef.current?.focus();
    });
  }, [active]);

  return (
    <div
      className={cn(
        "absolute inset-0 min-h-0 flex-col overflow-hidden bg-sidebar",
        active ? "flex" : "hidden",
      )}
    >
      {(session || error) && (
        <div className="text-muted-foreground flex h-6 shrink-0 items-center gap-2 border-b px-3 font-mono text-[10px] tracking-normal">
          <span className="truncate">{session?.cwd ?? error}</span>
          {session && (
            <>
              <span className="text-muted-foreground/60">·</span>
              <span>{session.shell}</span>
              {session.exited && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span>exited</span>
                </>
              )}
            </>
          )}
        </div>
      )}
      <div className="box-border min-h-0 flex-1 overflow-hidden p-2">
        <div
          ref={setContainerEl}
          className="orca-live-terminal min-h-0 h-full w-full overflow-hidden font-mono"
          data-terminal-tab={terminalId}
        />
      </div>
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "terminal failed";
}

function cssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
