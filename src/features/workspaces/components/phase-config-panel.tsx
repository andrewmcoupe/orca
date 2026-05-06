import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useUpdateWorkspaceSettings, useWorkspaceSettings } from "../hooks";
import type { PhaseConfig, PhaseType, WorkspaceSettings } from "../types";

/**
 * Implementer is required and always present. test_author and auditor are optional.
 * Order is fixed by the brief (test_author → implementer → auditor) — we never let
 * users reorder, only opt phases in or out.
 */
function buildPhases(
  includeTestAuthor: boolean,
  includeAuditor: boolean,
): PhaseType[] {
  const out: PhaseType[] = [];
  if (includeTestAuthor) out.push("test_author");
  out.push("implementer");
  if (includeAuditor) out.push("auditor");
  return out;
}

export function PhaseConfigPanel({ workspaceId }: { workspaceId: string }) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const update = useUpdateWorkspaceSettings(workspaceId);

  const initial = settingsQ.data?.default_phase_config;
  const [includeTestAuthor, setIncludeTestAuthor] = useState(false);
  const [includeAuditor, setIncludeAuditor] = useState(true);

  useEffect(() => {
    if (!initial) return;
    setIncludeTestAuthor(initial.phases.includes("test_author"));
    setIncludeAuditor(initial.phases.includes("auditor"));
  }, [initial]);

  if (settingsQ.isLoading || !settingsQ.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const settings = settingsQ.data;

  const next: PhaseConfig = {
    phases: buildPhases(includeTestAuthor, includeAuditor),
    gate_overrides: settings.default_phase_config.gate_overrides,
  };
  const dirty =
    JSON.stringify(next.phases) !==
    JSON.stringify(settings.default_phase_config.phases);

  const save = () => {
    const merged: WorkspaceSettings = {
      ...settings,
      default_phase_config: next,
    };
    update.mutate(merged);
  };

  // The three phase slots are rendered in pipeline order regardless of which
  // ones are currently enabled — the order is fixed by the brief, and showing
  // the disabled card greyed-out keeps the visual flow legible. The required
  // implementer is locked checked.
  const slots: Array<{
    id: string;
    label: PhaseType;
    description: string;
    checked: boolean;
    onChange?: (next: boolean) => void;
    required?: boolean;
  }> = [
    {
      id: "phase-test-author",
      label: "test_author",
      description: "Write failing tests before the implementer.",
      checked: includeTestAuthor,
      onChange: setIncludeTestAuthor,
    },
    {
      id: "phase-implementer",
      label: "implementer",
      description: "Required. Makes the code change.",
      checked: true,
      required: true,
    },
    {
      id: "phase-auditor",
      label: "auditor",
      description:
        "Reviews the diff and renders an approve / revise / reject verdict.",
      checked: includeAuditor,
      onChange: setIncludeAuditor,
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Phases run in this fixed order. Implementer is always included; the
        others are optional.
      </p>
      <div
        className="grid grid-cols-1 items-stretch gap-3 lg:gap-2 lg:[grid-template-columns:var(--phase-cols)]"
        style={
          {
            "--phase-cols": slots.map(() => "minmax(0,1fr)").join(" auto "),
          } as CSSProperties
        }
      >
        {slots.map((slot, idx) => (
          <Fragment key={slot.id}>
            <PhaseToggle
              id={slot.id}
              label={slot.label}
              description={slot.description}
              checked={slot.checked}
              disabled={slot.required}
              required={slot.required}
              stepIndex={idx + 1}
              onChange={slot.onChange}
            />
            {idx < slots.length - 1 && (
              <div
                className="text-muted-foreground/50 hidden items-center justify-center lg:flex"
                aria-hidden="true"
              >
                <CaretRight className="size-5" />
              </div>
            )}
          </Fragment>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        {update.error && (
          <span className="text-destructive text-xs">
            {String(update.error)}
          </span>
        )}
      </div>
    </div>
  );
}

function PhaseToggle({
  id,
  label,
  description,
  checked,
  disabled,
  stepIndex,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  stepIndex: number;
  onChange?: (next: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "bg-card flex cursor-pointer flex-col gap-2 rounded-md border p-3 transition-colors",
        !disabled && "hover:bg-muted/30",
        !checked && "opacity-60",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange?.(e.target.checked)}
          />
          <Label htmlFor={id} className="font-mono text-sm">
            {label}
          </Label>
        </div>
        <span className="text-muted-foreground/60 font-mono text-[10px] tabular-nums">
          {String(stepIndex).padStart(2, "0")}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{description}</p>
    </label>
  );
}
