import { useMatches, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { QuickTaskDialog } from "./quick-task-dialog";

function useWorkspaceIdFromRoute(): string | null {
  const matches = useMatches();
  for (const m of matches) {
    const params = m.params as { workspaceId?: string };
    if (params.workspaceId) return params.workspaceId;
  }
  return null;
}

/**
 * Mounts a global ⌘N / Ctrl+N shortcut that opens the quick-task dialog from
 * anywhere within a workspace context. If the user is on a global route
 * (`/`, `/settings`) the shortcut is a no-op — the dialog needs to know
 * which workspace to add the task to.
 */
export function QuickTaskShortcut() {
  const workspaceId = useWorkspaceIdFromRoute();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isShortcut =
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "n";
      if (!isShortcut) return;
      if (!workspaceId) return; // disabled outside workspace context
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaceId]);

  if (!workspaceId) return null;

  return (
    <QuickTaskDialog
      workspaceId={workspaceId}
      open={open}
      onOpenChange={setOpen}
      onCreated={({ workspaceId, planId, taskId }) =>
        navigate({
          to: "/workspace/$workspaceId/plan/$planId/task/$taskId",
          params: { workspaceId, planId, taskId },
        })
      }
    />
  );
}
