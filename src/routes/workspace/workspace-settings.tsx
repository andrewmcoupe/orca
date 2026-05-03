import { useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { eventsApi } from "@/features/events/api";
import { useRemoveWorkspace, useWorkspaces } from "@/features/workspaces/hooks";
import { PhaseConfigPanel } from "@/features/workspaces/components/phase-config-panel";
import { DefaultPhaseSettingsPanel } from "@/features/workspaces/components/default-phase-settings-panel";
import { QuickTaskPreviewToggle } from "@/features/workspaces/components/quick-task-preview-toggle";
import { GateConfigPanel } from "@/features/workspaces/components/gate-config-panel";
import { PromptsPanel } from "@/features/workspaces/components/prompts-panel";
import { ReliabilityPanel } from "@/features/workspaces/components/reliability-panel";
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
    <div className="space-y-6 px-5 py-4">
      <header>
        <h1 className="text-[18px] font-medium tracking-tight">
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
        title="Default phase settings"
        description="Per-phase default model and permission mode. New tasks inherit these; tasks can override per-phase from the preview screen before starting."
      >
        <DefaultPhaseSettingsPanel workspaceId={ws.id} />
      </SettingsSection>

      <SettingsSection
        title="Task creation"
        description="Behaviour of the task creation flow."
      >
        <QuickTaskPreviewToggle workspaceId={ws.id} />
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

      <SettingsSection
        title="Reliability"
        description="Worktree initialization, phase timeouts, and additional environment variables. Defaults work for most projects."
      >
        <ReliabilityPanel workspaceId={ws.id} />
      </SettingsSection>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Maintenance</h2>
        <RebuildProjectionsButton />
        <div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => remove.mutate(ws.id)}
            disabled={remove.isPending}
          >
            Remove workspace
          </Button>
        </div>
      </section>
    </div>
  );
}

function RebuildProjectionsButton() {
  const qc = useQueryClient();
  const [result, setResult] = useState<string | null>(null);
  const rebuild = useMutation({
    mutationFn: eventsApi.rebuildProjections,
    onSuccess: (r) => {
      setResult(
        `Rebuilt ${r.projections_rebuilt.join(", ")} (${r.events_replayed} events).`,
      );
      qc.invalidateQueries();
    },
  });
  return (
    <div className="space-y-1.5">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setResult(null);
          rebuild.mutate();
        }}
        disabled={rebuild.isPending}
      >
        {rebuild.isPending ? "Rebuilding…" : "Rebuild projections"}
      </Button>
      <p className="text-muted-foreground text-xs">
        Replays the event log into the read-side tables. Safe to run; needed
        after a schema upgrade adds new projection columns.
      </p>
      {result && <p className="text-emerald-600 text-xs">{result}</p>}
      {rebuild.error && (
        <p className="text-destructive text-xs">{String(rebuild.error)}</p>
      )}
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
