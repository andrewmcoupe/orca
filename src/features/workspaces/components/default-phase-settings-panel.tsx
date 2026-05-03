import { useEffect, useMemo, useState } from "react";
import { Info } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ModelSelect } from "@/features/providers/components/model-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from "../hooks";
import {
  bundledDefaultPermissionMode,
  PERMISSION_MODE_HELP,
  PERMISSION_MODE_LABEL,
  PERMISSION_MODES_FOR_PHASE,
  type DefaultPhaseSetting,
  type ModelChoice,
  type PermissionMode,
  type PhaseType,
  type WorkspaceSettings,
} from "../types";

const PHASE_DESCRIPTIONS: Record<string, string> = {
  test_author: "Writes failing tests before the implementer.",
  implementer: "Makes the code change.",
  auditor: "Reviews the diff and renders a verdict.",
};

type Draft = Record<string, DefaultPhaseSetting>;

/**
 * Build the initial UI draft from stored settings, merging the legacy `default_models`
 * map (model only) with the newer `default_phase_settings` (model + permission mode).
 * The settings UI writes both fields in sync on save so on-disk state stays consistent.
 */
function buildDraft(settings: WorkspaceSettings): Draft {
  const out: Draft = {};
  const phases = settings.default_phase_config.phases;
  for (const phase of phases) {
    const newer = settings.default_phase_settings?.[phase];
    const legacy = settings.default_models?.[phase];
    out[phase] = {
      model: newer?.model ?? legacy ?? null,
      permission_mode:
        newer?.permission_mode ?? bundledDefaultPermissionMode(phase),
    };
  }
  return out;
}

export function DefaultPhaseSettingsPanel({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const update = useUpdateWorkspaceSettings(workspaceId);
  const [draft, setDraft] = useState<Draft>({});

  useEffect(() => {
    if (settingsQ.data) setDraft(buildDraft(settingsQ.data));
  }, [settingsQ.data]);

  const settings = settingsQ.data;
  const baseline = useMemo(
    () => (settings ? buildDraft(settings) : {}),
    [settings],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  if (settingsQ.isLoading || !settings) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const phases: PhaseType[] = settings.default_phase_config.phases;

  const setModelFor = (phase: string, next: ModelChoice | null) => {
    setDraft((prev) => ({
      ...prev,
      [phase]: { ...prev[phase], model: next },
    }));
  };

  const setModeFor = (phase: PhaseType, next: PermissionMode) => {
    setDraft((prev) => ({
      ...prev,
      [phase]: { ...prev[phase], permission_mode: next },
    }));
  };

  const save = () => {
    // Write both new and legacy shapes so older readers (or a downgrade) still see
    // the model, and new readers get the full per-phase settings. Drop legacy entries
    // for phases the user has cleared.
    const newDefaultModels: Record<string, ModelChoice> = {};
    const newDefaultPhaseSettings: Record<string, DefaultPhaseSetting> = {};
    for (const phase of Object.keys(draft)) {
      const entry = draft[phase];
      if (entry.model) newDefaultModels[phase] = entry.model;
      newDefaultPhaseSettings[phase] = {
        model: entry.model ?? null,
        permission_mode: entry.permission_mode ?? null,
      };
    }
    const merged: WorkspaceSettings = {
      ...settings,
      default_models: newDefaultModels,
      default_phase_settings: newDefaultPhaseSettings,
    };
    update.mutate(merged);
  };

  return (
    <TooltipProvider delay={150}>
      <div className="space-y-3">
        <p className="text-muted-foreground text-xs">
          Default model and permission mode for each phase. New tasks inherit
          these settings; tasks can override per-phase from the preview screen
          before starting. The auditor never accepts <code>bypassPermissions</code>.
        </p>
        <div className="space-y-3">
          {phases.map((phase) => {
            const entry = draft[phase] ?? {};
            const allowedModes = PERMISSION_MODES_FOR_PHASE[phase];
            const currentMode =
              entry.permission_mode ?? bundledDefaultPermissionMode(phase);
            return (
              <div
                key={phase}
                className="grid grid-cols-[140px_1fr_220px] items-center gap-3"
              >
                <div>
                  <Label className="font-mono text-sm">{phase}</Label>
                  <p className="text-muted-foreground text-xs">
                    {PHASE_DESCRIPTIONS[phase] ?? ""}
                  </p>
                </div>
                <ModelSelect
                  value={entry.model ?? null}
                  onChange={(next) => setModelFor(phase, next)}
                  nullLabel="Provider default"
                />
                <div className="flex items-center gap-1.5">
                  <Select
                    value={currentMode}
                    onValueChange={(v) =>
                      setModeFor(phase, v as PermissionMode)
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {allowedModes.map((m) => (
                        <SelectItem key={m} value={m}>
                          {PERMISSION_MODE_LABEL[m]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Tooltip>
                    <TooltipTrigger
                      render={(props) => (
                        <button
                          type="button"
                          aria-label={`What does ${PERMISSION_MODE_LABEL[currentMode]} mean?`}
                          className="text-muted-foreground hover:text-foreground"
                          {...props}
                        >
                          <Info className="size-4" />
                        </button>
                      )}
                    />
                    <TooltipContent
                      side="left"
                      className="max-w-xs text-xs leading-relaxed"
                    >
                      {PERMISSION_MODE_HELP[currentMode]}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
          {update.error && (
            <span className="text-destructive text-xs">
              {String(update.error)}
            </span>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
