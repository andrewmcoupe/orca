import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { useWorkspaces } from "@/features/workspaces/hooks";
import { Link } from "@tanstack/react-router";

function HomePage() {
  const workspaces = useWorkspaces();
  const list = workspaces.data ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Orca</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {list.length === 0
            ? "Add a workspace from the sidebar to get started."
            : "Pick a workspace to open its plans."}
        </p>
      </header>
      {list.length > 0 && (
        <ul className="divide-border divide-y rounded-md border">
          {list.map((ws) => (
            <li key={ws.id}>
              <Link
                to="/workspace/$workspaceId/plans"
                params={{ workspaceId: ws.id }}
                search={{ status: "active", q: "" }}
                className="hover:bg-muted block px-4 py-3 transition-colors"
              >
                <div className="font-medium">{ws.name}</div>
                <div className="text-muted-foreground truncate text-xs">
                  {ws.path}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
