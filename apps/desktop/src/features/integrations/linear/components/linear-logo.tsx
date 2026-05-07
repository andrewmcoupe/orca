import linearDarkLogo from "@/assets/linear-dark-logo.svg";
import linearLightLogo from "@/assets/linear-light-logo.svg";
import { cn } from "@/lib/utils";

export function LinearLogo({ className }: { className?: string }) {
  return (
    <>
      <img
        src={linearDarkLogo}
        alt=""
        aria-label="Linear"
        className={cn("size-3 shrink-0 dark:hidden", className)}
        draggable={false}
      />
      <img
        src={linearLightLogo}
        alt=""
        aria-label="Linear"
        className={cn("hidden size-3 shrink-0 dark:block", className)}
        draggable={false}
      />
    </>
  );
}
