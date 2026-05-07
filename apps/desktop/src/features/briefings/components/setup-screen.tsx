import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ContentColumn } from "@/components/layout/content-column";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProviderModels, useProviders } from "@/features/providers/hooks";
import { LinearImportDialog } from "@/features/integrations/linear/components/linear-import-dialog";
import { LinearLogo } from "@/features/integrations/linear/components/linear-logo";
import {
  linearIssuesToBriefingMarkdown,
  linearIssuesToBriefingSources,
} from "@/features/integrations/linear/briefing-markdown";
import type { LinearIssue } from "@/features/integrations/linear/types";
import { useGenerateBriefingDraft, useStartBriefing } from "../hooks";
import type { Briefing } from "../types";

export function BriefingSetupScreen({
  onCancel,
  onStarted,
}: {
  onCancel: () => void;
  onStarted: (briefing: Briefing) => void;
}) {
  const providersQuery = useProviders();
  const installed = useMemo(
    () => (providersQuery.data ?? []).filter((p) => p.installed),
    [providersQuery.data],
  );

  const [manualDescription, setManualDescription] = useState("");
  const [importedIssues, setImportedIssues] = useState<LinearIssue[]>([]);
  const [providerId, setProviderId] = useState<string>("");
  const [model, setModel] = useState<string>("");

  // Default the provider to the first installed one once detection lands.
  useEffect(() => {
    if (!providerId && installed.length > 0) {
      setProviderId(installed[0].id);
    }
  }, [installed, providerId]);

  const modelsQuery = useProviderModels(providerId || undefined);
  useEffect(() => {
    const models = modelsQuery.data ?? [];
    if (!model && models.length > 0) {
      setModel(models[0].id);
    }
  }, [modelsQuery.data, model]);
  // Reset model selection when provider changes.
  useEffect(() => {
    setModel("");
  }, [providerId]);

  const start = useStartBriefing();
  const generate = useGenerateBriefingDraft();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const importedSources = useMemo(
    () => linearIssuesToBriefingSources(importedIssues),
    [importedIssues],
  );
  const importedMarkdown = useMemo(
    () => linearIssuesToBriefingMarkdown(importedIssues),
    [importedIssues],
  );
  const finalDescription = useMemo(() => {
    const manual = manualDescription.trim();
    if (!importedMarkdown) return manual;
    return manual ? `${manual}\n\n${importedMarkdown}` : importedMarkdown;
  }, [manualDescription, importedMarkdown]);

  // Both mutations are fast — start commits a single event, generate spawns
  // the worker and returns immediately. We still disable the form during
  // them so a double-submit can't double-create. The 30–90s "reading your
  // codebase" wait now happens on the next page (driven by
  // `briefing.is_generating`), not here.
  const submitting = start.isPending || generate.isPending;
  const canSubmit =
    finalDescription.trim().length > 10 && !!providerId && !!model && !submitting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setErrorMsg(null);
    try {
      const briefing = await start.mutateAsync({
        initial_description: finalDescription.trim(),
        imported_sources: importedSources,
        provider: providerId,
        model,
      });
      // Fire the initial generation. The mutation resolves once the backend
      // has spawned the worker — the actual draft lands asynchronously and
      // the review screen picks it up via the global live-updates listener.
      const generating = await generate.mutateAsync(briefing.id);
      onStarted(generating);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const removeImportedIssue = (issue: LinearIssue) => {
    setImportedIssues((prev) =>
      prev.filter((item) => item.id !== issue.id),
    );
  };

  return (
    <ContentColumn className="space-y-6 px-5 py-8">
      <header className="space-y-1">
        <h1 className="text-xl font-medium tracking-tight">New briefing</h1>
        <p className="text-muted-foreground text-sm">
          Describe a feature. The model reads your codebase, identifies
          ambiguities, and produces a structured plan with file-aware tasks. You
          review and refine before any tasks are created.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="description">Feature description</Label>
            <LinearImportDialog
              disabled={submitting}
              onImport={(issues) => {
                setImportedIssues((prev) => {
                  const next = new Map(
                    prev.map((issue) => [issue.id, issue]),
                  );
                  for (const issue of issues) {
                    next.set(issue.id, issue);
                  }
                  return Array.from(next.values());
                });
              }}
            />
          </div>
          <Textarea
            id="description"
            autoFocus
            value={manualDescription}
            onChange={(e) => setManualDescription(e.target.value)}
            placeholder="Describe the feature you want to build. Be as vague or detailed as you like — the model will ask itself the right questions."
            rows={10}
            disabled={submitting}
            className="text-sm leading-relaxed"
          />
          <p className="text-muted-foreground text-xs">
            {finalDescription.trim().length} characters
            {importedSources.length > 0
              ? ` · ${importedSources.length} imported source${
                  importedSources.length === 1 ? "" : "s"
                } attached`
              : ""}
          </p>
          {importedSources.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {importedIssues.map((issue) => (
                <span
                  key={issue.id}
                  className="border-border bg-muted/40 inline-flex max-w-full items-center gap-1 border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  <button
                    type="button"
                    onClick={() => openUrl(issue.url)}
                    disabled={submitting}
                    className="hover:text-foreground inline-flex min-w-0 items-center gap-1 disabled:pointer-events-none disabled:opacity-50"
                    aria-label={`Open ${issue.identifier} in Linear`}
                    title={`Open ${issue.identifier} in Linear`}
                  >
                    <LinearLogo className="size-3" />
                    <span>{issue.identifier}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeImportedIssue(issue)}
                    disabled={submitting}
                    className="hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    aria-label={`Remove imported source ${issue.identifier}`}
                    title={`Remove imported source ${issue.identifier}`}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              </div>
              <p className="text-muted-foreground text-[11px]">
                Imported issue context is added to the briefing when you start it. Remove a badge to exclude that issue.
              </p>
            </div>
          )}
        </div>

        <div className="grid gap-4">
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select
              value={providerId}
              onValueChange={(v) => setProviderId(v ?? "")}
              disabled={submitting || installed.length === 0}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    providersQuery.isLoading
                      ? "Loading…"
                      : installed.length === 0
                        ? "No installed providers"
                        : "Select provider"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {installed.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Model</Label>
            <Select
              value={model}
              onValueChange={(v) => setModel(v ?? "")}
              disabled={submitting || !providerId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {(modelsQuery.data ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {errorMsg && (
          <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3">
            <p className="text-destructive text-sm font-medium">
              Couldn't start briefing
            </p>
            <p className="text-destructive/80 mt-1 font-mono text-xs">
              {errorMsg}
            </p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? "Starting…" : "Start briefing"}
          </Button>
        </div>
      </form>
    </ContentColumn>
  );
}
