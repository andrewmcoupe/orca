import { useMemo, useState } from "react";
import { CircleNotch, FileText } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DetailSidebar,
  type DetailSidebarSection,
} from "@/components/layout/detail-sidebar";
import type { Briefing, BriefingDepth } from "../types";

const PERSONAS = [
  { id: "intent_extractor", label: "Intent Extractor", minDepth: "quick" },
  { id: "ambiguity_hunter", label: "Ambiguity Hunter", minDepth: "guided" },
  {
    id: "implementation_planner",
    label: "Implementation Planner",
    minDepth: "guided",
  },
  {
    id: "codebase_cartographer",
    label: "Codebase Cartographer",
    minDepth: "thorough",
  },
  {
    id: "skeptic",
    label: "Skeptic / Red-Team Reviewer",
    minDepth: "adversarial",
  },
  { id: "final_synthesizer", label: "Final Synthesizer", minDepth: "quick" },
] as const;

const DEPTH_RANK: Record<string, number> = {
  quick: 0,
  guided: 1,
  thorough: 2,
  adversarial: 3,
};

type Persona = (typeof PERSONAS)[number];
type PersonaStatus = "pending" | "running" | "completed";

type PersonaArtifact = {
  persona_id?: string;
  persona_label?: string;
  provider?: string;
  model?: string;
  output?: unknown;
  duration_ms?: number;
  fallback_used?: boolean;
  warning?: string | null;
};

type ActivePersona = {
  persona_id?: string;
  persona_label?: string;
  provider?: string;
  model?: string;
};

export function BriefingSidebar({
  briefing,
  liveOutputText,
}: {
  briefing: Briefing;
  liveOutputText: string;
}) {
  const [openArtifact, setOpenArtifact] = useState<PersonaArtifact | null>(null);
  const personas = personasForDepth(briefing.briefing_depth);
  const artifacts = parseArtifacts(
    briefing.persona_artifacts?.length
      ? briefing.persona_artifacts
      : briefing.current_draft?.persona_artifacts,
  );
  const artifactsByPersona = new Map(
    artifacts.map((artifact) => [
      artifact.persona_id ?? normalizePersonaLabel(artifact.persona_label ?? ""),
      artifact,
    ]),
  );
  const activePersona = parseActivePersona(briefing.active_persona);

  const activeIndex = useMemo(
    () =>
      inferActivePersonaIndex({
        personas,
        liveOutputText,
        activePersona,
      }),
    [personas, liveOutputText, activePersona],
  );
  const generationLabel =
    briefing.generation_kind === "refine" ? "refining" : "drafting";

  const sections: DetailSidebarSection[] = [
    {
      key: "process",
      title: "Briefing Lab",
      children: (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="font-mono text-[10px]">
              {briefing.briefing_depth}
            </Badge>
            <Badge variant={briefing.is_generating ? "secondary" : "outline"}>
              {briefing.is_generating ? generationLabel : "idle"}
            </Badge>
          </div>
          {briefing.is_generating && (
            <div className="border-border/70 bg-background space-y-1 border px-2 py-1.5">
              <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
                Active persona
              </p>
              <p className="truncate text-xs font-medium">
                {activePersona?.persona_label ??
                  (activeIndex >= 0
                    ? personas[activeIndex]?.label
                    : "Starting lab run")}
              </p>
              {(activePersona?.provider || activePersona?.model) && (
                <p className="text-muted-foreground truncate font-mono text-[10px]">
                  {activePersona.provider}:{activePersona.model}
                </p>
              )}
            </div>
          )}
          <p className="text-muted-foreground text-[11px] leading-relaxed">
            Personas run as separate model calls. The final synthesizer turns
            their artifacts into the editable brief and task graph.
          </p>
        </div>
      ),
    },
    {
      key: "personas",
      title: "Personas",
      children: (
        <div className="space-y-2">
          {personas.map((persona, index) => {
            const artifact = artifactsByPersona.get(persona.id);
            const status = personaStatus({
              index,
              activeIndex,
              hasArtifact: !!artifact,
              isGenerating: briefing.is_generating,
            });
            return (
              <PersonaRow
                key={persona.id}
                persona={persona}
                status={status}
                artifact={artifact}
                onOpenArtifact={() => artifact && setOpenArtifact(artifact)}
              />
            );
          })}
        </div>
      ),
    },
    {
      key: "artifacts",
      title: "Artifacts",
      hidden: artifacts.length === 0,
      children: (
        <div className="space-y-1.5">
          {artifacts.map((artifact, index) => (
            <button
              key={`${artifact.persona_id ?? artifact.persona_label}-${index}`}
              type="button"
              onClick={() => setOpenArtifact(artifact)}
              className="hover:bg-muted/40 flex w-full items-center gap-2 border px-2 py-1.5 text-left"
            >
              <FileText className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {artifact.persona_label ?? artifact.persona_id ?? "Artifact"}
              </span>
            </button>
          ))}
        </div>
      ),
    },
  ];

  return (
    <>
      <DetailSidebar sections={sections} />
      <ArtifactDialog
        artifact={openArtifact}
        open={!!openArtifact}
        onOpenChange={(open) => {
          if (!open) setOpenArtifact(null);
        }}
      />
    </>
  );
}

function personasForDepth(depth: BriefingDepth | string): Persona[] {
  const rank = DEPTH_RANK[depth] ?? DEPTH_RANK.guided;
  return PERSONAS.filter(
    (persona) =>
      persona.id === "final_synthesizer" ||
      (DEPTH_RANK[persona.minDepth] ?? 0) <= rank,
  );
}

function parseArtifacts(value: unknown): PersonaArtifact[] {
  return Array.isArray(value) ? (value as PersonaArtifact[]) : [];
}

function parseActivePersona(value: unknown): ActivePersona | null {
  return value && typeof value === "object" ? (value as ActivePersona) : null;
}

function inferActivePersonaIndex({
  personas,
  liveOutputText,
  activePersona,
}: {
  personas: Persona[];
  liveOutputText: string;
  activePersona: ActivePersona | null;
}) {
  const activePersonaId = activePersona?.persona_id;
  if (typeof activePersonaId === "string") {
    const index = personas.findIndex((persona) => persona.id === activePersonaId);
    if (index >= 0) return index;
  }
  let activeIndex = -1;
  for (let i = 0; i < personas.length; i += 1) {
    if (
      liveOutputText.includes(`→ ${personas[i].label} using`) ||
      liveOutputText.includes(`→ ${personas[i].label} already completed`)
    ) {
      activeIndex = i;
    }
  }
  return activeIndex;
}

function personaStatus({
  index,
  activeIndex,
  hasArtifact,
  isGenerating,
}: {
  index: number;
  activeIndex: number;
  hasArtifact: boolean;
  isGenerating: boolean;
}): PersonaStatus {
  if (isGenerating) {
    if (activeIndex < 0) return index === 0 ? "running" : "pending";
    if (index < activeIndex) return "completed";
    if (index === activeIndex) return "running";
    return "pending";
  }
  if (hasArtifact) return "completed";
  return "pending";
}

function PersonaRow({
  persona,
  status,
  artifact,
  onOpenArtifact,
}: {
  persona: Persona;
  status: PersonaStatus;
  artifact?: PersonaArtifact;
  onOpenArtifact: () => void;
}) {
  return (
    <div className="border-border/70 border px-2 py-2">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <p className="min-w-0 flex-1 truncate font-medium">{persona.label}</p>
        <PersonaStatusBadge status={status} />
      </div>
      {artifact && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-muted-foreground min-w-0 truncate font-mono text-[10px]">
            {artifact.provider}:{artifact.model}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onOpenArtifact}
            className="h-6 px-2 text-[11px]"
          >
            View
          </Button>
        </div>
      )}
      {artifact?.warning && (
        <p className="text-amber-600 dark:text-amber-400 mt-1 text-[10px] leading-relaxed">
          {artifact.warning}
        </p>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: PersonaStatus }) {
  if (status === "running") {
    return (
      <CircleNotch className="size-3.5 shrink-0 animate-spin text-foreground" />
    );
  }
  const className =
    status === "completed"
      ? "bg-emerald-500"
      : "bg-muted-foreground/30";
  return <span className={`size-2 shrink-0 ${className}`} />;
}

function PersonaStatusBadge({ status }: { status: PersonaStatus }) {
  const variant = status === "running" ? "secondary" : "outline";
  return (
    <Badge variant={variant} className="font-mono text-[10px]">
      {status}
    </Badge>
  );
}

function ArtifactDialog({
  artifact,
  open,
  onOpenChange,
}: {
  artifact: PersonaArtifact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {artifact?.persona_label ?? artifact?.persona_id ?? "Persona artifact"}
          </DialogTitle>
          <DialogDescription>
            {artifact?.provider && artifact?.model
              ? `${artifact.provider}:${artifact.model}`
              : "Structured output from the briefing lab."}
          </DialogDescription>
        </DialogHeader>
        <pre className="scrollbar-styled bg-background max-h-[62vh] overflow-auto border p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {JSON.stringify(artifact?.output ?? artifact ?? {}, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function normalizePersonaLabel(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
