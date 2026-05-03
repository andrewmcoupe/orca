import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ModelSelect } from "@/features/providers/components/model-select";
import {
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from "../hooks";
import type {
  ModelChoice,
  PhaseType,
  WorkspaceSettings,
} from "../types";

const PHASE_DESCRIPTIONS: Record<string, string> = {
  test_author: "Writes failing tests before the implementer.",
  implementer: "Makes the code change.",
  auditor: "Reviews the diff and renders a verdict.",
};

export function DefaultModelsPanel({ workspaceId }: { workspaceId: string }) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const update = useUpdateWorkspaceSettings(workspaceId);

  const [draft, setDraft] = useState<Record<string, ModelChoice>>({});

  useEffect(() => {
    if (settingsQ.data) setDraft({ ...settingsQ.data.default_models });
  }, [settingsQ.data]);

  if (settingsQ.isLoading || !settingsQ.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const settings = settingsQ.data;
  const phases: PhaseType[] = settings.default_phase_config.phases;

  const setFor = (phase: string, next: ModelChoice | null) => {
    setDraft((prev) => {
      const out = { ...prev };
      if (next) out[phase] = next;
      else delete out[phase];
      return out;
    });
  };

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(settings.default_models);

  const save = () => {
    const merged: WorkspaceSettings = {
      ...settings,
      default_models: draft,
    };
    update.mutate(merged);
  };

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Default model for each configured phase. Tasks can override per-phase
        from the Advanced panel on creation. Leave a phase as
        “Provider default” to use the provider's hardcoded model.
      </p>
      <div className="space-y-3">
        {phases.map((phase) => (
          <div key={phase} className="grid grid-cols-[140px_1fr] items-center gap-3">
            <div>
              <Label className="font-mono text-sm">{phase}</Label>
              <p className="text-muted-foreground text-xs">
                {PHASE_DESCRIPTIONS[phase] ?? ""}
              </p>
            </div>
            <ModelSelect
              value={draft[phase] ?? null}
              onChange={(next) => setFor(phase, next)}
              nullLabel="Provider default"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        {update.error && (
          <span className="text-destructive text-xs">{String(update.error)}</span>
        )}
      </div>
    </div>
  );
}
