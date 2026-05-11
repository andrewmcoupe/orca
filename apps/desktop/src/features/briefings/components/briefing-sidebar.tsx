import { useEffect, useMemo, useState } from "react";
import { Check, CircleNotch, Copy, FileText } from "@phosphor-icons/react";
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
import { ProviderModelLabel } from "@/features/providers/components/provider-logo";
import type {
  AmbiguityItem,
  Briefing,
  BriefingDepth,
  PersonaModelMapping,
} from "../types";

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

type PersonaRuntime = {
  provider?: string;
  model?: string;
  warning?: string | null;
  fallback_used?: boolean;
};

export function BriefingSidebar({
  briefing,
  liveOutputText,
}: {
  briefing: Briefing;
  liveOutputText: string;
}) {
  const [openArtifact, setOpenArtifact] = useState<PersonaArtifact | null>(
    null,
  );
  const personas = personasForDepth(briefing.briefing_depth);
  const artifacts = parseArtifacts(
    briefing.persona_artifacts?.length
      ? briefing.persona_artifacts
      : briefing.current_draft?.persona_artifacts,
  );
  const artifactsByPersona = new Map(
    artifacts.map((artifact) => [
      artifact.persona_id ??
        normalizePersonaLabel(artifact.persona_label ?? ""),
      artifact,
    ]),
  );
  const modelMappings = briefing.current_draft?.persona_model_mapping ?? [];
  const runtimeByPersona = new Map(
    modelMappings.map((mapping) => [
      normalizePersonaLabel(mapping.persona),
      mapping,
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
                  <ProviderModelLabel
                    provider={activePersona.provider}
                    model={activePersona.model}
                    separator="/"
                    logoClassName="size-2.5"
                  />
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
            const runtime = artifact ?? runtimeByPersona.get(persona.id);
            const status = personaStatus({
              index,
              activeIndex,
              hasRuntime: !!runtime,
              isGenerating: briefing.is_generating,
            });
            return (
              <PersonaRow
                key={persona.id}
                persona={persona}
                status={status}
                artifact={artifact}
                runtime={runtime}
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
    const index = personas.findIndex(
      (persona) => persona.id === activePersonaId,
    );
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
  hasRuntime,
  isGenerating,
}: {
  index: number;
  activeIndex: number;
  hasRuntime: boolean;
  isGenerating: boolean;
}): PersonaStatus {
  if (hasRuntime) return "completed";
  if (isGenerating) {
    if (activeIndex < 0) return index === 0 ? "running" : "pending";
    if (index < activeIndex) return "completed";
    if (index === activeIndex) return "running";
    return "pending";
  }
  return "pending";
}

function PersonaRow({
  persona,
  status,
  artifact,
  runtime,
  onOpenArtifact,
}: {
  persona: Persona;
  status: PersonaStatus;
  artifact?: PersonaArtifact;
  runtime?: PersonaRuntime | PersonaModelMapping;
  onOpenArtifact: () => void;
}) {
  return (
    <div className="border-border/70 border px-2 py-2">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <p className="min-w-0 flex-1 truncate font-medium">{persona.label}</p>
        <PersonaStatusBadge status={status} />
      </div>
      {runtime && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-muted-foreground min-w-0 truncate font-mono text-[10px]">
            <ProviderModelLabel
              provider={runtime.provider}
              model={runtime.model}
              separator="/"
              logoClassName="size-2.5"
            />
          </p>
          {artifact && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onOpenArtifact}
              className="h-6 px-2 text-[11px]"
            >
              View
            </Button>
          )}
        </div>
      )}
      {runtime?.warning && (
        <p className="text-amber-600 dark:text-amber-400 mt-1 text-[10px] leading-relaxed">
          {runtime.warning}
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
    status === "completed" ? "bg-emerald-500" : "bg-muted-foreground/30";
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
  const [view, setView] = useState<"readable" | "raw">("readable");
  const [copied, setCopied] = useState(false);
  const payload = artifact?.output ?? artifact ?? {};
  const rawJson = JSON.stringify(payload, null, 2);

  useEffect(() => {
    if (!open) return;
    setView("readable");
    setCopied(false);
  }, [open, artifact]);

  const copyRawJson = async () => {
    try {
      await navigator.clipboard.writeText(rawJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable in some host contexts */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <div className="flex items-start justify-between gap-4">
          <DialogHeader>
            <DialogTitle>
              {artifact?.persona_label ??
                artifact?.persona_id ??
                "Persona artifact"}
            </DialogTitle>
            <DialogDescription>
              {artifact?.provider && artifact?.model ? (
                <ProviderModelLabel
                  provider={artifact.provider}
                  model={artifact.model}
                  separator="/"
                  logoClassName="size-2.5"
                />
              ) : (
                "Structured output from the briefing lab."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 items-center gap-1">
            <div className="border-border flex border">
              <Button
                type="button"
                size="sm"
                variant={view === "readable" ? "secondary" : "ghost"}
                onClick={() => setView("readable")}
                className="h-7 rounded-none px-2 text-[11px]"
              >
                Readable
              </Button>
              <Button
                type="button"
                size="sm"
                variant={view === "raw" ? "secondary" : "ghost"}
                onClick={() => setView("raw")}
                className="h-7 rounded-none border-l px-2 text-[11px]"
              >
                Raw JSON
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={copyRawJson}
              className="h-7 px-2 text-[11px]"
            >
              {copied ? (
                <>
                  <Check className="size-3" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-3" /> Copy
                </>
              )}
            </Button>
          </div>
        </div>
        {view === "readable" ? (
          <ReadableArtifact artifact={artifact} value={payload} />
        ) : (
          <pre className="scrollbar-styled bg-background min-h-0 flex-1 overflow-auto border p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {rawJson}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReadableArtifact({
  artifact,
  value,
}: {
  artifact: PersonaArtifact | null;
  value: unknown;
}) {
  if (isAmbiguityHunterArtifact(artifact, value)) {
    return <AmbiguityHunterArtifact value={value} artifact={artifact} />;
  }
  if (isIntentExtractorArtifact(artifact, value)) {
    return <IntentExtractorArtifact value={value} />;
  }

  if (!isRecord(value)) {
    return (
      <div className="scrollbar-styled min-h-0 flex-1 overflow-auto px-1 py-2 font-serif">
        <ReadableArtifactValue value={value} fieldKey="artifact" />
      </div>
    );
  }

  const entries = Object.entries(value).filter(
    ([, item]) => !isEmptyValue(item),
  );
  if (entries.length === 0) {
    return (
      <div className="scrollbar-styled min-h-0 flex-1 overflow-auto px-1 py-2 font-serif text-sm text-muted-foreground">
        This artifact did not include any structured fields.
      </div>
    );
  }

  return (
    <div className="scrollbar-styled min-h-0 flex-1 space-y-6 overflow-auto px-1 py-2 font-serif">
      {entries.map(([key, item]) => (
        <section key={key} className="space-y-2">
          <h3 className="text-base font-semibold leading-snug text-foreground">
            {humanizeKey(key)}
          </h3>
          <IntentFindingValue value={item} fieldKey={key} />
        </section>
      ))}
    </div>
  );
}

function IntentExtractorArtifact({
  value,
}: {
  value: Record<string, unknown>;
}) {
  const orderedKeys = [
    "goal",
    "user_value",
    "target_users",
    "core_workflows",
    "explicit_requirements",
    "implied_requirements",
    "non_goals",
    "success_criteria",
  ];
  const keys = [
    ...orderedKeys.filter((key) => !isEmptyValue(value[key])),
    ...Object.keys(value).filter(
      (key) => !orderedKeys.includes(key) && !isEmptyValue(value[key]),
    ),
  ];

  if (keys.length === 0) {
    return (
      <div className="scrollbar-styled min-h-0 flex-1 overflow-auto px-1 py-2 font-serif text-sm text-muted-foreground">
        No intent findings were included.
      </div>
    );
  }

  return (
    <div className="scrollbar-styled min-h-0 flex-1 space-y-6 overflow-auto px-1 py-2 font-serif">
      {keys.map((key) => {
        const item = value[key];
        if (isEmptyValue(item)) return null;
        return (
          <section key={key} className="space-y-2">
            <h3 className="text-base font-semibold leading-snug text-foreground">
              {humanizeKey(key)}
            </h3>
            <IntentFindingValue value={item} fieldKey={key} />
          </section>
        );
      })}
    </div>
  );
}

function IntentFindingValue({
  value,
  fieldKey,
}: {
  value: unknown;
  fieldKey: string;
}) {
  return <ReadableArtifactValue value={value} fieldKey={fieldKey} />;
}

function ReadableArtifactValue({
  value,
  fieldKey,
}: {
  value: unknown;
  fieldKey: string;
}) {
  if (Array.isArray(value)) {
    const items = value.filter((item) => !isEmptyValue(item));
    if (items.length === 0) return null;
    return (
      <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-foreground/65">
        {items.map((item, index) => (
          <li key={`${fieldKey}-${index}`} className="pl-1">
            {isRecord(item) ? (
              <ReadableArtifactObject value={item} fieldKey={fieldKey} />
            ) : Array.isArray(item) ? (
              <ReadableArtifactValue
                value={item}
                fieldKey={`${fieldKey}-${index}`}
              />
            ) : (
              stringifyScalar(item)
            )}
          </li>
        ))}
      </ul>
    );
  }

  if (isRecord(value)) {
    return <ReadableArtifactObject value={value} fieldKey={fieldKey} />;
  }

  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/65">
      {stringifyScalar(value)}
    </p>
  );
}

function ReadableArtifactObject({
  value,
  fieldKey,
}: {
  value: Record<string, unknown>;
  fieldKey: string;
}) {
  const titleEntry = getReadableObjectTitle(value);
  const rows = Object.entries(value).filter(
    ([key, item]) => !isEmptyValue(item) && key !== titleEntry?.[0],
  );

  if (!titleEntry && rows.length === 0) return null;

  return (
    <div className="space-y-2 text-sm leading-relaxed text-foreground/65">
      {titleEntry ? (
        <p className="font-mono text-xs leading-relaxed text-foreground/80">
          {stringifyScalar(titleEntry[1])}
        </p>
      ) : null}
      {rows.map(([key, item]) => (
        <div key={key} className="space-y-1">
          {Array.isArray(item) || isRecord(item) ? (
            <>
              <p className="font-semibold text-foreground">
                {humanizeKey(key)}
              </p>
              <ReadableArtifactValue
                value={item}
                fieldKey={`${fieldKey}-${key}`}
              />
            </>
          ) : (
            <p className="whitespace-pre-wrap">
              <span className="font-semibold text-foreground">
                {humanizeKey(key)}:
              </span>{" "}
              {stringifyScalar(item)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function AmbiguityHunterArtifact({
  value,
  artifact,
}: {
  value: Record<string, unknown>;
  artifact: PersonaArtifact | null;
}) {
  const ledger = parseAmbiguityLedger(value.ambiguity_ledger);
  const requiredCount = ledger.filter(
    (item) => item.user_input_required,
  ).length;
  const assumedCount = ledger.filter(
    (item) => !item.user_input_required,
  ).length;
  const supplementaryKeys = [
    "missing_decisions",
    "conflicting_requirements",
    "vague_terms",
    "risky_assumptions",
    "recommended_default_assumptions",
  ].filter((key) => !isEmptyValue(value[key]));

  return (
    <div className="scrollbar-styled min-h-0 flex-1 overflow-auto px-1 py-2 font-serif">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="font-body text-[13px] font-semibold text-muted-foreground">
          <span>{ledger.length} questions</span>
          {requiredCount > 0 && (
            <>
              <span> · </span>
              <span className="text-warning">
                {requiredCount} default pending
              </span>
            </>
          )}
          {assumedCount > 0 && (
            <>
              <span> · </span>
              <span>{assumedCount} auto-assumed</span>
            </>
          )}
        </div>
        {(artifact?.provider || artifact?.model) && (
          <div className="text-muted-foreground font-mono text-xs font-normal">
            <ProviderModelLabel
              provider={artifact?.provider}
              model={artifact?.model}
              separator="/"
              logoClassName="size-2.5"
            />
          </div>
        )}
      </div>

      {ledger.length > 0 ? (
        <div className="space-y-6">
          {ledger.map((item, index) => (
            <AmbiguityLedgerCard
              key={item.id || index}
              item={item}
              index={index}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          The Ambiguity Hunter did not report any ambiguity ledger items.
        </p>
      )}

      {supplementaryKeys.length > 0 && (
        <div className="mt-7 space-y-6 border-t pt-6">
          {supplementaryKeys.map((key) => (
            <section key={key} className="space-y-2">
              <h3 className="text-base font-semibold leading-snug text-foreground">
                {humanizeKey(key)}
              </h3>
              <IntentFindingValue value={value[key]} fieldKey={key} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AmbiguityLedgerCard({
  item,
  index,
}: {
  item: AmbiguityItem;
  index: number;
}) {
  const needsInput = item.user_input_required;
  const label = needsInput
    ? "Default pending"
    : item.status === "user_resolved"
      ? "User resolved"
      : "Auto-assumed";

  return (
    <article className="space-y-3 crisp-gradient-border rounded-sm p-4">
      <div className="mb-2 flex items-center gap-3">
        <p className="font-mono text-xs text-muted-foreground">
          {item.id || `amb-${index + 1}`}
        </p>
        <span
          className={`font-body shrink-0 border px-3 py-1 text-xs font-semibold ${
            needsInput
              ? "bg-warning/20 text-warning"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {label}
        </span>
      </div>

      <h3 className="text-lg font-semibold leading-snug text-foreground">
        <InlineCodeText text={item.question} />
      </h3>

      <div
        className={`border-l-4 py-0.5 pl-4 ${
          needsInput ? "border-warning" : "border-blue-500"
        }`}
      >
        <p className="font-body text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {needsInput ? "Suggested default" : "Assumed answer"}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-foreground/65">
          <InlineCodeText text={item.recommended_default_assumption} />
        </p>
      </div>

      <div className="space-y-3 text-sm leading-relaxed text-foreground/65">
        <section className="space-y-1">
          <h4 className="font-semibold text-foreground">Why it matters</h4>
          <p>
            <InlineCodeText text={item.why_it_matters} />
          </p>
        </section>
        <section className="space-y-1">
          <h4 className="font-semibold text-foreground">Risk</h4>
          <p>
            <InlineCodeText text={item.risk_if_unanswered} />
          </p>
        </section>
        {item.user_answer && (
          <section className="space-y-1">
            <h4 className="font-semibold text-foreground">User answer</h4>
            <p>
              <InlineCodeText text={item.user_answer} />
            </p>
          </section>
        )}
      </div>
      {needsInput && (
        <p className="font-body pt-2 text-xs text-muted-foreground">
          If you do nothing, this default will be used when tasks are created.
          Answer it under Decisions and assumptions, or add pushback and refine
          if the draft should change first.
        </p>
      )}
    </article>
  );
}

function InlineCodeText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <code
            key={index}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em]"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function isAmbiguityHunterArtifact(
  artifact: PersonaArtifact | null,
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.ambiguity_ledger)) return false;
  const personaId = artifact?.persona_id ?? "";
  const personaLabel = normalizePersonaLabel(artifact?.persona_label ?? "");
  return (
    personaId === "ambiguity_hunter" || personaLabel === "ambiguity_hunter"
  );
}

function isIntentExtractorArtifact(
  artifact: PersonaArtifact | null,
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const personaId = artifact?.persona_id ?? "";
  const personaLabel = normalizePersonaLabel(artifact?.persona_label ?? "");
  return (
    personaId === "intent_extractor" || personaLabel === "intent_extractor"
  );
}

function parseAmbiguityLedger(value: unknown): AmbiguityItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isAmbiguityItem);
}

function isAmbiguityItem(value: unknown): value is AmbiguityItem {
  return (
    isRecord(value) &&
    typeof value.question === "string" &&
    typeof value.why_it_matters === "string" &&
    typeof value.risk_if_unanswered === "string" &&
    typeof value.recommended_default_assumption === "string"
  );
}

function getReadableObjectTitle(
  value: Record<string, unknown>,
): [string, unknown] | null {
  const titleKeys = ["task", "title", "name", "id", "phase"];
  for (const key of titleKeys) {
    const item = value[key];
    if (!isEmptyValue(item) && !Array.isArray(item) && !isRecord(item)) {
      return [key, item];
    }
  }
  return null;
}

function stringifyScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEmptyValue(value: unknown) {
  return (
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

function humanizeKey(key: string) {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizePersonaLabel(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
