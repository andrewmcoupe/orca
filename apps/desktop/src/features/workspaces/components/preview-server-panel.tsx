import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useSettings,
  useUpdateSettings,
  type SettingsScope,
} from "../hooks";
import {
  DEFAULT_PREVIEW_SERVER_SETTINGS,
  type PreviewServerSettings,
  type WorkspaceSettings,
} from "../types";

function withDefaults(
  settings: PreviewServerSettings | undefined,
): PreviewServerSettings {
  return { ...DEFAULT_PREVIEW_SERVER_SETTINGS, ...(settings ?? {}) };
}

export function PreviewServerPanel({
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
  const [draft, setDraft] = useState<PreviewServerSettings>(
    DEFAULT_PREVIEW_SERVER_SETTINGS,
  );

  useEffect(() => {
    if (!settingsQ.data) return;
    setDraft(withDefaults(settingsQ.data.preview_server));
  }, [settingsQ.data]);

  if (settingsQ.isLoading || !settingsQ.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  const settings = settingsQ.data;
  const current = withDefaults(settings.preview_server);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);
  const commandMissing = draft.enabled && !draft.command?.trim();

  const save = () => {
    const next: WorkspaceSettings = {
      ...settings,
      preview_server: {
        ...draft,
        command: draft.command?.trim() ? draft.command : null,
        base_url: draft.base_url.trim() || DEFAULT_PREVIEW_SERVER_SETTINGS.base_url,
        health_path: normalizePath(draft.health_path),
        default_route_path: normalizePath(draft.default_route_path),
        startup_timeout_seconds: Math.max(1, draft.startup_timeout_seconds),
      },
    };
    update.mutate(next);
  };

  return (
    <div className="space-y-4">
      <ToggleField
        checked={draft.enabled}
        onChange={(enabled) => setDraft({ ...draft, enabled })}
        label="Enable preview server"
        help="Adds the task action for opening a frontend dev server from the task worktree."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="preview-command">Command</Label>
          <Input
            id="preview-command"
            value={draft.command ?? ""}
            placeholder="pnpm dev --host 127.0.0.1"
            onChange={(e) =>
              setDraft({
                ...draft,
                command: e.target.value.trim() ? e.target.value : null,
              })
            }
            className="font-mono"
            disabled={!draft.enabled}
          />
          <p className="text-muted-foreground text-[11px]">
            Runs from the task worktree via the system shell and receives the
            workspace additional environment variables from Reliability.
          </p>
        </div>

        <TextField
          id="preview-base-url"
          label="Base URL"
          value={draft.base_url}
          disabled={!draft.enabled}
          placeholder={DEFAULT_PREVIEW_SERVER_SETTINGS.base_url}
          onChange={(base_url) => setDraft({ ...draft, base_url })}
        />
        <TextField
          id="preview-health-path"
          label="Health path"
          value={draft.health_path}
          disabled={!draft.enabled}
          placeholder="/"
          onChange={(health_path) => setDraft({ ...draft, health_path })}
        />
        <TextField
          id="preview-default-route"
          label="Default route path"
          value={draft.default_route_path}
          disabled={!draft.enabled}
          placeholder="/"
          onChange={(default_route_path) =>
            setDraft({ ...draft, default_route_path })
          }
        />
        <NumberField
          label="Startup timeout (seconds)"
          value={draft.startup_timeout_seconds}
          disabled={!draft.enabled}
          min={1}
          onChange={(startup_timeout_seconds) =>
            setDraft({ ...draft, startup_timeout_seconds })
          }
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || commandMissing || update.isPending}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        {commandMissing && (
          <span className="text-destructive text-xs">
            Command is required when enabled.
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

function TextField({
  id,
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
      />
    </div>
  );
}

function ToggleField({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
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
  value,
  onChange,
  min,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        value={value}
        disabled={disabled}
        onChange={(e) =>
          onChange(Math.max(min ?? 0, Number(e.target.value) || (min ?? 0)))
        }
      />
    </div>
  );
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+/, "")}`;
}
