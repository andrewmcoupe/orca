import { useEffect, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from "../hooks";
import {
  DEFAULT_PHASE_TIMEOUTS,
  DEFAULT_SUBPROCESS_SETTINGS,
  DEFAULT_WORKTREE_INIT,
  type PhaseTimeoutSettings,
  type SubprocessSettings,
  type WorkspaceSettings,
  type WorktreeInitSettings,
} from "../types";

type EnvRow = { key: string; value: string };
type EnvParseResult = {
  rows: EnvRow[];
  skipped: string[];
};

function envToRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function rowsToEnv(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.key.trim()) continue;
    out[r.key] = r.value;
  }
  return out;
}

function parseEnvBlock(text: string): EnvParseResult {
  const rows: EnvRow[] = [];
  const skipped: string[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;

    const normalized = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      skipped.push(`Line ${index + 1}`);
      return;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      skipped.push(`Line ${index + 1}`);
      return;
    }

    rows.push({
      key,
      value: stripEnvQuotes(normalized.slice(equalsIndex + 1).trim()),
    });
  });

  return { rows, skipped };
}

function stripEnvQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return value.slice(1, -1);
  }
  return value;
}

function mergeEnvRows(existing: EnvRow[], incoming: EnvRow[]): EnvRow[] {
  const next = [...existing];
  const indexByKey = new Map(
    next.map((row, index) => [row.key.trim(), index] as const),
  );

  for (const row of incoming) {
    const existingIndex = indexByKey.get(row.key);
    if (existingIndex == null) {
      indexByKey.set(row.key, next.length);
      next.push(row);
    } else {
      next[existingIndex] = row;
    }
  }

  return next;
}

/**
 * Reliability settings: worktree init, per-phase timeouts, and additional
 * subprocess env vars. All fields ship with sane defaults — power users edit
 * here when their project deviates (custom install command, very long-running
 * tests, project-specific PATH overrides).
 */
export function ReliabilityPanel({ workspaceId }: { workspaceId: string }) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const update = useUpdateWorkspaceSettings(workspaceId);

  const [init, setInit] = useState<WorktreeInitSettings>(DEFAULT_WORKTREE_INIT);
  const [timeouts, setTimeouts] = useState<PhaseTimeoutSettings>(
    DEFAULT_PHASE_TIMEOUTS,
  );
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [bulkEnvText, setBulkEnvText] = useState("");
  const [bulkEnvSkipped, setBulkEnvSkipped] = useState<string[]>([]);

  useEffect(() => {
    if (!settingsQ.data) return;
    setInit({ ...DEFAULT_WORKTREE_INIT, ...(settingsQ.data.worktree_init ?? {}) });
    setTimeouts({
      ...DEFAULT_PHASE_TIMEOUTS,
      ...(settingsQ.data.phase_timeouts ?? {}),
    });
    setEnvRows(envToRows(settingsQ.data.subprocess?.additional_env ?? {}));
  }, [settingsQ.data]);

  if (settingsQ.isLoading || !settingsQ.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const settings = settingsQ.data;

  const subprocessSettings: SubprocessSettings = {
    additional_env: rowsToEnv(envRows),
  };
  const dirty =
    JSON.stringify(init) !==
      JSON.stringify(settings.worktree_init ?? DEFAULT_WORKTREE_INIT) ||
    JSON.stringify(timeouts) !==
      JSON.stringify(settings.phase_timeouts ?? DEFAULT_PHASE_TIMEOUTS) ||
    JSON.stringify(subprocessSettings) !==
      JSON.stringify(settings.subprocess ?? DEFAULT_SUBPROCESS_SETTINGS);

  const hasDuplicateEnv = (() => {
    const keys = envRows.map((r) => r.key.trim()).filter(Boolean);
    return new Set(keys).size !== keys.length;
  })();

  const save = () => {
    const next: WorkspaceSettings = {
      ...settings,
      worktree_init: init,
      phase_timeouts: timeouts,
      subprocess: subprocessSettings,
    };
    update.mutate(next);
  };

  const importBulkEnv = () => {
    const parsed = parseEnvBlock(bulkEnvText);
    setBulkEnvSkipped(parsed.skipped);
    if (parsed.rows.length === 0) return;
    setEnvRows(mergeEnvRows(envRows, parsed.rows));
    setBulkEnvText("");
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Worktree initialization
        </h3>
        <ToggleField
          checked={init.enabled}
          onChange={(v) => setInit({ ...init, enabled: v })}
          label="Run init when a worktree is created"
          help="Disable to skip dependency installation entirely."
        />
        <ToggleField
          checked={init.detection_enabled}
          onChange={(v) => setInit({ ...init, detection_enabled: v })}
          label="Auto-detect project type"
          help="Detects pnpm, npm, yarn, uv, poetry, pip, cargo, go. Ignored if a custom command is set."
          disabled={!init.enabled}
        />
        <div className="space-y-1">
          <Label htmlFor="init-user-command" className="text-xs">
            Custom init command
          </Label>
          <Input
            id="init-user-command"
            value={init.user_command ?? ""}
            placeholder="(none — use detection)"
            onChange={(e) =>
              setInit({
                ...init,
                user_command: e.target.value.trim() ? e.target.value : null,
              })
            }
            className="font-mono"
            disabled={!init.enabled}
          />
          <p className="text-muted-foreground text-[11px]">
            Overrides detection. Runs in the worktree via <code>sh -c</code>.
          </p>
        </div>
        <NumberField
          label="Init timeout (seconds)"
          value={init.timeout_seconds}
          onChange={(v) => setInit({ ...init, timeout_seconds: v })}
          min={1}
          placeholder={String(DEFAULT_WORKTREE_INIT.timeout_seconds)}
          disabled={!init.enabled}
        />
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Phase timeouts
        </h3>
        <NumberField
          label="Silence timeout (seconds)"
          help="Kill a phase that produces no output for this long. Often signals a stuck or prompt-blocked agent."
          value={timeouts.silence_timeout_seconds}
          onChange={(v) =>
            setTimeouts({ ...timeouts, silence_timeout_seconds: v })
          }
          min={1}
          placeholder={String(DEFAULT_PHASE_TIMEOUTS.silence_timeout_seconds)}
        />
        <NumberField
          label="Wall-clock timeout (seconds)"
          help="Hard cap on total phase runtime. Catches loops the silence timer can't see."
          value={timeouts.wall_clock_timeout_seconds}
          onChange={(v) =>
            setTimeouts({ ...timeouts, wall_clock_timeout_seconds: v })
          }
          min={1}
          placeholder={String(DEFAULT_PHASE_TIMEOUTS.wall_clock_timeout_seconds)}
        />
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Additional environment variables
          </h3>
          <p className="text-muted-foreground text-[11px]">
            Merged into every phase subprocess and preview server process.
          </p>
        </div>
        <div className="space-y-2 rounded-sm border bg-muted/20 p-3">
          <div className="space-y-1">
            <Label htmlFor="bulk-env-import" className="text-xs">
              Paste key-value pairs
            </Label>
            <Textarea
              id="bulk-env-import"
              value={bulkEnvText}
              placeholder={"API_URL=https://example.test\nVITE_FLAG=true"}
              onChange={(e) => {
                setBulkEnvText(e.target.value);
                if (bulkEnvSkipped.length > 0) setBulkEnvSkipped([]);
              }}
              className="min-h-24 font-mono"
            />
            <p className="text-muted-foreground text-[11px]">
              Accepts <code>KEY=value</code> lines and <code>export KEY=value</code>.
              Existing keys are updated.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={importBulkEnv}
              disabled={!bulkEnvText.trim()}
            >
              Import variables
            </Button>
            {bulkEnvSkipped.length > 0 && (
              <span className="text-amber-700 text-xs dark:text-amber-300">
                Skipped {bulkEnvSkipped.join(", ")}.
              </span>
            )}
          </div>
        </div>
        {envRows.length === 0 ? (
          <p className="text-muted-foreground text-xs">No extra vars set.</p>
        ) : (
          <div className="space-y-2">
            {envRows.map((row, idx) => (
              <div
                key={idx}
                className="grid grid-cols-[1fr_2fr_auto] items-center gap-2"
              >
                <Input
                  placeholder="VAR_NAME"
                  value={row.key}
                  onChange={(e) => {
                    const next = [...envRows];
                    next[idx] = { ...next[idx], key: e.target.value };
                    setEnvRows(next);
                  }}
                  className="font-mono"
                />
                <Input
                  placeholder="value"
                  value={row.value}
                  onChange={(e) => {
                    const next = [...envRows];
                    next[idx] = { ...next[idx], value: e.target.value };
                    setEnvRows(next);
                  }}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove variable"
                  onClick={() =>
                    setEnvRows(envRows.filter((_, i) => i !== idx))
                  }
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
          onClick={() => setEnvRows([...envRows, { key: "", value: "" }])}
          className="gap-1"
        >
          <Plus className="size-3" /> Add variable
        </Button>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || hasDuplicateEnv || update.isPending}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        {hasDuplicateEnv && (
          <span className="text-destructive text-xs">
            Duplicate variable names.
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

function ToggleField({
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2 text-sm ${disabled ? "opacity-60" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span className="space-y-0.5">
        <span>{label}</span>
        {help && (
          <span className="text-muted-foreground block text-[11px]">{help}</span>
        )}
      </span>
    </label>
  );
}

function NumberField({
  label,
  help,
  value,
  onChange,
  min,
  placeholder,
  disabled,
}: {
  label: string;
  help?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={min}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) =>
          onChange(Math.max(min ?? 0, Number(e.target.value) || (min ?? 0)))
        }
      />
      {help && (
        <p className="text-muted-foreground text-[11px]">{help}</p>
      )}
    </div>
  );
}
