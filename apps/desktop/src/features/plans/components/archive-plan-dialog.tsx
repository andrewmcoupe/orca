import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useArchivePlan,
  usePlanCascadePreview,
} from "@/features/plans/hooks";
import { CascadePreview } from "./cascade-preview";
import type { Plan } from "@/features/plans/types";

export function ArchivePlanDialog({
  plan,
  open,
  onOpenChange,
}: {
  plan: Plan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const archive = useArchivePlan();
  const preview = usePlanCascadePreview(plan.id, open);

  const submit = async () => {
    await archive.mutateAsync(plan.id);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) archive.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <div className="space-y-4">
          <DialogHeader>
            <DialogTitle>Archive plan</DialogTitle>
            <DialogDescription>
              Archiving halts every non-terminal task on this plan and stops
              any phase runs in flight.
            </DialogDescription>
          </DialogHeader>

          <CascadePreview
            previewQ={preview}
            actionVerb="cancelled"
            emptyHint="No active tasks on this plan."
          />

          {archive.error && (
            <p className="text-destructive text-xs">{String(archive.error)}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Keep plan
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={submit}
              disabled={archive.isPending}
            >
              {archive.isPending ? "Archiving…" : "Archive plan"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
