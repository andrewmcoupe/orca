import { createRoute, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useRemoveWorkspace, useWorkspaces } from "@/features/workspaces/hooks";
import { workspaceLayoutRoute } from "./layout";

function WorkspaceSettingsPage() {
  const { workspaceId } = useParams({ from: workspaceSettingsRoute.id });
  const workspaces = useWorkspaces();
  const remove = useRemoveWorkspace();
  const ws = workspaces.data?.find((w) => w.id === workspaceId);

  if (!ws) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Workspace not found.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-xl font-semibold tracking-tight">
        Workspace settings
      </h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Name</dt>
        <dd>{ws.name}</dd>
        <dt className="text-muted-foreground">Path</dt>
        <dd className="truncate font-mono text-xs">{ws.path}</dd>
      </dl>
      <div className="pt-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => remove.mutate(ws.id)}
          disabled={remove.isPending}
        >
          Remove workspace
        </Button>
      </div>
    </div>
  );
}

export const workspaceSettingsRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/settings",
  component: WorkspaceSettingsPage,
});
