import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowSquareOut, Stop, Warning } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useStartPreviewServer,
  useStopPreviewServer,
  usePreviewServerStatus,
} from "@/features/preview-server/hooks";
import {
  DEFAULT_PREVIEW_SERVER_SETTINGS,
  type WorkspaceSettings,
} from "@/features/workspaces/types";
import type { Task } from "@/features/tasks/types";

export function PreviewServerDialog({
  task,
  settings,
  open,
  onOpenChange,
}: {
  task: Task;
  settings: WorkspaceSettings | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const previewSettings = {
    ...DEFAULT_PREVIEW_SERVER_SETTINGS,
    ...(settings?.preview_server ?? {}),
  };
  const statusQ = usePreviewServerStatus();
  const start = useStartPreviewServer();
  const stop = useStopPreviewServer();
  const status = statusQ.data;
  const refetchStatus = statusQ.refetch;

  const [routePath, setRoutePath] = useState(previewSettings.default_route_path);

  useEffect(() => {
    if (!open) return;
    setRoutePath(previewSettings.default_route_path);
  }, [open, previewSettings.default_route_path]);

  const normalizedRoute = useMemo(() => normalizePath(routePath), [routePath]);
  const missingConfig =
    !previewSettings.enabled || !previewSettings.command?.trim();
  const noWorktree = !task.worktree_path || task.worktree_status !== "active";
  const sameTaskRunning =
    status?.task_id === task.id &&
    (status.state === "running" || status.state === "starting");
  const otherTaskRunning =
    !!status?.task_id &&
    status.task_id !== task.id &&
    (status.state === "running" || status.state === "starting");
  const showLogs =
    start.isPending ||
    sameTaskRunning ||
    otherTaskRunning ||
    status?.state === "failed";
  const logLines = status?.logs ?? [];

  useEffect(() => {
    if (!open) return;
    void refetchStatus();
    const interval = window.setInterval(
      () => void refetchStatus(),
      start.isPending ? 750 : 2_000,
    );
    return () => window.clearInterval(interval);
  }, [open, start.isPending, refetchStatus]);

  const openCurrentUrl = async () => {
    if (status?.open_url) {
      await openUrl(status.open_url);
    }
  };

  const onStart = async () => {
    const result = await start.mutateAsync({
      taskId: task.id,
      routePath: normalizedRoute,
    });
    if (result.state === "running" && result.open_url) {
      await openUrl(result.open_url);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-lg">
        <DialogHeader className="min-w-0">
          <DialogTitle>Preview</DialogTitle>
          <DialogDescription>
            Start the configured frontend dev server from this task worktree and
            open the route in your browser.
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-styled min-w-0 space-y-4 overflow-y-auto pr-1">
          {missingConfig && (
            <Notice>
              Preview server support is not enabled or the command is empty.
              {" "}
              <Link
                to="/workspace/$workspaceId/settings"
                params={{ workspaceId: task.workspace_id }}
                className="font-medium underline underline-offset-2"
              >
                Configure it in Workspace settings
              </Link>{" "}
              before starting.
            </Notice>
          )}

          {noWorktree && (
            <Notice>
              This task does not have an active worktree, so Orca cannot start
              a preview server for it.
            </Notice>
          )}

          {task.worktree_path && task.worktree_init_status !== "initialized" && (
            <Notice>
              Worktree initialization is not marked initialized. You can still
              start the dev server, but dependencies may be missing.
            </Notice>
          )}

          {otherTaskRunning && (
            <Notice>
              A preview server is already running for another task. Only one
              preview server can run at a time.
            </Notice>
          )}

          <div className="min-w-0 grid gap-3 rounded-sm border bg-muted/20 p-3">
            <MetaRow
              label="Command"
              value={previewSettings.command || "Not configured"}
            />
            <MetaRow label="Base URL" value={previewSettings.base_url} />
            {task.worktree_path && (
              <MetaRow label="Worktree" value={task.worktree_path} />
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="preview-route">Route path</Label>
            <Input
              id="preview-route"
              value={routePath}
              onChange={(e) => setRoutePath(e.target.value)}
              placeholder="/"
              className="font-mono"
              disabled={sameTaskRunning || otherTaskRunning}
            />
          </div>

          {showLogs && (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label>Preview logs</Label>
                <span className="text-muted-foreground text-[11px]">
                  {status?.state ?? (start.isPending ? "starting" : "idle")}
                </span>
              </div>
              <pre className="scrollbar-styled max-h-44 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-sm border bg-zinc-950 p-2 text-[11px] leading-relaxed text-zinc-100">
                {logLines.length > 0
                  ? logLines.slice(-80).join("\n")
                  : "Waiting for preview server output..."}
              </pre>
            </div>
          )}

          {(start.error || stop.error || status?.last_error) && (
            <p className="text-destructive text-xs [overflow-wrap:anywhere]">
              {String(start.error || stop.error || status?.last_error)}
            </p>
          )}
        </div>

        <DialogFooter className="min-w-0 flex-wrap">
          {sameTaskRunning ? (
            <>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => stop.mutate()}
                disabled={stop.isPending}
                className="gap-1"
              >
                <Stop className="size-4" />
                {stop.isPending ? "Stopping…" : "Stop server"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void openCurrentUrl()}
                disabled={!status?.open_url}
                className="gap-1"
              >
                <ArrowSquareOut className="size-4" />
                Reopen browser
              </Button>
            </>
          ) : otherTaskRunning ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              className="gap-1"
            >
              <Stop className="size-4" />
              {stop.isPending ? "Stopping…" : "Stop existing server"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void onStart()}
              disabled={missingConfig || noWorktree || start.isPending}
              className="gap-1"
            >
              <ArrowSquareOut className="size-4" />
              {start.isPending ? "Starting…" : "Start and open"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Notice({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex gap-2 rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
      <Warning className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 break-words">{children}</p>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[90px_minmax(0,1fr)] gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <code className="min-w-0 whitespace-pre-wrap break-all font-mono leading-relaxed">
        {value}
      </code>
    </div>
  );
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+/, "")}`;
}
