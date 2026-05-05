import { useEffect, useMemo, useState } from "react";
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
import {
  useProviderModels,
  useProviders,
} from "@/features/providers/hooks";
import {
  useGenerateBriefingDraft,
  useStartBriefing,
} from "../hooks";
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

  const [description, setDescription] = useState("");
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

  // Both mutations are fast — start commits a single event, generate spawns
  // the worker and returns immediately. We still disable the form during
  // them so a double-submit can't double-create. The 30–90s "reading your
  // codebase" wait now happens on the next page (driven by
  // `briefing.is_generating`), not here.
  const submitting = start.isPending || generate.isPending;
  const canSubmit =
    description.trim().length > 10 && !!providerId && !!model && !submitting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setErrorMsg(null);
    try {
      const briefing = await start.mutateAsync({
        initial_description: description.trim(),
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
          <Label htmlFor="description">Feature description</Label>
          <Textarea
            id="description"
            autoFocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the feature you want to build. Be as vague or detailed as you like — the model will ask itself the right questions."
            rows={10}
            disabled={submitting}
            className="text-sm leading-relaxed"
          />
          <p className="text-muted-foreground text-xs">
            {description.trim().length} characters
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
