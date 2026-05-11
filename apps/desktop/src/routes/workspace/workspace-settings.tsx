import { useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { eventsApi } from "@/features/events/api";
import { useRemoveWorkspace, useWorkspaces } from "@/features/workspaces/hooks";
import { PhaseConfigPanel } from "@/features/workspaces/components/phase-config-panel";
import { DefaultPhaseSettingsPanel } from "@/features/workspaces/components/default-phase-settings-panel";
import { BriefingPersonaSettingsPanel } from "@/features/workspaces/components/briefing-persona-settings-panel";
import { QuickTaskPreviewToggle } from "@/features/workspaces/components/quick-task-preview-toggle";
import { GateConfigPanel } from "@/features/workspaces/components/gate-config-panel";
import { PromptsPanel } from "@/features/workspaces/components/prompts-panel";
import { ReliabilityPanel } from "@/features/workspaces/components/reliability-panel";
import { PreviewServerPanel } from "@/features/workspaces/components/preview-server-panel";
import { LinearSettingsPanel } from "@/features/integrations/linear/components/linear-settings-panel";
import {
  SettingBlock,
  SettingsFrame,
  SettingsSection,
} from "@/routes/global-settings";
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
    <SettingsFrame
      title="Workspace settings"
      showBackLink={false}
      subtitle={
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{ws.name}</dd>
          <dt className="text-muted-foreground">Path</dt>
          <dd className="truncate font-mono text-xs">{ws.path}</dd>
        </dl>
      }
    >
      <SettingsSection
        id="workflow"
        title="Workflow"
        description="Workspace defaults replace app-level values when tasks are created here."
      >
        <SettingBlock
          title="Default phase config"
          description="Phases that new tasks inherit. Tasks can override via the Advanced panel on creation."
        >
          <PhaseConfigPanel workspaceId={ws.id} />
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        id="general"
        title="General"
        description="Provider, model, permission, and briefing defaults for this workspace."
      >
        <div className="space-y-5">
          <SettingBlock
            title="Default phase settings"
            description="Per-phase default model and permission mode for new tasks."
          >
            <DefaultPhaseSettingsPanel workspaceId={ws.id} />
          </SettingBlock>
          <SettingBlock
            title="Briefing personas"
            description="Provider and model defaults for specialist reviewers."
          >
            <BriefingPersonaSettingsPanel workspaceId={ws.id} />
          </SettingBlock>
        </div>
      </SettingsSection>

      <SettingsSection
        id="configuration"
        title="Configuration"
        description="Workspace-specific task creation, integration, gates, prompts, and preview settings."
      >
        <div className="space-y-5">
          <SettingBlock
            title="Task creation"
            description="Behaviour of the task creation flow."
          >
            <QuickTaskPreviewToggle workspaceId={ws.id} />
          </SettingBlock>
          <SettingBlock
            title="Integrations"
            description="Connect external systems used to import source context."
          >
            <LinearSettingsPanel workspaceId={ws.id} />
          </SettingBlock>
          <SettingBlock
            title="Gates"
            description="Commands run after configured phases."
          >
            <GateConfigPanel workspaceId={ws.id} />
          </SettingBlock>
          <SettingBlock
            title="Prompts"
            description="Saved files override bundled phase prompt templates."
          >
            <PromptsPanel workspaceId={ws.id} />
          </SettingBlock>
          <SettingBlock
            title="Preview server"
            description="Start a frontend dev server from a task worktree."
          >
            <PreviewServerPanel workspaceId={ws.id} />
          </SettingBlock>
        </div>
      </SettingsSection>

      <SettingsSection
        id="reliability"
        title="Reliability"
        description="Worktree initialization, phase timeouts, and additional environment variables."
      >
        <SettingBlock
          title="Runtime reliability"
          description="Defaults work for most projects; override here when this workspace differs."
        >
          <ReliabilityPanel workspaceId={ws.id} />
        </SettingBlock>
      </SettingsSection>

      <Separator />

      <SettingsSection
        id="advanced"
        title="Maintenance"
        description="Repair projections and remove the workspace registration."
      >
        <SettingBlock
          title="Maintenance"
          description="Operations that affect this workspace registration."
        >
          <div className="space-y-3">
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
          </div>
        </SettingBlock>
      </SettingsSection>
    </SettingsFrame>
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
        {rebuild.isPending ? "Rebuilding..." : "Rebuild projections"}
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

export const workspaceSettingsRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/settings",
  component: WorkspaceSettingsPage,
});
