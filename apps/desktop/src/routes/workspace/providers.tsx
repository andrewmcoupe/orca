import { ContentColumn } from "@/components/layout/content-column";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProviders, useRefreshProviders } from "@/features/providers/hooks";
import { ArrowSquareOut, CheckCircle, XCircle } from "@phosphor-icons/react";
import { createRoute } from "@tanstack/react-router";
import { globalSettingsRoute } from "../global-settings";

function ProvidersPage() {
  const providers = useProviders();
  const refresh = useRefreshProviders();

  return (
    <ContentColumn className="space-y-4 px-5 py-4">
      <header className="flex items-center justify-between">
        <h1 className="text-[18px] font-medium tracking-tight">Providers</h1>
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
            <div className="crisp-gradient-border p-2 rounded-sm px-1">
              <CardHeader className="pb-2 px-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  {p.installed && p.authenticated ? (
                    <CheckCircle className="text-emerald-600" weight="fill" />
                  ) : p.installed ? (
                    <XCircle className="text-amber-600" weight="fill" />
                  ) : (
                    <XCircle className="text-destructive" weight="fill" />
                  )}
                  <span>{p.display_name}</span>
                  <span className="text-muted-foreground ml-auto text-xs font-normal">
                    {p.version ??
                      (p.installed
                        ? p.authenticated
                          ? ""
                          : "not signed in"
                        : "not installed")}
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
                  {p.installed
                    ? p.authenticated
                      ? "Ready"
                      : `Installed but not signed in${p.id === "codex" ? " — run `codex login` in your terminal." : "."}`
                    : "Not installed."}
                </div>
                {p.error && (
                  <div className="text-amber-700 dark:text-amber-400 flex items-center gap-1">
                    <span>{p.error}</span>
                    {!p.installed && (
                      <a
                        href={installDocsLink(p.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                      >
                        Install docs <ArrowSquareOut className="size-3" />
                      </a>
                    )}
                  </div>
                )}
              </CardContent>
            </div>
          </li>
        ))}
      </ul>
    </ContentColumn>
  );
}

function installDocsLink(providerId: string): string {
  switch (providerId) {
    case "codex":
      return "https://github.com/openai/codex";
    case "claude":
    default:
      return "https://docs.claude.com/en/docs/claude-code/overview";
  }
}

export const providersRoute = createRoute({
  getParentRoute: () => globalSettingsRoute,
  path: "/providers",
  component: ProvidersPage,
});
