import { useState } from "react";
import { Archive, Pause, Play, PencilSimple, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { usePausePlan, useResumePlan } from "@/features/plans/hooks";
import { EditPlanDialog } from "./edit-plan-dialog";
import { CancelPlanDialog } from "./cancel-plan-dialog";
import { ArchivePlanDialog } from "./archive-plan-dialog";
import type { Plan } from "@/features/plans/types";

export function PlanActions({ plan }: { plan: Plan }) {
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const pause = usePausePlan();
  const resume = useResumePlan();

  const isActive = plan.status === "active";
  const isPaused = plan.status === "paused";
  const isTerminal =
    plan.status === "completed" ||
    plan.status === "cancelled" ||
    plan.status === "archived";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!isTerminal && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
        >
          <PencilSimple />
          Edit
        </Button>
      )}
      {isActive && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => pause.mutate({ planId: plan.id, reason: null })}
          disabled={pause.isPending}
        >
          <Pause />
          Pause
        </Button>
      )}
      {isPaused && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => resume.mutate(plan.id)}
          disabled={resume.isPending}
        >
          <Play />
          Resume
        </Button>
      )}
      {!isTerminal && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCancelling(true)}
        >
          <X />
          Cancel
        </Button>
      )}
      {plan.status !== "archived" && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setArchiving(true)}
        >
          <Archive />
          Archive
        </Button>
      )}
      <EditPlanDialog plan={plan} open={editing} onOpenChange={setEditing} />
      <CancelPlanDialog
        plan={plan}
        open={cancelling}
        onOpenChange={setCancelling}
      />
      <ArchivePlanDialog
        plan={plan}
        open={archiving}
        onOpenChange={setArchiving}
      />
    </div>
  );
}
