import { useState } from "react";
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
import type { Task } from "@/features/tasks/types";

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
  const create = useCreateTask();

  const reset = () => {
    setTitle("");
    setSpec("");
    create.reset();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const task = await create.mutateAsync({
      planId,
      title: title.trim(),
      specMarkdown: spec,
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
