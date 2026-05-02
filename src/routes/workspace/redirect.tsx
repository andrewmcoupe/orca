import { createRoute, redirect } from "@tanstack/react-router";
import { workspaceLayoutRoute } from "./layout";

export const workspaceIndexRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/workspace/$workspaceId/plans",
      params: { workspaceId: params.workspaceId },
      search: { status: "active", q: "" },
    });
  },
});
