import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { CaretRight, Info } from "@phosphor-icons/react";
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
  useSettings,
  useUpdateSettings,
  type SettingsScope,
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
  scope,
}: {
  workspaceId?: string;
  scope?: SettingsScope;
}) {
  const resolvedScope = scope ?? {
    type: "workspace" as const,
    workspaceId: workspaceId ?? "",
  };
  const settingsQ = useSettings(workspaceId || scope ? resolvedScope : undefined);
  const update = useUpdateSettings(resolvedScope);
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
        <div
          // Pipeline layout: phase columns interleaved with auto-sized arrow
          // columns at lg+. Stacks to a single column below lg. The template
          // is computed from `phases` (joined with " auto ") and exposed via a
          // CSS variable so the breakpoint switch lives entirely in CSS — no
          // window.innerWidth, no resize listener, SSR-safe.
          className="grid grid-cols-1 items-stretch gap-3 lg:gap-2 lg:[grid-template-columns:var(--phase-cols)]"
          style={
            {
              "--phase-cols": phases
                .map(() => "minmax(0,1fr)")
                .join(" auto "),
            } as CSSProperties
          }
        >
          {phases.map((phase, idx) => {
            const entry = draft[phase] ?? {};
            const allowedModes = PERMISSION_MODES_FOR_PHASE[phase];
            const currentMode =
              entry.permission_mode ?? bundledDefaultPermissionMode(phase);
            return (
              <Fragment key={phase}>
                <div
                  className="bg-card border rounded-md p-3 flex flex-col gap-3"
                  data-phase={phase}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <Label className="font-mono text-sm">{phase}</Label>
                    <span className="text-muted-foreground/60 font-mono text-[10px] tabular-nums">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {PHASE_DESCRIPTIONS[phase] ?? ""}
                  </p>
                  <div className="space-y-1">
                    <Label className="text-muted-foreground text-[10px] uppercase tracking-wide">
                      Model
                    </Label>
                    <ModelSelect
                      value={entry.model ?? null}
                      onChange={(next) => setModelFor(phase, next)}
                      nullLabel="Provider default"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-muted-foreground text-[10px] uppercase tracking-wide">
                      Permission mode
                    </Label>
                    <div className="flex items-center gap-1.5">
                      <Select
                        value={currentMode}
                        onValueChange={(v) =>
                          setModeFor(phase, v as PermissionMode)
                        }
                      >
                        <SelectTrigger className="h-9 flex-1">
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
                </div>
                {idx < phases.length - 1 && (
                  <div
                    className="text-muted-foreground/50 hidden items-center justify-center lg:flex"
                    aria-hidden="true"
                  >
                    <CaretRight className="size-5" />
                  </div>
                )}
              </Fragment>
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
