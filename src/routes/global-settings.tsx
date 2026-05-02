import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";

function GlobalSettingsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
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
