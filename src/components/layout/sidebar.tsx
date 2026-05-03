import { Link, useMatches } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ClipboardText,
  Gear,
  Info,
  Plug,
  Plus,
} from "@phosphor-icons/react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useAddWorkspace, useWorkspaces } from "@/features/workspaces/hooks";
import { usePlans } from "@/features/plans/hooks";
import { useProviders } from "@/features/providers/hooks";
import type { Workspace } from "@/features/workspaces/types";
import { cn } from "@/lib/utils";

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
    <aside className="bg-sidebar text-sidebar-foreground flex w-[220px] flex-shrink-0 flex-col border-r">
      <div className="flex h-7 items-center justify-between pr-1 pl-2">
        <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.08em]">
          Workspaces
        </span>
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add workspace"
          title="Add workspace"
          className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground inline-flex size-[14px] items-center justify-center rounded-sm"
        >
          <Plus className="size-3" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <p className="text-muted-foreground px-2 py-2 text-[11px]">
            No workspaces yet. Click + to add one.
          </p>
        ) : (
          <Accordion
            value={expansion.open}
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
      <nav className="flex flex-col py-1">
        <SidebarGlobalLink to="/settings" icon={<Gear />}>
          Settings
        </SidebarGlobalLink>
        <SidebarGlobalLink to="/" icon={<Info />}>
          About
        </SidebarGlobalLink>
      </nav>
    </aside>
  );
}

function SidebarGlobalLink({
  to,
  icon,
  children,
}: {
  to: ComponentProps<typeof Link>["to"];
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex h-[20px] items-center gap-2 px-2 text-[11px] no-underline transition-colors [&.active]:bg-sidebar-accent [&.active]:text-foreground"
      activeOptions={{ exact: true }}
    >
      <span className="text-muted-foreground/80 inline-flex size-3 items-center justify-center">
        {icon}
      </span>
      {children}
    </Link>
  );
}

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
  const installedProviders = (providers.data ?? []).filter((p) => p.installed)
    .length;
  const totalProviders = providers.data?.length ?? null;

  return (
    <AccordionItem
      value={workspace.id}
      className={cn(
        "border-b-0",
        isActive && "border-l-primary border-l-2",
      )}
    >
      <AccordionTrigger
        className={cn(
          // Override the UI primitive defaults so the row sits at ~22px.
          "h-[22px] items-center px-2 py-0 text-[12px] font-normal hover:no-underline",
          "**:data-[slot=accordion-trigger-icon]:size-[10px] **:data-[slot=accordion-trigger-icon]:opacity-70",
          isActive && "font-medium",
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate pr-1.5">
          <span className="truncate">{workspace.name}</span>
          {isActive && runningCount > 0 && (
            <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
              <span className="bg-emerald-500 inline-block size-1.5 rounded-full animate-pulse" />
              {runningCount}
            </span>
          )}
        </span>
      </AccordionTrigger>
      <AccordionContent className="pb-1 pt-0">
        <div className="flex flex-col">
          <Link
            to="/workspace/$workspaceId/plans"
            params={{ workspaceId: workspace.id }}
            search={{ status: "active", q: "" }}
            onClick={onNavigate}
            className={navLinkClass}
          >
            <NavRowContent
              icon={<ClipboardText />}
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
              icon={<Plug />}
              label="Providers"
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
            <NavRowContent icon={<Gear />} label="Settings" />
          </Link>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

const navLinkClass =
  "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex h-[20px] items-center gap-2 pl-[14px] pr-2 text-[11px] no-underline transition-colors [&.active]:bg-sidebar-accent [&.active]:text-foreground [&.active]:font-medium";

function NavRowContent({
  icon,
  label,
  count,
}: {
  icon: ReactNode;
  label: string;
  count?: string | null;
}) {
  return (
    <>
      <span className="text-muted-foreground/70 inline-flex size-3 items-center justify-center">
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && count !== null && (
        <span className="text-muted-foreground/70 text-[10px] tabular-nums">
          {count}
        </span>
      )}
    </>
  );
}
