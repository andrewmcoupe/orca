import { useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCreateTask } from "@/features/tasks/hooks";
import type { ModelChoice, PhaseConfig, PhaseType, Task } from "@/features/tasks/types";
import { useActiveWorkspace, useWorkspaceSettings } from "@/features/workspaces/hooks";
import { ModelSelect } from "@/features/providers/components/model-select";

function buildPhases(testAuthor: boolean, auditor: boolean): PhaseType[] {
  const out: PhaseType[] = [];
  if (testAuthor) out.push("test_author");
  out.push("implementer");
  if (auditor) out.push("auditor");
  return out;
}

export function NewTaskDialog({
  planId,
  open,
  onOpenChange,
  onCreated,
}: {
  planId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (task: Task) => void;
}) {
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [includeTestAuthor, setIncludeTestAuthor] = useState(false);
  const [includeAuditor, setIncludeAuditor] = useState(true);
  const [modelOverrides, setModelOverrides] = useState<
    Record<string, ModelChoice>
  >({});
  const create = useCreateTask();
  const activeWs = useActiveWorkspace();
  const settings = useWorkspaceSettings(activeWs.data?.id);

  const defaultPhases =
    settings.data?.default_phase_config.phases ?? ["implementer", "auditor"];
  const workspaceDefaultModels = settings.data?.default_models ?? {};

  const reset = () => {
    setTitle("");
    setSpec("");
    setAdvancedOpen(false);
    setOverrideEnabled(false);
    setIncludeTestAuthor(defaultPhases.includes("test_author"));
    setIncludeAuditor(defaultPhases.includes("auditor"));
    setModelOverrides({});
    create.reset();
  };

  const phasesForModelControls = buildPhases(
    overrideEnabled ? includeTestAuthor : defaultPhases.includes("test_author"),
    overrideEnabled ? includeAuditor : defaultPhases.includes("auditor"),
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const hasModelOverrides = Object.keys(modelOverrides).length > 0;
    const buildPhaseConfig = overrideEnabled || hasModelOverrides;
    const phaseConfig: PhaseConfig | undefined = buildPhaseConfig
      ? {
          phases: overrideEnabled
            ? buildPhases(includeTestAuthor, includeAuditor)
            : defaultPhases,
          gate_overrides: null,
          models: hasModelOverrides ? modelOverrides : null,
        }
      : undefined;
    const task = await create.mutateAsync({
      planId,
      title: title.trim(),
      specMarkdown: spec,
      phaseConfig,
    });
    reset();
    onOpenChange(false);
    onCreated?.(task);
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
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What should the task accomplish?"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-spec">Spec</Label>
              <Textarea
                id="task-spec"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder="Optional. Markdown supported. Acceptance criteria, links, etc."
                rows={8}
              />
            </div>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
              >
                {advancedOpen ? (
                  <CaretDown className="size-3" />
                ) : (
                  <CaretRight className="size-3" />
                )}
                Advanced
              </button>
              {advancedOpen && (
                <div className="space-y-2 rounded-md border p-3">
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={overrideEnabled}
                      onChange={(e) => setOverrideEnabled(e.target.checked)}
                    />
                    <span>
                      Override phase config for this task. By default the task
                      inherits the workspace's{" "}
                      <code className="font-mono">
                        [{defaultPhases.join(", ")}]
                      </code>
                      .
                    </span>
                  </label>
                  {overrideEnabled && (
                    <div className="space-y-1.5 pl-5">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={includeTestAuthor}
                          onChange={(e) =>
                            setIncludeTestAuthor(e.target.checked)
                          }
                        />
                        <code className="font-mono">test_author</code>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" checked disabled />
                        <code className="font-mono">implementer</code>
                        <span>(required)</span>
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={includeAuditor}
                          onChange={(e) => setIncludeAuditor(e.target.checked)}
                        />
                        <code className="font-mono">auditor</code>
                      </label>
                    </div>
                  )}

                  <div className="border-t pt-3 space-y-2">
                    <div className="text-xs font-medium">Model overrides</div>
                    <p className="text-muted-foreground text-xs">
                      Pick a model per phase, or inherit the workspace default.
                    </p>
                    <div className="space-y-2">
                      {phasesForModelControls.map((phase) => {
                        const inherited = workspaceDefaultModels[phase];
                        const inheritLabel = inherited
                          ? `Workspace default (${inherited.model})`
                          : "Workspace default (provider default)";
                        return (
                          <div
                            key={phase}
                            className="grid grid-cols-[110px_1fr] items-center gap-2"
                          >
                            <Label className="font-mono text-xs">{phase}</Label>
                            <ModelSelect
                              size="sm"
                              value={modelOverrides[phase] ?? null}
                              onChange={(next) =>
                                setModelOverrides((prev) => {
                                  const out = { ...prev };
                                  if (next) out[phase] = next;
                                  else delete out[phase];
                                  return out;
                                })
                              }
                              nullLabel={inheritLabel}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          {create.error && (
            <p className="text-destructive text-xs">{String(create.error)}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
