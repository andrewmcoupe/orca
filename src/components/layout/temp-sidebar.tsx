import { Link } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  useAddWorkspace,
  useWorkspaces,
} from "@/features/workspaces/hooks";

/**
 * Minimal sidebar shipped in M6. Replaced in M7 by the accordion sidebar.
 * Lists registered workspaces as Links to their plans route, plus a global
 * Settings link and an "Add workspace" button.
 */
export function TempSidebar() {
  const workspaces = useWorkspaces();
  const addWorkspace = useAddWorkspace();

  const onAdd = async () => {
    const selected = await open({ directory: true });
    if (typeof selected !== "string") return;
    addWorkspace.mutate(selected);
  };

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex w-64 flex-shrink-0 flex-col border-r">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold tracking-wide uppercase">
          Workspaces
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onAdd}
          aria-label="Add workspace"
        >
          <Plus />
        </Button>
      </div>
      <Separator />
      <nav className="flex-1 overflow-y-auto px-1 py-1">
        {(workspaces.data ?? []).map((ws) => (
          <Link
            key={ws.id}
            to="/workspace/$workspaceId/plans"
            params={{ workspaceId: ws.id }}
            search={{ status: "active", q: "" }}
            className="hover:bg-sidebar-accent block truncate rounded-sm px-2 py-1.5 text-sm transition-colors aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium [&.active]:bg-sidebar-accent [&.active]:font-medium"
          >
            {ws.name}
          </Link>
        ))}
      </nav>
      <Separator />
      <div className="px-1 py-1">
        <Link
          to="/settings"
          className="hover:bg-sidebar-accent block rounded-sm px-2 py-1.5 text-sm transition-colors [&.active]:bg-sidebar-accent [&.active]:font-medium"
        >
          Settings
        </Link>
      </div>
    </aside>
  );
}
