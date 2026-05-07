import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { plansApi } from "@/features/plans/api";
import { tasksApi } from "@/features/tasks/api";
import { TaskCreationPreview } from "@/features/tasks/components/task-creation-preview";
import type { PhaseConfig } from "@/features/tasks/types";
import { useWorkspaceSettings } from "@/features/workspaces/hooks";
import { useQueryClient } from "@tanstack/react-query";

export type QuickTaskResult = {
  workspaceId: string;
  planId: string;
  taskId: string;
};

type Step = "form" | "preview";

export function QuickTaskDialog({
  workspaceId,
  open,
  onOpenChange,
  onCreated,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (r: QuickTaskResult) => void;
}) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const settings = settingsQ.data;
  const skipPreview = settings?.skip_preview_for_quick_tasks ?? false;

  const [step, setStep] = useState<Step>("form");
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewPhaseConfig, setPreviewPhaseConfig] =
    useState<PhaseConfig | null>(null);
  const qc = useQueryClient();

  const reset = () => {
    setStep("form");
    setTitle("");
    setSpec("");
    setError(null);
    setPending(false);
    setPreviewPhaseConfig(null);
  };

  const create = async (phaseConfig?: PhaseConfig) => {
    setPending(true);
    setError(null);
    try {
      // The brief: a plan with source="manual", title=task title, description="",
      // then a single task inside it with the supplied title and spec. The user
      // thinks "I made a task" — the system has a plan with one task.
      const plan = await plansApi.create({
        title: title.trim(),
        description: "",
        source: "manual",
      });
      const task = await tasksApi.create({
        planId: plan.id,
        title: title.trim(),
        specMarkdown: spec,
        phaseConfig,
      });
      qc.invalidateQueries({ queryKey: ["plan"] });
      qc.invalidateQueries({ queryKey: ["task"] });
      reset();
      onOpenChange(false);
      onCreated({ workspaceId, planId: plan.id, taskId: task.id });
    } catch (err) {
      setError(String(err));
      setPending(false);
    }
  };

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || pending) return;
    if (skipPreview || !settings) {
      await create();
      return;
    }
    setPreviewPhaseConfig({
      phases: settings.default_phase_config.phases,
      gate_overrides: null,
      models: null,
      permission_modes: null,
    });
    setStep("preview");
  };

  const confirmPreview = async () => {
    if (!previewPhaseConfig) return;
    const hasOverrides =
      (previewPhaseConfig.models &&
        Object.keys(previewPhaseConfig.models).length > 0) ||
      (previewPhaseConfig.permission_modes &&
        Object.keys(previewPhaseConfig.permission_modes).length > 0);
    await create(hasOverrides ? previewPhaseConfig : undefined);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {step === "form" ? (
          <form onSubmit={submitForm} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Quick task</DialogTitle>
              <DialogDescription>
                Creates a one-task plan for ad-hoc work.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="quick-task-title">Title</Label>
                <Input
                  id="quick-task-title"
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What needs doing?"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quick-task-spec">
                  Spec{" "}
                  <span className="text-muted-foreground text-xs font-normal">
                    (optional)
                  </span>
                </Label>
                <Textarea
                  id="quick-task-spec"
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                  placeholder="Markdown supported."
                  rows={6}
                />
              </div>
            </div>
            {error && <p className="text-destructive text-xs">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!title.trim() || pending}>
                {pending ? "Creating…" : skipPreview ? "Create" : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>Confirm task</DialogTitle>
            </DialogHeader>
            {!settings || !previewPhaseConfig ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : (
              <TaskCreationPreview
                title={title.trim()}
                spec={spec}
                phaseConfig={previewPhaseConfig}
                workspaceSettings={settings}
                onPhaseConfigChange={setPreviewPhaseConfig}
                onBack={() => setStep("form")}
                onConfirm={confirmPreview}
                pending={pending}
                error={error}
                confirmLabel="Create task"
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
