import { useEffect, useMemo, useState } from "react";
import { Info, Sliders } from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { providersApi } from "@/features/providers/api";
import { useProviders, usePermissionModes } from "@/features/providers/hooks";
import type { KnownModel, ProviderStatus } from "@/features/providers/types";
import {
  useResetTaskPhaseConfig,
  useUpdateTaskPhaseConfig,
} from "@/features/tasks/hooks";
import type { PermissionMode, PhaseType } from "@/features/tasks/types";
import {
  PERMISSION_MODE_HELP,
  PERMISSION_MODE_LABEL,
  PERMISSION_MODES_FOR_PHASE,
} from "@/features/workspaces/types";

const PHASE_LABEL: Record<PhaseType, string> = {
  test_author: "test_author",
  implementer: "implementer",
  auditor: "auditor",
};

export function PhaseConfigEditor({
  taskId,
  phase,
  initialProvider,
  initialModel,
  initialPermissionMode,
  disabled,
  disabledReason,
}: {
  taskId: string;
  phase: PhaseType;
  /** Currently effective provider for this phase — what the next run would use. */
  initialProvider: string | null;
  /** Currently effective model id. */
  initialModel: string | null;
  /** Currently effective permission mode. */
  initialPermissionMode: PermissionMode;
  disabled: boolean;
  disabledReason: string;
}) {
  const [open, setOpen] = useState(false);

  const trigger = (
    <PopoverTrigger
      render={
        <button
          type="button"
          aria-label={
            disabled ? disabledReason : `Edit ${PHASE_LABEL[phase]} config`
          }
          disabled={disabled}
          className={cn(
            "text-muted-foreground/60 hover:text-foreground -m-1 inline-flex size-5 items-center justify-center rounded-sm transition-colors",
            "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
            disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground/60",
          )}
          onClick={(e) => {
            // Prevent the click bubbling to the parent phase-card button (which
            // would otherwise open the phase-run detail view).
            e.stopPropagation();
          }}
        >
          <Sliders className="size-3.5" />
        </button>
      }
    />
  );

  return (
    <TooltipProvider delay={200}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent side="top" className="text-[11px]">
            {disabled ? disabledReason : `Edit ${PHASE_LABEL[phase]} config`}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="bottom"
          align="end"
          className="w-[340px] space-y-3"
          // Don't let clicks inside the popover bubble back up to the phase card.
          onClick={(e) => e.stopPropagation()}
        >
          <PhaseConfigEditorBody
            taskId={taskId}
            phase={phase}
            initialProvider={initialProvider}
            initialModel={initialModel}
            initialPermissionMode={initialPermissionMode}
            onClose={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

function PhaseConfigEditorBody({
  taskId,
  phase,
  initialProvider,
  initialModel,
  initialPermissionMode,
  onClose,
}: {
  taskId: string;
  phase: PhaseType;
  initialProvider: string | null;
  initialModel: string | null;
  initialPermissionMode: PermissionMode;
  onClose: () => void;
}) {
  const providersQ = useProviders();
  const update = useUpdateTaskPhaseConfig();
  const reset = useResetTaskPhaseConfig();

  // Filter to providers that are installed AND authenticated. The brief is
  // explicit: "Options come from list_providers(), filtered to providers that
  // are installed and authenticated." A misconfigured provider can't actually
  // run a phase, so don't offer it.
  const eligibleProviders: ProviderStatus[] = useMemo(
    () => (providersQ.data ?? []).filter((p) => p.installed && p.authenticated),
    [providersQ.data],
  );

  // Local form state. Provider/model start at the resolved values. If the
  // resolved provider is no longer eligible (e.g. uninstalled since the task
  // was created), fall back to the first eligible provider.
  const [provider, setProvider] = useState<string | null>(() => {
    if (initialProvider && eligibleProviders.some((p) => p.id === initialProvider)) {
      return initialProvider;
    }
    return eligibleProviders[0]?.id ?? null;
  });
  const [model, setModel] = useState<string | null>(initialModel);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    initialPermissionMode,
  );

  // If the providers query resolved after this component mounted, re-evaluate
  // the initial provider once. We only do this when `provider` is null (no
  // user choice yet) to avoid clobbering a deliberate selection.
  useEffect(() => {
    if (provider == null && eligibleProviders.length > 0) {
      setProvider(
        initialProvider &&
          eligibleProviders.some((p) => p.id === initialProvider)
          ? initialProvider
          : eligibleProviders[0].id,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleProviders.length]);

  // Provider-aware availability: codex's `plan` mode (--sandbox read-only) is
  // safe everywhere, claude's is not. Fall back to the static phase-only matrix
  // until the query resolves so the dropdown never renders empty.
  const modesQ = usePermissionModes(provider, phase);
  const allowedModes = useMemo<PermissionMode[]>(() => {
    if (modesQ.data && modesQ.data.length > 0) {
      return modesQ.data as PermissionMode[];
    }
    return PERMISSION_MODES_FOR_PHASE[phase];
  }, [modesQ.data, phase]);

  // If the chosen mode isn't allowed for the new provider/phase, snap to the
  // first allowed value so the Select never holds an out-of-range value.
  useEffect(() => {
    if (!allowedModes.includes(permissionMode) && allowedModes.length > 0) {
      setPermissionMode(allowedModes[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedModes.join(",")]);

  // Models for the currently-selected provider only. The brief is explicit:
  // when the provider changes, the model selection clears so the user must
  // re-pick — a model id from one provider is not portable to another.
  const modelsQ = useQueries({
    queries: eligibleProviders.map((p) => ({
      queryKey: ["provider_models", p.id],
      queryFn: () => providersApi.listModels(p.id),
      enabled: eligibleProviders.length > 0,
    })),
  });
  const modelsByProvider = useMemo(() => {
    const map: Record<string, KnownModel[]> = {};
    eligibleProviders.forEach((p, i) => {
      map[p.id] = modelsQ[i]?.data ?? [];
    });
    return map;
  }, [eligibleProviders, modelsQ]);

  const currentModels = provider ? (modelsByProvider[provider] ?? []) : [];

  const onProviderChange = (next: string | null) => {
    if (next == null) return;
    setProvider(next);
    // Drop the model selection on provider change — model ids aren't portable
    // across providers, so leaving the old value would silently corrupt the
    // dropdown's value-vs-options invariant.
    setModel(null);
  };

  const isDirty =
    provider !== initialProvider ||
    model !== initialModel ||
    permissionMode !== initialPermissionMode;

  const canSave =
    !!provider &&
    !!model &&
    !update.isPending &&
    !reset.isPending &&
    isDirty;

  const onSave = () => {
    if (!provider || !model) return;
    update.mutate(
      {
        taskId,
        phase,
        provider,
        model,
        permissionMode,
      },
      {
        onSuccess: () => onClose(),
      },
    );
  };

  const onReset = () => {
    reset.mutate(
      { taskId, phase },
      {
        onSuccess: () => onClose(),
      },
    );
  };

  const errorMessage = update.error
    ? formatError(update.error)
    : reset.error
      ? formatError(reset.error)
      : null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-foreground font-heading text-sm font-medium">
          Edit {PHASE_LABEL[phase]} config
        </h3>
        <p className="text-muted-foreground mt-0.5 text-[11px]">
          Applies to the next run of this phase. Historical runs are
          unaffected.
        </p>
      </div>

      <div className="space-y-2.5">
        <Field label="Provider">
          <Select
            value={provider ?? undefined}
            onValueChange={onProviderChange}
            disabled={eligibleProviders.length === 0}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue
                placeholder={
                  providersQ.isLoading
                    ? "Loading…"
                    : eligibleProviders.length === 0
                      ? "No authenticated providers"
                      : "Pick a provider"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {eligibleProviders.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Model">
          <Select
            value={model ?? undefined}
            onValueChange={(v) => setModel(v)}
            disabled={!provider || currentModels.length === 0}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue
                placeholder={
                  !provider
                    ? "Pick a provider first"
                    : currentModels.length === 0
                      ? "Loading models…"
                      : "Pick a model"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {currentModels.length > 0 && provider ? (
                <SelectGroup>
                  <SelectLabel>
                    {eligibleProviders.find((p) => p.id === provider)
                      ?.display_name ?? provider}
                  </SelectLabel>
                  {currentModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Permission mode">
          <div className="flex items-center gap-1.5">
            <Select
              value={permissionMode}
              onValueChange={(v) => setPermissionMode(v as PermissionMode)}
            >
              <SelectTrigger size="sm" className="w-full">
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
                    aria-label={`What does ${PERMISSION_MODE_LABEL[permissionMode]} mean?`}
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
                {PERMISSION_MODE_HELP[permissionMode]}
              </TooltipContent>
            </Tooltip>
          </div>
        </Field>
      </div>

      {errorMessage && (
        <p className="text-destructive text-[11px]">{errorMessage}</p>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={update.isPending || reset.isPending}
        >
          {reset.isPending ? "Resetting…" : "Reset to default"}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={update.isPending || reset.isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={!canSave}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-muted-foreground text-[10px] uppercase tracking-[0.08em]">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Surface the backend's typed error string verbatim — the command emits
 * messages like `phase_running: …` and unknown-provider strings the user can
 * usefully read. Strip the prefix where it's redundant. */
function formatError(err: unknown): string {
  const raw = String(err ?? "Unknown error");
  // Drop our own `phase_running:` prefix — the popover only opens when the
  // task isn't running, so this branch indicates a stale tab; the suffix is
  // the user-facing sentence.
  if (raw.startsWith("phase_running:")) {
    return raw.slice("phase_running:".length).trim();
  }
  return raw;
}

