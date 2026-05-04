import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Archive,
  ChatCircleText,
  Copy,
  DotsThree,
  Pause,
  PencilSimple,
  Play,
  X,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePausePlan, useResumePlan } from "@/features/plans/hooks";
import { EditPlanDialog } from "./edit-plan-dialog";
import { CancelPlanDialog } from "./cancel-plan-dialog";
import { ArchivePlanDialog } from "./archive-plan-dialog";
import type { Plan, PlanStatus } from "@/features/plans/types";

type PlanPrimary = "edit" | "resume" | null;

const PAUSE_TOOLTIP =
  "In-flight phases will complete; new phases won't auto-start. Use 'Cancel running phase' on individual tasks to stop work immediately.";

function computePrimary(status: PlanStatus): PlanPrimary {
  switch (status) {
    case "active":
      return "edit";
    case "paused":
      return "resume";
    default:
      return null;
  }
}

/**
 * Plan-level action toolbar. Same pattern as `TaskActionToolbar`: state-aware
 * enabled/disabled, primary action computed from state, tooltips that honestly
 * describe behaviour. The Pause button's tooltip is deliberately verbose
 * because pause semantics ("stop auto-progression, not in-flight work") are
 * not what users tend to assume.
 */
export function PlanActionToolbar({ plan }: { plan: Plan }) {
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const pause = usePausePlan();
  const resume = useResumePlan();

  const status = plan.status;
  const isActive = status === "active";
  const isPaused = status === "paused";
  const isTerminal =
    status === "completed" || status === "cancelled" || status === "archived";
  const primary = computePrimary(status);

  const editDisabled = isTerminal;
  const editTooltip = isTerminal
    ? "Plan is in a terminal state."
    : "Edit the plan's title and description.";

  const cancelDisabled = isTerminal;
  const cancelTooltip = isTerminal
    ? "Plan is already in a terminal state."
    : "Cancel the plan and all in-flight tasks.";

  const archiveDisabled = status === "archived";
  const archiveTooltip =
    status === "archived"
      ? "Plan is already archived."
      : "Hide this plan from the active list.";

  return (
    <TooltipProvider delay={200}>
      <div className="flex flex-wrap items-center gap-1">
        <ToolbarButton
          icon={<PencilSimple weight={primary === "edit" ? "fill" : "regular"} />}
          label="Edit"
          isPrimary={primary === "edit"}
          disabled={editDisabled}
          tooltip={editTooltip}
          onClick={() => setEditing(true)}
        />

        {isActive && (
          <ToolbarButton
            icon={<Pause />}
            label="Pause"
            isPrimary={false}
            disabled={pause.isPending}
            tooltip={PAUSE_TOOLTIP}
            onClick={() => pause.mutate({ planId: plan.id, reason: null })}
          />
        )}
        {isPaused && (
          <ToolbarButton
            icon={<Play weight={primary === "resume" ? "fill" : "regular"} />}
            label="Resume"
            isPrimary={primary === "resume"}
            disabled={resume.isPending}
            tooltip="Resume auto-progression for this plan's tasks."
            onClick={() => resume.mutate(plan.id)}
          />
        )}

        <ToolbarButton
          icon={<X />}
          label="Cancel"
          isPrimary={false}
          disabled={cancelDisabled}
          tooltip={cancelTooltip}
          onClick={() => setCancelling(true)}
        />
        <ToolbarButton
          icon={<Archive />}
          label="Archive"
          isPrimary={false}
          disabled={archiveDisabled}
          tooltip={archiveTooltip}
          onClick={() => setArchiving(true)}
        />

        <PlanOverflowMenu plan={plan} />
      </div>

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
    </TooltipProvider>
  );
}

function ToolbarButton({
  icon,
  label,
  isPrimary,
  disabled,
  tooltip,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  isPrimary: boolean;
  disabled: boolean;
  tooltip: string;
  onClick: () => void;
}) {
  const button = (
    <Button
      size="sm"
      variant={isPrimary ? "default" : "ghost"}
      disabled={disabled}
      onClick={onClick}
      className="gap-1"
    >
      {icon}
      {label}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <span {...props} className="inline-flex">
            {button}
          </span>
        )}
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function PlanOverflowMenu({ plan }: { plan: Plan }) {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { workspaceId?: string };
  const workspaceId = params.workspaceId;

  const briefingId =
    plan.source === "briefing" &&
    typeof plan.source_metadata?.briefing_id === "string"
      ? (plan.source_metadata.briefing_id as string)
      : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label="More actions">
            <DotsThree weight="bold" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-[220px]">
        <DropdownMenuItem
          onClick={() => {
            void navigator.clipboard.writeText(plan.id);
          }}
        >
          <Copy />
          <span className="flex-1">Copy plan ID</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!briefingId || !workspaceId}
          onClick={() => {
            if (!briefingId || !workspaceId) return;
            void navigate({
              to: "/workspace/$workspaceId/briefings/$briefingId",
              params: { workspaceId, briefingId },
            });
          }}
        >
          <ChatCircleText />
          <span className="flex-1">View briefing transcript</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
