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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePassBackToImplementer } from "@/features/tasks/hooks";

/**
 * Pass-back dialog: lets the user optionally annotate the auditor's feedback
 * before re-running the implementer. The implementer treats user feedback as
 * authoritative if it conflicts with the auditor's concerns.
 */
export function PassBackDialog({
  taskId,
  open,
  onOpenChange,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const passBack = usePassBackToImplementer();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = feedback.trim();
    await passBack.mutateAsync({
      taskId,
      userFeedback: trimmed.length > 0 ? trimmed : null,
    });
    setFeedback("");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFeedback("");
          passBack.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Pass back to implementer</DialogTitle>
            <DialogDescription>
              The implementer will re-run with the auditor's concerns as
              context. Add feedback below to override or extend them — the
              implementer treats your feedback as authoritative on conflict.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label
              htmlFor="passback-feedback"
              className="text-muted-foreground text-[11px] uppercase tracking-wide"
            >
              Your feedback (optional)
            </Label>
            <Textarea
              id="passback-feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={4}
              placeholder="Anything to add or override?"
              disabled={passBack.isPending}
              autoFocus
            />
          </div>
          {passBack.error && (
            <p className="text-destructive text-xs">
              {String(passBack.error)}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={passBack.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={passBack.isPending}>
              {passBack.isPending ? "Passing back…" : "Pass back"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
