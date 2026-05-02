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
import { useCreatePlan } from "@/features/plans/hooks";
import type { Plan } from "@/features/plans/types";

export function NewPlanDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (plan: Plan) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const create = useCreatePlan();

  const reset = () => {
    setTitle("");
    setDescription("");
    create.reset();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const plan = await create.mutateAsync({
      title: title.trim(),
      description: description.trim(),
      source: "manual",
      source_metadata: null,
    });
    reset();
    onOpenChange(false);
    onCreated?.(plan);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New plan</DialogTitle>
            <DialogDescription>
              A plan groups related tasks. You can add tasks once it's created.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="plan-title">Title</Label>
              <Input
                id="plan-title"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What is this plan about?"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-description">Description</Label>
              <Textarea
                id="plan-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional. Markdown supported."
                rows={5}
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
              {create.isPending ? "Creating…" : "Create plan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
