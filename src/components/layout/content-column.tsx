import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Constrains prose-bearing content to a comfortable reading width inside
 * workspace-scoped views. Width lives in `--content-max-width` (App.css) so
 * the value can be tuned in one place.
 *
 * Use for: titles + subtitle metadata, markdown bodies, verdict/concern
 * cards, audit trail rows, banner messages.
 *
 * Don't use for: pipeline phase card rows, structured/tabular data, or
 * full-width chrome (sidebar, breadcrumbs, status bar).
 */
export function ContentColumn({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("w-full max-w-[var(--content-max-width)]", className)}
      {...props}
    />
  );
}
