import { createRoute, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useRemoveWorkspace, useWorkspaces } from "@/features/workspaces/hooks";
import { PhaseConfigPanel } from "@/features/workspaces/components/phase-config-panel";
import { GateConfigPanel } from "@/features/workspaces/components/gate-config-panel";
import { PromptsPanel } from "@/features/workspaces/components/prompts-panel";
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
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">
          Workspace settings
        </h1>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{ws.name}</dd>
          <dt className="text-muted-foreground">Path</dt>
          <dd className="truncate font-mono text-xs">{ws.path}</dd>
        </dl>
      </header>

      <SettingsSection
        title="Default phase config"
        description="Phases that new tasks inherit. Tasks can override via the Advanced panel on creation."
      >
        <PhaseConfigPanel workspaceId={ws.id} />
      </SettingsSection>

      <SettingsSection
        title="Gates"
        description="Commands run after configured phases. A non-zero exit fails the gate and stops the pipeline."
      >
        <GateConfigPanel workspaceId={ws.id} />
      </SettingsSection>

      <SettingsSection
        title="Prompts"
        description="Per-phase prompt templates for this workspace. Saved files override the bundled defaults."
      >
        <PromptsPanel workspaceId={ws.id} />
      </SettingsSection>

      <Separator />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Danger zone</h2>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => remove.mutate(ws.id)}
          disabled={remove.isPending}
        >
          Remove workspace
        </Button>
      </section>
    </div>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="rounded-md border p-4">{children}</div>
    </section>
  );
}

export const workspaceSettingsRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/settings",
  component: WorkspaceSettingsPage,
});
