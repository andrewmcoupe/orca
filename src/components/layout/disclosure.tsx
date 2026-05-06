import { useState, type ReactNode } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * Single-section disclosure used for spec / audit trail / similar collapsible
 * blocks on detail views. Independent open/close (not coordinated with
 * siblings), no animation per the brief, click-target spans the whole header
 * row. Mirrors the Accordion's visual register without forcing a multi-item
 * Accordion when we only need one item.
 */
export function Disclosure({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  /** Inline meta to the right of the title — e.g. "— 6 acceptance criteria". */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={cn(
        "border-border/60 border-b last:border-b-0",
        // No background — these are reading sections, not cards. The border
        // gives just enough separation between disclosures to read as a list.
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hover:text-foreground flex w-full items-center gap-2 py-3 text-left"
        aria-expanded={open}
      >
        {open ? (
          <CaretDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <CaretRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="text-foreground text-[14px] font-medium">
          {title}
        </span>
        {summary != null && (
          <span className="text-muted-foreground text-[12px]">
            — {summary}
          </span>
        )}
      </button>
      {open && <div className="pb-4">{children}</div>}
    </section>
  );
}
