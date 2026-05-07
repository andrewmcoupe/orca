import { useMemo, useState } from "react";
import { Check, MagnifyingGlass, Plugs, Trash } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { linearApi } from "../api";
import { LinearLogo } from "./linear-logo";
import {
  useLinearConnectionStatus,
  useSaveLinearApiKey,
  useSearchLinearIssues,
} from "../hooks";
import type { LinearIssue } from "../types";

function issueMeta(issue: LinearIssue) {
  return [
    issue.state,
    issue.assignee ? `@${issue.assignee}` : null,
    issue.labels.length > 0 ? issue.labels.slice(0, 3).join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function LinearImportDialog({
  onImport,
  disabled,
}: {
  onImport: (issues: LinearIssue[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [includeComments, setIncludeComments] = useState(true);
  const [exactIssue, setExactIssue] = useState<LinearIssue | null>(null);
  const [selected, setSelected] = useState<Record<string, LinearIssue>>({});
  const [error, setError] = useState<string | null>(null);

  const connection = useLinearConnectionStatus(open);
  const saveApiKey = useSaveLinearApiKey();
  const search = useSearchLinearIssues();

  const selectedIssues = useMemo(() => Object.values(selected), [selected]);
  const resultIssues = exactIssue ? [exactIssue] : (search.data?.issues ?? []);
  const connected = connection.data?.connected ?? false;
  const busy = connection.isLoading || saveApiKey.isPending || search.isPending;

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setError(null);
    try {
      await saveApiKey.mutateAsync(apiKey);
      setApiKey("");
    } catch (err) {
      setError(String(err));
    }
  };

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setError(null);
    setExactIssue(null);
    try {
      const exact = await linearApi.getIssue({
        issueId: query.trim(),
        includeComments,
      });
      if (exact) {
        setExactIssue(exact);
        search.reset();
        return;
      }
      await search.mutateAsync({
        query: query.trim(),
        limit: 10,
        includeComments,
      });
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleIssue = (issue: LinearIssue) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[issue.id]) {
        delete next[issue.id];
      } else {
        next[issue.id] = issue;
      }
      return next;
    });
  };

  const importSelected = () => {
    if (selectedIssues.length === 0) return;
    onImport(selectedIssues);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button type="button" variant="outline" disabled={disabled} />}
      >
        <LinearLogo />
        Import from Linear
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-4rem)] gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-1.5">
            <LinearLogo className="size-3.5" />
            Import Linear issues
          </DialogTitle>
          <DialogDescription>
            Search Linear and append selected issue context to this briefing.
          </DialogDescription>
        </DialogHeader>

        {!connected ? (
          <form onSubmit={connect} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="linear-api-key">Linear API key</Label>
              <Input
                id="linear-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="lin_api_..."
                disabled={busy}
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                The key is validated with Linear and stored in the system
                credential store.
              </p>
            </div>
            <Button type="submit" disabled={!apiKey.trim() || busy}>
              <Plugs />
              {saveApiKey.isPending ? "Connecting..." : "Connect Linear"}
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className="gap-1">
                <LinearLogo />
                Connected
              </Badge>
              <span className="text-muted-foreground">
                Credentials are scoped to the active Orca workspace.
              </span>
            </div>

            <form onSubmit={runSearch} className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by issue key, title, or description"
                disabled={busy}
              />
              <Button type="submit" disabled={!query.trim() || busy}>
                <MagnifyingGlass />
                Search
              </Button>
            </form>
            <label className="text-muted-foreground inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={includeComments}
                onChange={(e) => setIncludeComments(e.target.checked)}
                disabled={busy}
              />
              Include recent comments
            </label>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
              <ScrollArea className="h-[320px] border border-border">
                <div className="divide-y divide-border">
                  {resultIssues.map((issue) => {
                    const checked = !!selected[issue.id];
                    return (
                      <button
                        key={issue.id}
                        type="button"
                        onClick={() => toggleIssue(issue)}
                        className={cn(
                          "block w-full p-3 text-left transition-colors hover:bg-muted/60",
                          checked && "bg-muted",
                        )}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2">
                              <LinearLogo className="size-3" />
                              <span className="font-mono text-xs text-muted-foreground">
                                {issue.identifier}
                              </span>
                              {checked && <Check className="size-3.5" />}
                            </div>
                            <p className="truncate text-sm font-medium">
                              {issue.title}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {issueMeta(issue) || "No status metadata"}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {(search.data || exactIssue) && resultIssues.length === 0 && (
                    <div className="p-4 text-xs text-muted-foreground">
                      No Linear issues matched that search.
                    </div>
                  )}
                  {!search.data && !exactIssue && (
                    <div className="p-4 text-xs text-muted-foreground">
                      Paste an issue URL/key for exact lookup, or search by title.
                    </div>
                  )}
                </div>
              </ScrollArea>

              <div className="space-y-2">
                <h3 className="text-xs font-medium">Selected</h3>
                <div className="space-y-2">
                  {selectedIssues.map((issue) => (
                    <div
                      key={issue.id}
                      className="flex items-start justify-between gap-2 border border-border p-2"
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <LinearLogo className="size-3" />
                            {issue.identifier}
                          </span>
                        </p>
                        <p className="truncate text-xs font-medium">
                          {issue.title}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => toggleIssue(issue)}
                        aria-label={`Remove ${issue.identifier}`}
                      >
                        <Trash />
                      </Button>
                    </div>
                  ))}
                  {selectedIssues.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No issues selected.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="border-destructive/40 bg-destructive/5 border p-3">
            <p className="text-destructive text-xs font-medium">
              Linear import failed
            </p>
            <p className="text-destructive/80 mt-1 font-mono text-xs">
              {error}
            </p>
            {error.toLowerCase().includes("credentials") && (
              <p className="text-destructive/80 mt-2 text-xs">
                Update or disconnect the Linear key in Workspace settings.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={importSelected}
            disabled={selectedIssues.length === 0 || busy}
          >
            Import {selectedIssues.length || ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
