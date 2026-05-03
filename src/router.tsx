import { createRouter } from "@tanstack/react-router";
import { rootRoute } from "./routes/root";
import { indexRoute } from "./routes/index";
import { globalSettingsRoute } from "./routes/global-settings";
import { workspaceLayoutRoute } from "./routes/workspace/layout";
import { workspaceIndexRoute } from "./routes/workspace/redirect";
import { plansListRoute } from "./routes/workspace/plans-list";
import { planDetailRoute } from "./routes/workspace/plan-detail";
import { taskDetailRoute } from "./routes/workspace/task-detail";
import { providersRoute } from "./routes/workspace/providers";
import { workspaceSettingsRoute } from "./routes/workspace/workspace-settings";
import { briefingNewRoute } from "./routes/workspace/briefing-new";
import { briefingDetailRoute } from "./routes/workspace/briefing-detail";

const workspaceTree = workspaceLayoutRoute.addChildren([
  workspaceIndexRoute,
  plansListRoute,
  planDetailRoute,
  taskDetailRoute,
  providersRoute,
  workspaceSettingsRoute,
  briefingNewRoute,
  briefingDetailRoute,
]);

const routeTree = rootRoute.addChildren([
  indexRoute,
  globalSettingsRoute,
  workspaceTree,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
