import { CaretDown, MagnifyingGlass, Sparkle } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { PlansSearch } from "@/routes/workspace/plans-list";

const STATUS_OPTIONS: { value: PlansSearch["status"]; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

export function PlansFilters({
  status,
  onStatusChange,
  query,
  onQueryChange,
  onNewBriefing,
  onNewManualPlan,
}: {
  status: PlansSearch["status"];
  onStatusChange: (status: PlansSearch["status"]) => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** Primary action: open the briefing setup flow. */
  onNewBriefing: () => void;
  /** Secondary action: open the manual new-plan dialog. */
  onNewManualPlan: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <MagnifyingGlass className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search plans"
          className="h-8 pl-7"
          type="search"
        />
      </div>
      <SegmentedStatus value={status} onChange={onStatusChange} />
      <NewPlanSplitButton
        onNewBriefing={onNewBriefing}
        onNewManualPlan={onNewManualPlan}
      />
    </div>
  );
}

function NewPlanSplitButton({
  onNewBriefing,
  onNewManualPlan,
}: {
  onNewBriefing: () => void;
  onNewManualPlan: () => void;
}) {
  return (
    <div className="inline-flex">
      <Button
        size="sm"
        onClick={onNewBriefing}
        className="rounded-r-none pr-2.5"
        title="Generate a plan from a feature description (recommended)"
      >
        <Sparkle className="size-3.5" weight="fill" />
        New plan from briefing
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="sm"
              className="border-primary-foreground/20 -ml-px rounded-l-none border-l px-1.5"
              aria-label="More plan creation options"
            >
              <CaretDown className="size-3" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onNewBriefing}>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">New plan from briefing</span>
              <span className="text-muted-foreground text-xs">
                Recommended for non-trivial work
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onNewManualPlan}>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">New plan (manual)</span>
              <span className="text-muted-foreground text-xs">
                Add tasks one at a time yourself
              </span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SegmentedStatus({
  value,
  onChange,
}: {
  value: PlansSearch["status"];
  onChange: (v: PlansSearch["status"]) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Status filter"
      className="bg-muted inline-flex rounded-sm p-0.5"
    >
      {STATUS_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-[3px] px-2 py-1 text-[11px] transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
