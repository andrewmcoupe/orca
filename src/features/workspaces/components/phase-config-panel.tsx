import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from "../hooks";
import type { PhaseConfig, PhaseType, WorkspaceSettings } from "../types";

/**
 * Implementer is required and always present. test_author and auditor are optional.
 * Order is fixed by the brief (test_author → implementer → auditor) — we never let
 * users reorder, only opt phases in or out.
 */
function buildPhases(includeTestAuthor: boolean, includeAuditor: boolean): PhaseType[] {
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

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Phases run in this fixed order. Implementer is always included; the
        others are optional.
      </p>
      <div className="space-y-2">
        <PhaseToggle
          id="phase-test-author"
          label="test_author"
          description="Write failing tests before the implementer."
          checked={includeTestAuthor}
          onChange={setIncludeTestAuthor}
        />
        <PhaseToggle
          id="phase-implementer"
          label="implementer"
          description="Required. Makes the code change."
          checked
          disabled
        />
        <PhaseToggle
          id="phase-auditor"
          label="auditor"
          description="Reviews the diff and renders an approve / revise / reject verdict."
          checked={includeAuditor}
          onChange={setIncludeAuditor}
        />
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
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted/30"
    >
      <input
        id={id}
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="font-mono text-sm">
          {label}
        </Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
    </label>
  );
}
