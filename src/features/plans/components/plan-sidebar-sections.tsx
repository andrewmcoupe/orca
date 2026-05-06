import { Link } from "@tanstack/react-router";
import { CaretRight } from "@phosphor-icons/react";
import { formatRelativeTime } from "@/lib/format";
import type { Plan } from "../types";
import type { Task } from "@/features/tasks/types";

const SOURCE_LABEL: Record<string, string> = {
  manual: "manual",
  prd_file: "PRD file",
  linear: "Linear",
  github_issue: "GitHub issue",
  briefing: "briefing",
};

/**
 * SUMMARY — high-level plan info: when, where it came from, and the
 * task count rolled up by status. Two columns of label/value rows so
 * the eye doesn't have to track which value belongs to which label.
 */
export function PlanSummarySidebarBody({
  plan,
  tasks,
}: {
  plan: Plan;
  tasks: Task[];
}) {
  const counts = countTasks(tasks);
  return (
    <dl className="space-y-2 text-[12px]">
      <Row label="Created" value={formatRelativeTime(plan.created_at)} />
      <Row label="Updated" value={formatRelativeTime(plan.updated_at)} />
      <Row
        label="Source"
        value={SOURCE_LABEL[plan.source] ?? plan.source}
      />
      <Row
        label="Tasks"
        value={
          <span className="font-mono tabular-nums">{plan.task_count}</span>
        }
      />
      {counts.merged > 0 && (
        <Row
          label="Merged"
          value={
            <span className="font-mono tabular-nums text-blue-600 dark:text-blue-400">
              {counts.merged}
            </span>
          }
        />
      )}
      {counts.inFlight > 0 && (
        <Row
          label="In flight"
          value={
            <span className="font-mono tabular-nums text-success">
              {counts.inFlight}
            </span>
          }
        />
      )}
      {counts.blocked > 0 && (
        <Row
          label="Blocked"
          value={
            <span className="font-mono tabular-nums text-warning">
              {counts.blocked}
            </span>
          }
        />
      )}
    </dl>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground text-[11px]">{label}</dt>
      <dd className="text-foreground/90 truncate text-right text-[12px]">
        {value}
      </dd>
    </div>
  );
}

/**
 * ARTIFACTS sidebar section for plans — currently just the briefing transcript
 * link when the plan was created from a briefing. Hidden otherwise.
 */
export function PlanArtifactsSidebarBody({
  plan,
  workspaceId,
}: {
  plan: Plan;
  workspaceId: string;
}) {
  const briefingId = briefingIdOf(plan);
  if (!briefingId) {
    return (
      <p className="text-muted-foreground text-[11px] italic">none</p>
    );
  }
  return (
    <ul className="space-y-1.5">
      <li>
        <Link
          to="/workspace/$workspaceId/briefings/$briefingId"
          params={{ workspaceId, briefingId }}
          className="text-primary/90 hover:text-primary inline-flex items-center gap-0.5 text-[12px] underline-offset-2 hover:underline"
        >
          <CaretRight className="size-3 shrink-0" />
          briefing transcript
        </Link>
      </li>
    </ul>
  );
}

export function planHasArtifacts(plan: Plan): boolean {
  return !!briefingIdOf(plan);
}

function briefingIdOf(plan: Plan): string | null {
  if (plan.source !== "briefing") return null;
  const id = plan.source_metadata?.briefing_id;
  return typeof id === "string" ? id : null;
}

type TaskCounts = {
  merged: number;
  inFlight: number;
  blocked: number;
  other: number;
};

function countTasks(tasks: Task[]): TaskCounts {
  const c: TaskCounts = { merged: 0, inFlight: 0, blocked: 0, other: 0 };
  for (const t of tasks) {
    if (t.is_blocked) c.blocked++;
    if (t.status === "merged") c.merged++;
    else if (t.status === "running" || t.status === "awaiting_review")
      c.inFlight++;
    else c.other++;
  }
  return c;
}
