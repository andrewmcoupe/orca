import { useEffect, useState } from "react";
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
import { useRevisePlan } from "@/features/plans/hooks";
import type { Plan } from "@/features/plans/types";

export function EditPlanDialog({
  plan,
  open,
  onOpenChange,
}: {
  plan: Plan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState(plan.title);
  const [description, setDescription] = useState(plan.description);
  const [reason, setReason] = useState("");
  const revise = useRevisePlan();

  useEffect(() => {
    if (open) {
      setTitle(plan.title);
      setDescription(plan.description);
      setReason("");
      revise.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan.title, plan.description]);

  const dirty = title !== plan.title || description !== plan.description;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || !title.trim()) return;
    await revise.mutateAsync({
      planId: plan.id,
      title: title.trim(),
      description,
      reason: reason.trim() || null,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Edit plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-plan-title">Title</Label>
              <Input
                id="edit-plan-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-plan-description">Description</Label>
              <Textarea
                id="edit-plan-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={8}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-plan-reason">
                Reason{" "}
                <span className="text-muted-foreground text-xs font-normal">
                  (optional)
                </span>
              </Label>
              <Input
                id="edit-plan-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this revision?"
              />
            </div>
          </div>
          {revise.error && (
            <p className="text-destructive text-xs">{String(revise.error)}</p>
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
              disabled={!dirty || !title.trim() || revise.isPending}
            >
              {revise.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
