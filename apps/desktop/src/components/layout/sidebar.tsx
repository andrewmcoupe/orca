import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { usePlans } from "@/features/plans/hooks";
import { useProviders } from "@/features/providers/hooks";
import { useAddWorkspace, useWorkspaces } from "@/features/workspaces/hooks";
import type { Workspace } from "@/features/workspaces/types";
import { cn } from "@/lib/utils";
import { House, Plus } from "@phosphor-icons/react";
import { Link, useMatches } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { EqualizerLoader } from "../ui/mini-loaders";

const EXPANSION_KEY = "orca:sidebar:expanded-workspaces";

function useExpansionState() {
  const [open, setOpen] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(EXPANSION_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(EXPANSION_KEY, JSON.stringify(open));
    } catch {
      // best-effort
    }
  }, [open]);
  const ensureOpen = useCallback((id: string) => {
    setOpen((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  return { open, setOpen, ensureOpen };
}

function useActiveWorkspaceFromRoute(): string | null {
  const matches = useMatches();
  for (const m of matches) {
    const params = m.params as { workspaceId?: string };
    if (params.workspaceId) return params.workspaceId;
  }
  return null;
}

export function WorkspacesSidebar() {
  const workspaces = useWorkspaces();
  const addWorkspace = useAddWorkspace();
  const expansion = useExpansionState();
  const activeId = useActiveWorkspaceFromRoute();

  // Auto-expand the active workspace on mount/navigation.
  useEffect(() => {
    if (activeId) expansion.ensureOpen(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const onAdd = async () => {
    const selected = await open({ directory: true });
    if (typeof selected !== "string") return;
    addWorkspace.mutate(selected);
  };

  const list = workspaces.data ?? [];

  return (
    <aside className="bg-muted text-sidebar-foreground flex w-[220px] flex-shrink-0 flex-col border-r">
      <div className="flex h-7 items-center justify-between pr-1 pl-2 font-body text-sm">
        <span className="text-muted-foreground text-xs font-mono lowercase font-thin">
          Workspaces
        </span>
        <div className="flex items-center gap-1">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            aria-label="Home"
            title="Home"
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground inline-flex size-4 items-center justify-center border border-border bg-background transition-colors [&.active]:bg-sidebar-accent [&.active]:text-foreground"
          >
            <House className="size-2.5" />
          </Link>
          <Button
            variant={"outline"}
            type="button"
            onClick={onAdd}
            aria-label="Add workspace"
            title="Add workspace"
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground inline-flex size-4 items-center justify-center rounded-none p-0"
          >
            <Plus className="size-2 text-foreground" />
          </Button>
        </div>
      </div>
      <div className="scrollbar-styled flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <p className="text-muted-foreground px-2 py-2 text-[11px]">
            No workspaces yet. Click + to add one.
          </p>
        ) : (
          <Accordion
            value={expansion.open}
            className={"bg-background border-b"}
            onValueChange={(v) =>
              expansion.setOpen(Array.isArray(v) ? (v as string[]) : [])
            }
          >
            {list.map((ws) => (
              <WorkspaceItem
                key={ws.id}
                workspace={ws}
                isActive={ws.id === activeId}
                onNavigate={() => expansion.ensureOpen(ws.id)}
              />
            ))}
          </Accordion>
        )}
      </div>
    </aside>
  );
}

const navLinkClass =
  "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex h-[20px] items-center gap-2 pl-[14px] pr-2 text-xs transition-colors [&.active]:bg-sidebar-accent [&.active]:text-foreground [&.active]:font-medium";

function WorkspaceItem({
  workspace,
  isActive,
  onNavigate,
}: {
  workspace: Workspace;
  isActive: boolean;
  onNavigate: () => void;
}) {
  // Counts only resolve for the currently-active workspace, since the backend
  // keeps a single per-workspace event store open at a time. For other items
  // the counts are intentionally hidden rather than guessed.
  const plansQ = usePlans(isActive ? workspace.id : null);
  const providers = useProviders();

  const planCount = plansQ.data?.length ?? null;
  const runningCount = useMemo(
    () =>
      (plansQ.data ?? []).reduce(
        (acc, p) => acc + (p.running_task_count || 0),
        0,
      ),
    [plansQ.data],
  );
  const installedProviders = (providers.data ?? []).filter(
    (p) => p.installed,
  ).length;
  const totalProviders = providers.data?.length ?? null;

  return (
    <AccordionItem value={workspace.id} className={cn("border-none")}>
      <AccordionTrigger
        className={cn(
          // Override the UI primitive defaults so the row sits at ~22px.
          "h-[22px] items-center px-2 py-4 text-xs font-normal hover:no-underline text-foreground border-none",
          "**:data-[slot=accordion-trigger-icon]:size-[10px] **:data-[slot=accordion-trigger-icon]:opacity-70",
          isActive && "font-medium",
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate pr-1.5">
          <span className="truncate">{workspace.name}</span>
          {isActive && runningCount > 0 && (
            <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
              <span className="text-emerald-500 inline-flex">
                <EqualizerLoader />
              </span>
              {runningCount}
            </span>
          )}
        </span>
      </AccordionTrigger>
      <AccordionContent className="py-1">
        <div className="flex flex-col">
          <Link
            to="/workspace/$workspaceId/plans"
            params={{ workspaceId: workspace.id }}
            search={{ status: "active", q: "" }}
            onClick={onNavigate}
            className={navLinkClass}
          >
            <NavRowContent
              label="Plans"
              count={planCount !== null ? String(planCount) : null}
            />
          </Link>
          <Link
            to="/workspace/$workspaceId/providers"
            params={{ workspaceId: workspace.id }}
            onClick={onNavigate}
            className={navLinkClass}
          >
            <NavRowContent
              label="AI Providers"
              count={
                totalProviders !== null
                  ? `${installedProviders}/${totalProviders}`
                  : null
              }
            />
          </Link>
          <Link
            to="/workspace/$workspaceId/settings"
            params={{ workspaceId: workspace.id }}
            onClick={onNavigate}
            className={navLinkClass}
          >
            <NavRowContent label="Settings" />
          </Link>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function NavRowContent({
  label,
  count,
}: {
  label: string;
  count?: string | null;
}) {
  return (
    <>
      <span className="flex-1 truncate text-xs">{label}</span>
      {count !== undefined && count !== null && (
        <span className="text-muted-foreground/70 text-[10px] tabular-nums">
          {count}
        </span>
      )}
    </>
  );
}
