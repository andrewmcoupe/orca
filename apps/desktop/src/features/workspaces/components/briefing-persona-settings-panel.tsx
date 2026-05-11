import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ModelSelect } from "@/features/providers/components/model-select";
import {
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from "../hooks";
import type {
  BriefingPersona,
  BriefingPersonaConfig,
  ModelChoice,
  WorkspaceSettings,
} from "../types";

const PERSONAS: Array<{
  id: BriefingPersona;
  label: string;
  help: string;
}> = [
  {
    id: "intent_extractor",
    label: "Intent Extractor",
    help: "Turns the raw description into product intent.",
  },
  {
    id: "codebase_cartographer",
    label: "Codebase Cartographer",
    help: "Finds relevant files, patterns, APIs, and constraints.",
  },
  {
    id: "ambiguity_hunter",
    label: "Ambiguity Hunter",
    help: "Builds the ambiguity ledger and default assumptions.",
  },
  {
    id: "implementation_planner",
    label: "Implementation Planner",
    help: "Converts the brief into an executable task graph.",
  },
  {
    id: "skeptic",
    label: "Skeptic",
    help: "Reviews risks, missing requirements, and test gaps.",
  },
  {
    id: "final_synthesizer",
    label: "Final Synthesizer",
    help: "Reconciles specialist outputs into the final brief.",
  },
];

type Draft = {
  global_default: ModelChoice | null;
  personas: Record<string, ModelChoice | null>;
};

function buildDraft(config?: BriefingPersonaConfig): Draft {
  const personas: Record<string, ModelChoice | null> = {};
  for (const persona of PERSONAS) {
    personas[persona.id] = config?.personas?.[persona.id] ?? null;
  }
  return {
    global_default: config?.global_default ?? null,
    personas,
  };
}

export function BriefingPersonaSettingsPanel({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const settingsQ = useWorkspaceSettings(workspaceId);
  const update = useUpdateWorkspaceSettings(workspaceId);
  const [draft, setDraft] = useState<Draft>(() => buildDraft());

  useEffect(() => {
    if (settingsQ.data) {
      setDraft(buildDraft(settingsQ.data.briefing_personas));
    }
  }, [settingsQ.data]);

  const settings = settingsQ.data;
  const baseline = useMemo(
    () => buildDraft(settings?.briefing_personas),
    [settings?.briefing_personas],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  if (settingsQ.isLoading || !settings) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  const save = () => {
    const cleaned: BriefingPersonaConfig = {
      global_default: draft.global_default,
      personas: Object.fromEntries(
        Object.entries(draft.personas).filter(([, choice]) => choice !== null),
      ),
    };
    const merged: WorkspaceSettings = {
      ...settings,
      briefing_personas: cleaned,
    };
    update.mutate(merged);
  };

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-xs">
        Briefing personas inherit the briefing form's provider/model unless a
        global default or persona override is set here.
      </p>

      <div className="space-y-1.5">
        <Label className="text-muted-foreground text-[10px] uppercase tracking-wide">
          Global briefing default
        </Label>
        <ModelSelect
          value={draft.global_default}
          onChange={(next) =>
            setDraft((prev) => ({ ...prev, global_default: next }))
          }
          nullLabel="Use briefing form model"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {PERSONAS.map((persona) => (
          <div key={persona.id} className="bg-card rounded-md border p-3">
            <div className="space-y-1">
              <Label className="text-sm">{persona.label}</Label>
              <p className="text-muted-foreground text-xs">{persona.help}</p>
            </div>
            <div className="mt-3">
              <ModelSelect
                value={draft.personas[persona.id] ?? null}
                onChange={(next) =>
                  setDraft((prev) => ({
                    ...prev,
                    personas: { ...prev.personas, [persona.id]: next },
                  }))
                }
                nullLabel="Use global/default"
                size="sm"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        {update.error && (
          <span className="text-destructive text-xs">
            {String(update.error)}
          </span>
        )}
      </div>
    </div>
  );
}
