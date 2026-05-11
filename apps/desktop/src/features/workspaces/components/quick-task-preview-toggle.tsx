import { useSettings, useUpdateSettings, type SettingsScope } from "../hooks";

export function QuickTaskPreviewToggle({
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

  if (!settingsQ.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  const settings = settingsQ.data;
  const skip = settings.skip_preview_for_quick_tasks ?? false;

  return (
    <div className="space-y-2">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={skip}
          onChange={(e) =>
            update.mutate({
              ...settings,
              skip_preview_for_quick_tasks: e.target.checked,
            })
          }
          disabled={update.isPending}
        />
        <span>
          Skip preview for ⌘N quick tasks
          <p className="text-muted-foreground text-xs font-normal">
            By default the quick-task dialog shows the model and permission
            mode of every phase before starting, so you can confirm what's
            about to run. Turn this on once you've internalised the defaults.
          </p>
        </span>
      </label>
      {update.error && (
        <p className="text-destructive text-xs">{String(update.error)}</p>
      )}
    </div>
  );
}
