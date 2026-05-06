import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { FileOverlap } from "../types";

/**
 * Brief 4 / M8: pre-start file-overlap warning. Shown when the user is
 * about to start a task that touches files another in-flight task is
 * also working on. Soft warning — the user can proceed anyway, in which
 * case we tag the (starting, other) ordered pair in the session-level
 * suppression set so we don't ask again the same session.
 */
export function FileOverlapDialog({
  open,
  onOpenChange,
  overlaps,
  onProceed,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  overlaps: FileOverlap[];
  onProceed: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>File overlap detected</DialogTitle>
          <DialogDescription>
            This task touches files that another in-flight task is also
            working on. Conflicts may arise when both tasks merge.
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-styled space-y-3 max-h-72 overflow-y-auto">
          {overlaps.map((o) => (
            <div
              key={o.other_task_id}
              className="border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
            >
              <div className="font-medium mb-1 text-warning">
                Task "{o.other_task_title}" is touching:
              </div>
              <ul className="space-y-0.5">
                {o.overlapping_files.map((path) => (
                  <li key={path}>
                    <code className="font-mono text-[11px]">{path}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onProceed}>
            Proceed anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Build a stable session-level key for an ordered (starting, other) pair.
 * Used by callers to track suppression — once the user dismisses the
 * warning for a given pair, we don't bother them with it again until the
 * app restarts. Per the brief: "don't persist suppression across app
 * restarts. Sessions are short enough that re-prompting on restart is
 * fine."
 */
export function overlapPairKey(startingTaskId: string, otherTaskId: string) {
  return `${startingTaskId}:${otherTaskId}`;
}
