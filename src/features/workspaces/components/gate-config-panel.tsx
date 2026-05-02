import { useEffect, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from "../hooks";
import type { GateConfig, PhaseType, WorkspaceSettings } from "../types";

type GateRow = { name: string; command: string; timeout_seconds: number };

const PHASE_NAMES: PhaseType[] = ["test_author", "implementer", "auditor"];

function settingsToRows(gates: Record<string, GateConfig>): GateRow[] {
  return Object.entries(gates).map(([name, g]) => ({
    name,
    command: g.command,
    timeout_seconds: g.timeout_seconds,
  }));
}

function rowsToGates(rows: GateRow[]): Record<string, GateConfig> {
  const out: Record<string, GateConfig> = {};
  for (const r of rows) {
    if (!r.name.trim()) continue;
    out[r.name] = {
      command: r.command,
      timeout_seconds: r.timeout_seconds,
    };
  }
  return out;
}

export function GateConfigPanel({ workspaceId }: { workspaceId: string }) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const update = useUpdateWorkspaceSettings(workspaceId);

  const [rows, setRows] = useState<GateRow[]>([]);
  const [phaseGates, setPhaseGates] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!settingsQ.data) return;
    setRows(settingsToRows(settingsQ.data.gates));
    setPhaseGates(settingsQ.data.phase_gates ?? {});
  }, [settingsQ.data]);

  if (settingsQ.isLoading || !settingsQ.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const settings = settingsQ.data;

  const knownGateNames = rows.map((r) => r.name).filter((n) => n.trim() !== "");
  const dirty =
    JSON.stringify(rowsToGates(rows)) !== JSON.stringify(settings.gates) ||
    JSON.stringify(phaseGates) !== JSON.stringify(settings.phase_gates ?? {});
  const hasDuplicate = (() => {
    const names = rows.map((r) => r.name);
    return new Set(names).size !== names.length;
  })();

  const save = () => {
    const merged: WorkspaceSettings = {
      ...settings,
      gates: rowsToGates(rows),
      phase_gates: Object.fromEntries(
        Object.entries(phaseGates)
          .map(([phase, gateNames]) => [
            phase,
            gateNames.filter((g) => knownGateNames.includes(g)),
          ])
          .filter(([, list]) => (list as string[]).length > 0),
      ),
    };
    update.mutate(merged);
  };

  const addRow = () =>
    setRows((rs) => [...rs, { name: "", command: "", timeout_seconds: 60 }]);
  const removeRow = (idx: number) =>
    setRows((rs) => rs.filter((_, i) => i !== idx));
  const updateRow = (idx: number, patch: Partial<GateRow>) =>
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const togglePhaseGate = (phase: PhaseType, gateName: string) => {
    setPhaseGates((current) => {
      const list = current[phase] ?? [];
      const next = list.includes(gateName)
        ? list.filter((g) => g !== gateName)
        : [...list, gateName];
      return { ...current, [phase]: next };
    });
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          Gates are commands run from the worktree directory. A gate passes if
          its command exits 0.
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-xs italic">
            No gates configured.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((row, idx) => (
              <div
                key={idx}
                className="grid grid-cols-[160px_1fr_88px_auto] items-center gap-2 rounded-md border p-2"
              >
                <Input
                  placeholder="name"
                  value={row.name}
                  onChange={(e) => updateRow(idx, { name: e.target.value })}
                  className="font-mono"
                />
                <Input
                  placeholder="pnpm test"
                  value={row.command}
                  onChange={(e) => updateRow(idx, { command: e.target.value })}
                  className="font-mono"
                />
                <Input
                  type="number"
                  min={1}
                  value={row.timeout_seconds}
                  onChange={(e) =>
                    updateRow(idx, {
                      timeout_seconds: Math.max(1, Number(e.target.value) || 1),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove gate"
                  onClick={() => removeRow(idx)}
                >
                  <Trash className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addRow}
          className="gap-1"
        >
          <Plus className="size-3" /> Add gate
        </Button>
      </div>

      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Run after phase
        </Label>
        <div className="space-y-2">
          {PHASE_NAMES.map((phase) => (
            <div key={phase} className="rounded-md border p-3">
              <div className="font-mono text-sm">{phase}</div>
              {knownGateNames.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Add a gate above to assign it.
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {knownGateNames.map((gateName) => {
                    const checked = (phaseGates[phase] ?? []).includes(
                      gateName,
                    );
                    return (
                      <label
                        key={gateName}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-2 py-1 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePhaseGate(phase, gateName)}
                        />
                        <span className="font-mono">{gateName}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || hasDuplicate || update.isPending}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        {hasDuplicate && (
          <span className="text-destructive text-xs">
            Duplicate gate names.
          </span>
        )}
        {update.error && (
          <span className="text-destructive text-xs">
            {String(update.error)}
          </span>
        )}
      </div>
    </div>
  );
}
