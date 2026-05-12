import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import { usePlans } from "@/features/plans/hooks";
import { useAddWorkspace, useWorkspaces } from "@/features/workspaces/hooks";
import type { Workspace } from "@/features/workspaces/types";
import { cn } from "@/lib/utils";
import { GearSix, House, Plus } from "@phosphor-icons/react";
import { Link, useMatches } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";

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
    <Sidebar collapsible="icon" className="top-9 h-[calc(100svh-2.25rem)]">
      <SidebarHeader className="gap-0 border-b p-2 h-11">
        <div className="flex items-center justify-between font-body text-sm group-data-[collapsible=icon]:hidden">
          <span className="text-muted-foreground text-xs font-mono lowercase font-thin">
            Workspaces
          </span>
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:hidden">
            <Link
              to="/"
              activeOptions={{ exact: true }}
              aria-label="Home"
              title="Home"
              className="border text-muted-foreground hover:bg-sidebar-accent rounded-sm hover:text-foreground inline-flex items-center justify-center bg-transparent p-1 transition-colors [&.active]:bg-sidebar-accent [&.active]:text-foreground"
            >
              <House className="size-4" />
            </Link>
            <button
              type="button"
              onClick={onAdd}
              aria-label="Add workspace"
              title="Add workspace"
              className="border text-muted-foreground hover:bg-sidebar-accent rounded-sm hover:text-foreground inline-flex items-center justify-center p-1 bg-transparent"
            >
              <Plus className="size-4" />
            </button>
          </div>
        </div>
        <div className="hidden items-center justify-center gap-1 group-data-[collapsible=icon]:flex h-full">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            aria-label="Home"
            title="Home"
            className="h-full text-muted-foreground hover:bg-sidebar-accent hover:text-foreground inline-flex items-center justify-center transition-colors [&.active]:bg-sidebar-accent [&.active]:text-foreground rounded-sm p-1"
          >
            <House className="size-4" />
          </Link>
        </div>
      </SidebarHeader>
      <SidebarContent className="scrollbar-styled">
        {list.length === 0 ? (
          <p className="text-muted-foreground px-2 py-2 text-[11px]">
            No workspaces yet. Click + to add one.
          </p>
        ) : (
          <>
            <Accordion
              value={expansion.open}
              className="border-b group-data-[collapsible=icon]:hidden p-2"
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
            <div className="hidden flex-col items-center gap-1 py-1 group-data-[collapsible=icon]:flex">
              {list.map((ws) => (
                <CollapsedWorkspaceLink
                  key={ws.id}
                  workspace={ws}
                  isActive={ws.id === activeId}
                  onNavigate={() => expansion.ensureOpen(ws.id)}
                />
              ))}
            </div>
          </>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t p-2">
        <Link
          to="/settings"
          aria-label="Settings"
          title="Settings"
          className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex h-8 items-center gap-2 rounded-sm px-2 text-xs transition-colors [&.active]:bg-sidebar-accent [&.active]:text-foreground"
        >
          <GearSix className="size-4" />
          <span className="group-data-[collapsible=icon]:hidden">Settings</span>
        </Link>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

const navLinkClass =
  "flex h-[28px] w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground [&.active]:bg-sidebar-accent [&.active]:text-foreground [&.active]:font-medium";

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

  const planCount = plansQ.data?.length ?? null;

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

function CollapsedWorkspaceLink({
  workspace,
  isActive,
  onNavigate,
}: {
  workspace: Workspace;
  isActive: boolean;
  onNavigate: () => void;
}) {
  const label = workspace.name.trim() || "Workspace";
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <Link
      to="/workspace/$workspaceId/plans"
      params={{ workspaceId: workspace.id }}
      search={{ status: "active", q: "" }}
      onClick={onNavigate}
      aria-label={label}
      title={label}
      className={cn(
        "border text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-8 p-1 rounded-sm items-center justify-center text-[10px] font-medium transition-colors",
        isActive && "bg-sidebar-accent text-foreground border-primary border",
      )}
    >
      {initials || label[0].toUpperCase()}
    </Link>
  );
}
