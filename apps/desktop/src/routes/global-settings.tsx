import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";

function GlobalSettingsPage() {
  return (
    <div className="space-y-4 px-5 py-4">
      <h1 className="text-[20px] font-medium tracking-tight">Settings</h1>
      <p className="text-muted-foreground text-sm">
        Global app settings — coming soon.
      </p>
    </div>
  );
}

export const globalSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: GlobalSettingsPage,
});
