import { useMemo, useState } from "react";
import { Info, Lock, PencilSimple } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { ModelSelect } from "@/features/providers/components/model-select";
import { ProviderLogo } from "@/features/providers/components/provider-logo";
import {
  bundledDefaultPermissionMode,
  PERMISSION_MODE_HELP,
  PERMISSION_MODE_LABEL,
  PERMISSION_MODES_FOR_PHASE,
  resolvePhaseSettings,
  type ModelChoice,
  type PermissionMode,
  type PhaseConfig,
  type PhaseType,
  type WorkspaceSettings,
} from "@/features/workspaces/types";

/**
 * The preview screen lives between "user filled out form" and "task is created and
 * running". For each phase that will run, it shows the resolved model and permission
 * mode (workspace default, unless the user already set a per-task override) and lets
 * the user edit each one inline. Edits land back on the `phaseConfig` the parent
 * passes to `create_task`.
 */
export function TaskCreationPreview({
  title,
  spec,
  phaseConfig,
  workspaceSettings,
  onPhaseConfigChange,
  onBack,
  onConfirm,
  pending,
  error,
  confirmLabel = "Start task",
}: {
  title: string;
  spec: string;
  phaseConfig: PhaseConfig;
  workspaceSettings: WorkspaceSettings;
  onPhaseConfigChange: (next: PhaseConfig) => void;
  onBack: () => void;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
  confirmLabel?: string;
}) {
  const [editingPhase, setEditingPhase] = useState<PhaseType | null>(null);
  const phases = phaseConfig.phases;

  const resolved = useMemo(
    () =>
      phases.map((p) => ({
        phase: p,
        ...resolvePhaseSettings(workspaceSettings, phaseConfig, p),
      })),
    [phases, phaseConfig, workspaceSettings],
  );

  const setOverride = (
    phase: PhaseType,
    next: { model?: ModelChoice | null; permission_mode?: PermissionMode },
  ) => {
    const nextModels: Record<string, ModelChoice> = {
      ...(phaseConfig.models ?? {}),
    };
    const nextModes: Record<string, PermissionMode> = {
      ...(phaseConfig.permission_modes ?? {}),
    };
    if (next.model !== undefined) {
      if (next.model) nextModels[phase] = next.model;
      else delete nextModels[phase];
    }
    if (next.permission_mode !== undefined) {
      nextModes[phase] = next.permission_mode;
    }
    onPhaseConfigChange({
      ...phaseConfig,
      models: Object.keys(nextModels).length > 0 ? nextModels : null,
      permission_modes:
        Object.keys(nextModes).length > 0 ? nextModes : null,
    });
  };

  return (
    <TooltipProvider delay={150}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Task
          </Label>
          <p className="text-sm font-medium">{title || "(untitled)"}</p>
          {spec && (
            <p className="text-muted-foreground line-clamp-3 text-xs whitespace-pre-line">
              {spec}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Phases that will run
          </Label>
          <ol className="space-y-2">
            {resolved.map(({ phase, model, permission_mode }, idx) => (
              <li
                key={phase}
                className="rounded-md border bg-card p-3"
              >
                <div className="flex items-start gap-3">
                  <div className="text-muted-foreground tabular-nums text-xs pt-0.5">
                    {idx + 1}.
                  </div>
                  <div className="flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{phase}</span>
                      {permission_mode === "plan" && (
                        <Tooltip>
                          <TooltipTrigger
                            render={(props) => (
                              <span {...props}>
                                <Lock className="text-muted-foreground size-3.5" />
                              </span>
                            )}
                          />
                          <TooltipContent className="text-xs">
                            Read-only run.
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setEditingPhase(
                            editingPhase === phase ? null : phase,
                          )
                        }
                        className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
                      >
                        <PencilSimple className="size-3" />
                        {editingPhase === phase ? "Done" : "Edit"}
                      </button>
                    </div>
                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono">
                      <span>
                        model:{" "}
                        {model ? (
                          <span className="text-foreground">{model.model}</span>
                        ) : (
                          <span className="italic">provider default</span>
                        )}
                        {model && (
                          <Badge
                            variant="outline"
                            className="ml-1.5 h-4 gap-1 rounded-sm px-1 text-[10px] font-normal"
                          >
                            <ProviderLogo provider={model.provider} className="size-2.5" />
                            {model.provider}
                          </Badge>
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        mode:{" "}
                        <span className="text-foreground">
                          {PERMISSION_MODE_LABEL[permission_mode]}
                        </span>
                        <Tooltip>
                          <TooltipTrigger
                            render={(props) => (
                              <button
                                type="button"
                                aria-label="Mode details"
                                className="text-muted-foreground hover:text-foreground"
                                {...props}
                              >
                                <Info className="size-3" />
                              </button>
                            )}
                          />
                          <TooltipContent className="max-w-xs text-xs leading-relaxed">
                            {PERMISSION_MODE_HELP[permission_mode]}
                          </TooltipContent>
                        </Tooltip>
                      </span>
                    </div>
                    {editingPhase === phase && (
                      <div className="space-y-2 border-t pt-2 mt-1">
                        <div className="grid grid-cols-[80px_1fr] items-center gap-2">
                          <Label className="text-xs">Model</Label>
                          <ModelSelect
                            size="sm"
                            value={model ?? null}
                            onChange={(next) =>
                              setOverride(phase, { model: next })
                            }
                            nullLabel="Workspace default"
                          />
                        </div>
                        <div className="grid grid-cols-[80px_1fr] items-center gap-2">
                          <Label className="text-xs">Mode</Label>
                          <Select
                            value={permission_mode}
                            onValueChange={(v) =>
                              setOverride(phase, {
                                permission_mode: v as PermissionMode,
                              })
                            }
                          >
                            <SelectTrigger size="sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PERMISSION_MODES_FOR_PHASE[phase].map((m) => (
                                <SelectItem key={m} value={m}>
                                  {PERMISSION_MODE_LABEL[m]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <p className="text-muted-foreground text-[11px]">
                          Overrides apply to this task only.{" "}
                          {phase === "auditor"
                            ? "The auditor never accepts bypass."
                            : null}{" "}
                          {permission_mode === "bypassPermissions" && (
                            <span className="text-warning">
                              Bypass mode runs the agent without prompts —
                              double-check before starting.
                            </span>
                          )}
                          {permission_mode ===
                            bundledDefaultPermissionMode(phase) &&
                          model === null
                            ? null
                            : null}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {error && <p className="text-destructive text-xs">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            disabled={pending}
          >
            Back
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={pending || phases.length === 0}
          >
            {pending ? "Starting…" : confirmLabel}
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}
