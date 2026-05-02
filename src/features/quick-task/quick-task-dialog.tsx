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
import { useQueryClient } from "@tanstack/react-query";

export type QuickTaskResult = {
  workspaceId: string;
  planId: string;
  taskId: string;
};

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
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const reset = () => {
    setTitle("");
    setSpec("");
    setError(null);
    setPending(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || pending) return;
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
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
