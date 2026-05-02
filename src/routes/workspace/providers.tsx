import { createRoute } from "@tanstack/react-router";
import { ArrowSquareOut, CheckCircle, XCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProviders, useRefreshProviders } from "@/features/providers/hooks";
import { workspaceLayoutRoute } from "./layout";

function ProvidersPage() {
  const providers = useProviders();
  const refresh = useRefreshProviders();

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Providers</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? "Refreshing…" : "Refresh"}
        </Button>
      </header>
      <ul className="space-y-2">
        {(providers.data ?? []).map((p) => (
          <li key={p.id}>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  {p.installed ? (
                    <CheckCircle className="text-emerald-600" weight="fill" />
                  ) : (
                    <XCircle className="text-destructive" weight="fill" />
                  )}
                  <span>{p.display_name}</span>
                  <span className="text-muted-foreground ml-auto text-xs font-normal">
                    {p.version ?? (p.installed ? "" : "not installed")}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-xs">
                {p.path && (
                  <div className="text-muted-foreground truncate font-mono">
                    {p.path}
                  </div>
                )}
                <div className="text-muted-foreground">
                  Authenticated: {p.authenticated ? "yes" : "unknown"}
                </div>
                {p.error && (
                  <div className="text-destructive flex items-center gap-1">
                    <span>{p.error}</span>
                    <a
                      href="https://docs.claude.com/en/docs/claude-code/overview"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                    >
                      Install docs <ArrowSquareOut className="size-3" />
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const providersRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/providers",
  component: ProvidersPage,
});
