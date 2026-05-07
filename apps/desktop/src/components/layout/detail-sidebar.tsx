import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Reference-info column rendered to the right of detail views (task / plan).
 * Each section has an uppercase header, an optional inline action (e.g. an
 * "edit" link), and arbitrary content. The component itself is just chrome —
 * sections decide their own layout, so dense rows / short lists / link lists
 * all coexist without the sidebar being prescriptive.
 *
 * Fixed 280px width, same background as the main column, separated only by a
 * left border. Always visible — there's no collapsed state. The detail view's
 * main column is responsible for its own min-width so the layout doesn't
 * pinch the sidebar at narrow viewports.
 */
export type DetailSidebarSection = {
  /** Stable key for React reconciliation. */
  key: string;
  /** Uppercase section title. */
  title: string;
  /** Optional inline affordance rendered next to the title (e.g. "edit"). */
  action?: ReactNode;
  /** Section body. */
  children: ReactNode;
  /** When true, the section is omitted entirely. Lets sections decide their
   * own visibility (e.g. ARTIFACTS hides itself when no phase has output) at
   * the call site without an extra ternary in the consumer. */
  hidden?: boolean;
};

export function DetailSidebar({
  sections,
  className,
}: {
  sections: DetailSidebarSection[];
  className?: string;
}) {
  const visible = sections.filter((s) => !s.hidden);

  return (
    <aside
      className={cn(
        "scrollbar-styled bg-background h-full w-[280px] shrink-0 overflow-y-auto border-l",
        className,
      )}
      aria-label="Reference information"
    >
      <div className="flex flex-col gap-7 px-4 pt-4 pb-4">
        {visible.map((s) => (
          <DetailSidebarSectionView key={s.key} section={s} />
        ))}
      </div>
    </aside>
  );
}

function DetailSidebarSectionView({
  section,
}: {
  section: DetailSidebarSection;
}) {
  return (
    <section className="space-y-2.5">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-muted-foreground/80 font-mono text-[10px] font-medium uppercase tracking-[0.08em]">
          {section.title}
        </h3>
        {section.action && (
          <div className="text-[10px] uppercase tracking-[0.08em]">
            {section.action}
          </div>
        )}
      </header>
      <div className="text-foreground text-[12px]">{section.children}</div>
    </section>
  );
}

/**
 * Inline section action — used as the `action` slot above. Rendered as a small
 * uppercase link, matching the screenshot's "edit" affordance next to
 * DEPENDENCIES.
 */
export function DetailSidebarAction({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-muted-foreground hover:text-foreground font-mono text-[10px] uppercase tracking-[0.08em] underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
