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
  const [phase, setPhase] = useState<"idle" | "starting" | "generating">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live elapsed counter while the model is reading the codebase. Shown so the
  // user knows the 30-90s wait isn't a hang.
  useEffect(() => {
    if (phase !== "generating") return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  const canSubmit =
    description.trim().length > 10 &&
    !!providerId &&
    !!model &&
    phase === "idle";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setErrorMsg(null);
    try {
      setPhase("starting");
      const briefing = await start.mutateAsync({
        initial_description: description.trim(),
        provider: providerId,
        model,
      });
      // Kick off the first generation immediately. The review screen is gated
      // on the briefing having a draft, so we await this before navigating.
      setPhase("generating");
      await generate.mutateAsync(briefing.id);
      onStarted(briefing);
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("idle");
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
            disabled={phase !== "idle"}
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
              disabled={phase !== "idle" || installed.length === 0}
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
              disabled={phase !== "idle" || !providerId}
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

        {phase === "generating" && (
          <div className="border-border bg-muted/30 flex items-center gap-3 rounded-md border p-3">
            <span className="border-foreground/20 border-t-foreground inline-block h-3 w-3 animate-spin rounded-full border-2" />
            <div className="flex-1">
              <p className="text-sm font-medium">Reading your codebase…</p>
              <p className="text-muted-foreground text-xs">
                {elapsed}s elapsed. This typically takes 30–90 seconds for a
                real codebase.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={phase !== "idle"}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {phase === "starting"
              ? "Starting…"
              : phase === "generating"
                ? "Generating…"
                : "Start briefing"}
          </Button>
        </div>
      </form>
    </ContentColumn>
  );
}
