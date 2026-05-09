import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ContentColumn } from "@/components/layout/content-column";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Markdown } from "@/components/markdown";
import { LinearLogo } from "@/features/integrations/linear/components/linear-logo";
import {
  useAcceptBriefing,
  useApplyBriefingEdits,
  useCancelBriefing,
  useCancelBriefingGeneration,
  useRefineBriefing,
} from "../hooks";
import {
  emptyEdits,
  type AmbiguityItem,
  type Briefing,
  type BriefingDraft,
  type BriefingEdits,
  type DraftAssumption,
  type DraftTask,
  type FileCertainty,
  type ImportedBriefingSource,
  type RelevantFile,
  type TaskEdit,
} from "../types";

// ============================================================================
// Edit-merge helpers (mirror the Rust apply_edits_to_draft)
// ============================================================================

function mergeDraft(draft: BriefingDraft, edits: BriefingEdits): BriefingDraft {
  const out: BriefingDraft = {
    ...draft,
    title: edits.title ?? draft.title,
    description: edits.description ?? draft.description,
    assumptions: draft.assumptions, // edits don't mutate assumptions; pushbacks are separate
    tasks: draft.tasks
      .filter((t) => !edits.task_removals.includes(t.id))
      .map((t) => {
        const te = edits.task_edits.find((e) => e.task_id === t.id);
        if (!te) return t;
        const remaining = t.relevant_files.filter(
          (f) => !te.file_removals.includes(f.path),
        );
        return {
          ...t,
          title: te.title ?? t.title,
          spec_markdown: te.spec_markdown ?? t.spec_markdown,
          relevant_files: [...remaining, ...te.file_additions],
        };
      })
      .concat(edits.task_additions),
  };
  return out;
}

function ulid() {
  // Lightweight client-side id; the backend backfills with a real ULID if needed.
  return `dt_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

// ============================================================================
// Component
// ============================================================================

export function BriefingReviewScreen({
  briefing,
  onAccepted,
  onCancelled,
}: {
  briefing: Briefing;
  onAccepted: (planId: string) => void;
  onCancelled: () => void;
}) {
  const draft = briefing.current_draft!;
  const validations = briefing.validation_results ?? [];

  // Local edit state. We keep raw edits (not the merged draft) so re-rendering
  // a fresh BriefingDraftProduced from the backend resets cleanly: any new
  // refinement clears `edits` to start a fresh round.
  const [edits, setEdits] = useState<BriefingEdits>(emptyEdits);
  // Reset edits whenever a new draft generation lands.
  useEffect(() => {
    setEdits(emptyEdits());
  }, [briefing.generation_count]);

  const merged = useMemo(() => mergeDraft(draft, edits), [draft, edits]);
  const requiredUnresolved = useMemo(
    () =>
      (merged.ambiguity_ledger ?? []).filter(
        (item) =>
          item.user_input_required &&
          item.status !== "assumed" &&
          item.status !== "user_resolved",
      ),
    [merged.ambiguity_ledger],
  );

  const validationMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const v of validations) m.set(`${v.task_id}::${v.path}`, v.exists);
    return m;
  }, [validations]);

  const hasEdits =
    edits.title !== null ||
    edits.description !== null ||
    edits.task_edits.length > 0 ||
    edits.task_additions.length > 0 ||
    edits.task_removals.length > 0 ||
    edits.assumption_pushbacks.length > 0 ||
    !!edits.general_notes?.trim();

  const applyEdits = useApplyBriefingEdits();
  const refine = useRefineBriefing();
  const cancelGeneration = useCancelBriefingGeneration();
  const accept = useAcceptBriefing();
  const cancel = useCancelBriefing();
  // `working` only covers the synchronous-completion mutations (accept and
  // cancel-briefing). The refine spinner is driven by `briefing.is_generating`
  // from the projection — that's the only reliable source while the worker
  // can outlive any one component's lifetime.
  const [working, setWorking] = useState<"idle" | "accepting" | "cancelling">(
    "idle",
  );
  const [acceptRecommendedAssumptions, setAcceptRecommendedAssumptions] =
    useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live elapsed counter while the projection says we're generating. Anchors
  // off the briefing's `updated_at` (set by `BriefingGenerationStarted`), so
  // navigating away and back shows the correct elapsed time.
  const isRefining = briefing.is_generating;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRefining) {
      setElapsed(0);
      return;
    }
    const started = briefing.updated_at;
    setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    const t = setInterval(
      () =>
        setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000))),
      1000,
    );
    return () => clearInterval(t);
  }, [isRefining, briefing.updated_at]);

  // ------------------------------------------------------------------ edits

  const setTitle = (next: string) =>
    setEdits((p) => ({ ...p, title: next === draft.title ? null : next }));
  const setDescription = (next: string) =>
    setEdits((p) => ({
      ...p,
      description: next === draft.description ? null : next,
    }));

  const upsertTaskEdit = (
    taskId: string,
    update: (te: TaskEdit) => TaskEdit,
  ) =>
    setEdits((p) => {
      const existing = p.task_edits.find((e) => e.task_id === taskId) ?? {
        task_id: taskId,
        title: null,
        spec_markdown: null,
        file_additions: [],
        file_removals: [],
      };
      const next = update(existing);
      // Drop the entry if it's a no-op so we don't spam empty edits to the backend.
      const nonEmpty =
        next.title !== null ||
        next.spec_markdown !== null ||
        next.file_additions.length > 0 ||
        next.file_removals.length > 0;
      const others = p.task_edits.filter((e) => e.task_id !== taskId);
      return { ...p, task_edits: nonEmpty ? [...others, next] : others };
    });

  const setTaskTitle = (taskId: string, next: string) => {
    const original = draft.tasks.find((t) => t.id === taskId)?.title ?? "";
    upsertTaskEdit(taskId, (te) => ({
      ...te,
      title: next === original ? null : next,
    }));
  };
  const setTaskSpec = (taskId: string, next: string) => {
    const original =
      draft.tasks.find((t) => t.id === taskId)?.spec_markdown ?? "";
    upsertTaskEdit(taskId, (te) => ({
      ...te,
      spec_markdown: next === original ? null : next,
    }));
  };

  const removeRelevantFile = (taskId: string, path: string) => {
    // If this path was an addition, drop the addition rather than removing an
    // original file that doesn't exist.
    upsertTaskEdit(taskId, (te) => {
      const wasAdded = te.file_additions.some((f) => f.path === path);
      if (wasAdded) {
        return {
          ...te,
          file_additions: te.file_additions.filter((f) => f.path !== path),
        };
      }
      return {
        ...te,
        file_removals: te.file_removals.includes(path)
          ? te.file_removals
          : [...te.file_removals, path],
      };
    });
  };

  const addRelevantFile = (taskId: string, file: RelevantFile) => {
    upsertTaskEdit(taskId, (te) => ({
      ...te,
      file_additions: [...te.file_additions, file],
    }));
  };

  const removeTask = (taskId: string) => {
    setEdits((p) => {
      // If the task was a local addition, drop it from additions instead.
      if (p.task_additions.some((t) => t.id === taskId)) {
        return {
          ...p,
          task_additions: p.task_additions.filter((t) => t.id !== taskId),
        };
      }
      return {
        ...p,
        task_removals: p.task_removals.includes(taskId)
          ? p.task_removals
          : [...p.task_removals, taskId],
      };
    });
  };

  const addTask = () => {
    setEdits((p) => ({
      ...p,
      task_additions: [
        ...p.task_additions,
        {
          id: ulid(),
          title: "New task",
          spec_markdown: "",
          relevant_files: [],
        },
      ],
    }));
  };

  const setGeneralNotes = (text: string) => {
    setEdits((p) => ({ ...p, general_notes: text.length === 0 ? null : text }));
  };

  const setPushback = (assumptionId: string, text: string) => {
    setEdits((p) => {
      const others = p.assumption_pushbacks.filter(
        (pb) => pb.assumption_id !== assumptionId,
      );
      // Don't trim while typing — that would strip the space the user just
      // pressed and the controlled textarea would refuse to advance the caret.
      // Treat whitespace-only as "no pushback" so the row stays clean, but
      // preserve internal/trailing whitespace until persistence.
      if (!text.trim()) return { ...p, assumption_pushbacks: others };
      return {
        ...p,
        assumption_pushbacks: [
          ...others,
          { assumption_id: assumptionId, pushback: text },
        ],
      };
    });
  };

  // ------------------------------------------------------------------ actions

  const persistEditsIfAny = async () => {
    if (!hasEdits) return;
    // Trim pushback text only at the persistence boundary — keeping it loose
    // during typing lets the user enter spaces normally.
    const trimmedNotes = edits.general_notes?.trim() ?? "";
    const sanitised = {
      ...edits,
      assumption_pushbacks: edits.assumption_pushbacks
        .map((p) => ({ ...p, pushback: p.pushback.trim() }))
        .filter((p) => p.pushback.length > 0),
      general_notes: trimmedNotes.length > 0 ? trimmedNotes : null,
    };
    await applyEdits.mutateAsync({ briefingId: briefing.id, edits: sanitised });
  };

  const handleRefine = async () => {
    setErrorMsg(null);
    try {
      await persistEditsIfAny();
      // Fire-and-forget: returns once the worker is spawned. The spinner is
      // driven by `briefing.is_generating`, which the global live-updates
      // listener keeps fresh.
      await refine.mutateAsync(briefing.id);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const handleStopRefine = async () => {
    setErrorMsg(null);
    try {
      await cancelGeneration.mutateAsync(briefing.id);
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const handleAccept = async () => {
    setErrorMsg(null);
    setWorking("accepting");
    try {
      await persistEditsIfAny();
      const plan = await accept.mutateAsync({
        briefingId: briefing.id,
        acceptAssumptions: acceptRecommendedAssumptions,
      });
      onAccepted(plan.id);
    } catch (e) {
      setErrorMsg(String(e));
      setWorking("idle");
    }
  };

  const handleCancel = async () => {
    setErrorMsg(null);
    setWorking("cancelling");
    try {
      await cancel.mutateAsync(briefing.id);
      onCancelled();
    } catch (e) {
      setErrorMsg(String(e));
      setWorking("idle");
    }
  };

  // Don't let the user accept while a refine is in flight — the post-refine
  // draft would land on top, silently swapping out the work they're about to
  // commit. The action bar surfaces this via the disabled state.
  const acceptDisabled =
    merged.tasks.length === 0 ||
    working !== "idle" ||
    isRefining ||
    (requiredUnresolved.length > 0 && !acceptRecommendedAssumptions);

  // ------------------------------------------------------------------ render

  return (
    <ContentColumn className="space-y-6 px-5 py-6 pb-32">
      <Header
        title={merged.title}
        onTitleChange={setTitle}
        generationCount={briefing.generation_count}
        provider={briefing.provider}
        model={briefing.model}
        briefingDepth={briefing.briefing_depth}
        importedSources={briefing.imported_sources}
      />

      <ConfirmationSummary
        draft={merged}
        selectedDepth={briefing.briefing_depth}
        requiredUnresolved={requiredUnresolved}
        acceptRecommendedAssumptions={acceptRecommendedAssumptions}
        onAcceptRecommendedAssumptionsChange={setAcceptRecommendedAssumptions}
      />

      <Section label="Description">
        <Textarea
          value={merged.description}
          onChange={(e) => setDescription(e.target.value)}
          rows={Math.max(4, merged.description.split("\n").length)}
          className="text-sm leading-relaxed"
        />
      </Section>

      <DistillationWorkbench draft={merged} />

      <Section
        label="Assumptions"
        hint="Push back on anything the model assumed wrongly. Pushbacks become input to the next refinement."
      >
        {merged.assumptions.length === 0 ? (
          <p className="text-muted-foreground text-sm italic">
            No assumptions recorded.
          </p>
        ) : (
          <ul className="space-y-2">
            {merged.assumptions.map((a) => (
              <AssumptionRow
                key={a.id}
                assumption={a}
                pushback={
                  edits.assumption_pushbacks.find(
                    (p) => p.assumption_id === a.id,
                  )?.pushback ?? ""
                }
                onPushbackChange={(text) => setPushback(a.id, text)}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        label={`Tasks (${merged.tasks.length})`}
        hint="Each task is independently executable. Edit titles, specs, and the file list inline."
      >
        <div className="space-y-3">
          {merged.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              validations={validationMap}
              onTitleChange={(t) => setTaskTitle(task.id, t)}
              onSpecChange={(t) => setTaskSpec(task.id, t)}
              onAddFile={(f) => addRelevantFile(task.id, f)}
              onRemoveFile={(path) => removeRelevantFile(task.id, path)}
              onRemoveTask={() => removeTask(task.id)}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addTask}
            disabled={working !== "idle" || isRefining}
          >
            + Add task
          </Button>
        </div>
      </Section>

      <Section
        label="Additional notes"
        hint="Anything else the model should consider on the next refinement — context, scope changes, or feedback that doesn't map to a specific task or assumption above."
      >
        <Textarea
          value={edits.general_notes ?? ""}
          onChange={(e) => setGeneralNotes(e.target.value)}
          rows={4}
          placeholder="Optional. e.g. 'We use Drizzle, not Prisma' or 'Drop everything related to auth — out of scope for this milestone.'"
          className="text-sm leading-relaxed"
        />
      </Section>

      {errorMsg && (
        <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3">
          <p className="text-destructive text-sm font-medium">Operation failed</p>
          <p className="text-destructive/80 mt-1 font-mono text-xs whitespace-pre-wrap">
            {errorMsg}
          </p>
        </div>
      )}

      {isRefining && (
        <div className="border-border bg-muted/30 flex items-center gap-3 rounded-md border p-3">
          <span className="border-foreground/20 border-t-foreground inline-block h-3 w-3 animate-spin rounded-full border-2" />
          <div className="flex-1">
            <p className="text-sm font-medium">Refining draft…</p>
            <p className="text-muted-foreground text-xs">
              {elapsed}s elapsed. You can navigate away and come back —
              generation continues in the background.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleStopRefine}
            disabled={cancelGeneration.isPending}
          >
            {cancelGeneration.isPending ? "Stopping…" : "Stop"}
          </Button>
        </div>
      )}

      {!isRefining && briefing.last_generation_error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-md border p-3"
        >
          <p className="text-destructive text-sm font-medium">
            Refine attempt failed
          </p>
          <p className="text-destructive/80 mt-1 whitespace-pre-wrap font-mono text-xs">
            {briefing.last_generation_error}
          </p>
        </div>
      )}

      <ActionBar
        canAccept={!acceptDisabled}
        hasEdits={hasEdits}
        working={working}
        isRefining={isRefining}
        onRefine={handleRefine}
        onAccept={handleAccept}
        onCancel={handleCancel}
      />
    </ContentColumn>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function Header({
  title,
  onTitleChange,
  generationCount,
  provider,
  model,
  briefingDepth,
  importedSources,
}: {
  title: string;
  onTitleChange: (next: string) => void;
  generationCount: number;
  provider: string;
  model: string;
  briefingDepth: string;
  importedSources: ImportedBriefingSource[];
}) {
  const [editing, setEditing] = useState(false);
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        {editing ? (
          <Input
            autoFocus
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") setEditing(false);
            }}
            className="text-xl font-medium"
          />
        ) : (
          <button
            type="button"
            className="hover:bg-muted/40 -mx-1 truncate rounded px-1 text-left text-xl font-medium tracking-tight"
            onClick={() => setEditing(true)}
            title="Click to edit"
          >
            {title || "Untitled briefing"}
          </button>
        )}
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span>Draft {generationCount}</span>
          <span>·</span>
          <Badge variant="secondary" className="font-mono text-[10px]">
            {provider}:{model}
          </Badge>
          <span>·</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {briefingDepth}
          </Badge>
          {importedSources.length > 0 && (
            <>
              <span>·</span>
              <span>
                {importedSources.length} imported source
                {importedSources.length === 1 ? "" : "s"}
              </span>
            </>
          )}
        </div>
        {importedSources.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {importedSources.map((source) => (
              <button
                type="button"
                key={`${source.provider}:${source.external_id}`}
                onClick={() => openUrl(source.url)}
                className="border-border bg-muted/40 hover:bg-muted inline-flex max-w-full items-center gap-1 border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                title={`Open ${source.identifier}`}
              >
                {source.provider === "linear" ? (
                  <LinearLogo className="size-3" />
                ) : (
                  <span>{source.provider}</span>
                )}
                <span>{source.identifier}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <Label className="text-sm font-semibold">{label}</Label>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function ConfirmationSummary({
  draft,
  selectedDepth,
  requiredUnresolved,
  acceptRecommendedAssumptions,
  onAcceptRecommendedAssumptionsChange,
}: {
  draft: BriefingDraft;
  selectedDepth: string;
  requiredUnresolved: AmbiguityItem[];
  acceptRecommendedAssumptions: boolean;
  onAcceptRecommendedAssumptionsChange: (next: boolean) => void;
}) {
  const approved = draft.approved_assumptions ?? draft.assumptions.map((a) => a.statement);
  const risks = draft.structured_brief?.risks ?? [];
  return (
    <section className="rounded-md border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Label className="text-sm font-semibold">
            Here&apos;s what I think you want…
          </Label>
          <p className="text-sm text-muted-foreground">
            {draft.structured_brief?.goal || draft.description}
          </p>
        </div>
        <Badge
          variant={
            draft.readiness_status === "blocked_needs_user_input"
              ? "destructive"
              : "secondary"
          }
          className="font-mono text-[10px]"
        >
          {draft.readiness_status ?? "ready_with_assumptions"}
        </Badge>
      </div>
      <dl className="mt-3 grid gap-2 text-xs md:grid-cols-3">
        <SummaryItem label="Recommended depth" value={draft.recommended_depth ?? selectedDepth} />
        <SummaryItem label="Task count" value={String(draft.tasks.length)} />
        <SummaryItem
          label="Confidence"
          value={
            typeof draft.confidence_score === "number"
              ? `${Math.round(draft.confidence_score * 100)}%`
              : "Unknown"
          }
        />
        <SummaryItem label="Approved assumptions" value={String(approved.length)} />
        <SummaryItem label="Unresolved questions" value={String(requiredUnresolved.length)} />
        <SummaryItem label="Notable risks" value={String(risks.length)} />
      </dl>
      {requiredUnresolved.length > 0 && (
        <label className="mt-3 flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={acceptRecommendedAssumptions}
            onChange={(e) =>
              onAcceptRecommendedAssumptionsChange(e.currentTarget.checked)
            }
            className="mt-0.5"
          />
          <span className="text-muted-foreground">
            Accept recommended assumptions for unresolved required questions and
            allow task creation.
          </span>
        </label>
      )}
    </section>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function DistillationWorkbench({ draft }: { draft: BriefingDraft }) {
  const classification = draft.classification;
  const budget = draft.budget_estimate;
  const structured = draft.structured_brief;
  const hasDistillation =
    classification ||
    budget ||
    (draft.ambiguity_ledger ?? []).length > 0 ||
    structured ||
    (draft.persona_model_mapping ?? []).length > 0;
  if (!hasDistillation) return null;

  return (
    <Section
      label="Distillation lab"
      hint="Structured model outputs used to decide whether this brief is ready for tasks."
    >
      <div className="grid gap-3">
        {(classification || budget) && (
          <Card className="grid gap-3 p-4 md:grid-cols-2">
            {classification && (
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                  Request classification
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline">complexity: {classification.complexity}</Badge>
                  <Badge variant="outline">ambiguity: {classification.ambiguity}</Badge>
                  <Badge variant="outline">risk: {classification.risk}</Badge>
                </div>
                {classification.likely_touched_areas?.length > 0 && (
                  <p className="text-muted-foreground text-xs">
                    Areas: {classification.likely_touched_areas.join(", ")}
                  </p>
                )}
              </div>
            )}
            {budget && (
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs uppercase tracking-wide">
                  Budget tradeoff
                </Label>
                <p className="text-sm">{budget.token_strategy}</p>
                <p className="text-muted-foreground text-xs">
                  {budget.cost_level} cost · {budget.risk_level} risk ·{" "}
                  {Math.round((budget.confidence ?? 0) * 100)}% confidence
                </p>
              </div>
            )}
          </Card>
        )}

        {(draft.ambiguity_ledger ?? []).length > 0 && (
          <Card className="space-y-3 p-4">
            <Label className="text-muted-foreground text-xs uppercase tracking-wide">
              Ambiguity ledger
            </Label>
            {(draft.ambiguity_ledger ?? []).map((item) => (
              <div key={item.id} className="rounded-sm border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-sm">{item.question}</p>
                  <Badge variant={item.user_input_required ? "destructive" : "secondary"}>
                    {item.status}
                  </Badge>
                </div>
                <p className="mt-1 text-muted-foreground text-xs">
                  {item.why_it_matters}
                </p>
                <p className="mt-2 text-xs">
                  Default: {item.recommended_default_assumption}
                </p>
              </div>
            ))}
          </Card>
        )}

        {structured && (
          <Card className="grid gap-3 p-4 md:grid-cols-2">
            <BriefList title="Required behavior" items={structured.required_behavior} />
            <BriefList title="UX requirements" items={structured.ux_requirements} />
            <BriefList title="Data/API" items={structured.data_api_requirements} />
            <BriefList title="Tests required" items={structured.tests_required} />
            <BriefList title="Risks" items={structured.risks} />
            <BriefList title="Acceptance criteria" items={structured.acceptance_criteria} />
          </Card>
        )}

        {(draft.persona_model_mapping ?? []).length > 0 && (
          <Card className="space-y-2 p-4">
            <Label className="text-muted-foreground text-xs uppercase tracking-wide">
              Persona model mapping
            </Label>
            <div className="grid gap-2 md:grid-cols-2">
              {(draft.persona_model_mapping ?? []).map((m) => (
                <div key={m.persona} className="text-xs">
                  <span className="font-medium">{m.persona}</span>{" "}
                  <span className="text-muted-foreground font-mono">
                    {m.provider}:{m.model}
                  </span>
                  {m.warning && (
                    <span className="text-amber-600"> · {m.warning}</span>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </Section>
  );
}

function BriefList({ title, items }: { title: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="space-y-1">
      <Label className="text-muted-foreground text-xs uppercase tracking-wide">
        {title}
      </Label>
      <ul className="list-disc space-y-1 pl-4 text-sm">
        {items.map((item, i) => (
          <li key={`${title}-${i}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function AssumptionRow({
  assumption,
  pushback,
  onPushbackChange,
}: {
  assumption: DraftAssumption;
  pushback: string;
  onPushbackChange: (text: string) => void;
}) {
  const [open, setOpen] = useState(pushback.length > 0);
  return (
    <li className="border-border bg-card rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm">{assumption.statement}</p>
        {!open && !pushback && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(true)}
          >
            Push back
          </Button>
        )}
      </div>
      {(open || pushback) && (
        <div className="mt-2">
          <Textarea
            placeholder='e.g. "treat as required" or "actually not needed"'
            value={pushback}
            onChange={(e) => onPushbackChange(e.target.value)}
            rows={2}
            className="text-sm"
          />
          {pushback && (
            <p className="text-muted-foreground mt-1 text-xs">
              Will be sent to the model on next refinement.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Acceptance criteria field that defaults to rendered markdown (so reviewers
 * can skim without parsing source) and swaps to a textarea on click. Exits
 * edit mode on blur — the parent already persists every keystroke through
 * `onChange`, so blur is purely a UI affordance.
 */
function SpecField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const isEmpty = value.trim().length === 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-muted-foreground text-xs uppercase tracking-wide">
          Acceptance criteria
        </Label>
        {!editing && !isEmpty && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
          >
            Edit
          </button>
        )}
      </div>
      {editing || isEmpty ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            if (!isEmpty) setEditing(false);
          }}
          rows={Math.max(3, value.split("\n").length)}
          className="font-mono text-sm leading-relaxed"
          placeholder="Numbered list of acceptance criteria…"
          autoFocus={editing}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Click to edit"
          className="hover:bg-muted/30 block w-full rounded-sm border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border"
        >
          <Markdown className="text-sm">{value}</Markdown>
        </button>
      )}
    </div>
  );
}

function TaskCard({
  task,
  validations,
  onTitleChange,
  onSpecChange,
  onAddFile,
  onRemoveFile,
  onRemoveTask,
}: {
  task: DraftTask;
  validations: Map<string, boolean>;
  onTitleChange: (next: string) => void;
  onSpecChange: (next: string) => void;
  onAddFile: (file: RelevantFile) => void;
  onRemoveFile: (path: string) => void;
  onRemoveTask: () => void;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <Input
          value={task.title}
          onChange={(e) => onTitleChange(e.target.value)}
          className="text-base font-medium"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemoveTask}
          className="text-destructive hover:text-destructive"
        >
          Remove
        </Button>
      </div>

      <SpecField
        value={task.spec_markdown}
        onChange={onSpecChange}
      />



      <div className="space-y-1.5">
        <Label className="text-muted-foreground text-xs uppercase tracking-wide">
          Relevant files
        </Label>
        <div className="flex flex-wrap gap-2">
          {task.relevant_files.map((f, i) => {
            const exists = validations.get(`${task.id}::${f.path}`);
            const missing = exists === false;
            return (
              <FileChip
                key={`${f.path}-${i}`}
                file={f}
                missing={missing}
                onRemove={() => onRemoveFile(f.path)}
              />
            );
          })}
          <AddFileChip onAdd={onAddFile} />
        </div>
      </div>
    </Card>
  );
}

function FileChip({
  file,
  missing,
  onRemove,
}: {
  file: RelevantFile;
  missing: boolean;
  onRemove: () => void;
}) {
  const dotClass =
    file.certainty === "Confirmed"
      ? "bg-foreground"
      : "border-foreground/60 border bg-transparent";
  return (
    <span
      className={`group inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs ${
        missing
          ? "border-amber-500/60 bg-amber-50 dark:bg-amber-950/30"
          : "border-border bg-muted/40"
      }`}
      title={`${file.reason}${missing ? " — file not found in workspace" : ""}`}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
      <span className="truncate max-w-[280px]">{file.path}</span>
      {missing && (
        <span
          className="text-amber-600 dark:text-amber-400"
          aria-label="File not found"
        >
          ⚠
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground -mr-0.5 ml-0.5"
        aria-label={`Remove ${file.path}`}
      >
        ×
      </button>
    </span>
  );
}

function AddFileChip({ onAdd }: { onAdd: (f: RelevantFile) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [certainty, setCertainty] = useState<FileCertainty>("Candidate");
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground hover:bg-muted/40 inline-flex items-center rounded-md border border-dashed px-2 py-1 font-mono text-xs"
      >
        + Add file
      </button>
    );
  }
  const submit = () => {
    if (!path.trim()) return;
    onAdd({
      path: path.trim(),
      certainty,
      reason: reason.trim() || "manually added by user",
    });
    setPath("");
    setReason("");
    setOpen(false);
  };
  return (
    <span className="border-border bg-card inline-flex items-center gap-1 rounded-md border p-1">
      <Input
        autoFocus
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="src/path/to/file.ts"
        className="h-7 w-56 font-mono text-xs"
      />
      <select
        value={certainty}
        onChange={(e) => setCertainty(e.target.value as FileCertainty)}
        className="border-input bg-background h-7 rounded border px-1 text-xs"
        aria-label="Certainty"
      >
        <option value="Confirmed">Confirmed</option>
        <option value="Candidate">Candidate</option>
      </select>
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="reason"
        className="h-7 w-40 text-xs"
      />
      <Button type="button" size="sm" onClick={submit} className="h-7 text-xs">
        Add
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(false)}
        className="h-7 text-xs"
      >
        Cancel
      </Button>
    </span>
  );
}

function ActionBar({
  canAccept,
  hasEdits,
  working,
  isRefining,
  onRefine,
  onAccept,
  onCancel,
}: {
  canAccept: boolean;
  hasEdits: boolean;
  working: "idle" | "accepting" | "cancelling";
  /** Projection-driven: a refine generation is running on the backend. */
  isRefining: boolean;
  onRefine: () => void;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const refineDisabled = !hasEdits || working !== "idle" || isRefining;
  const refineTitle = isRefining
    ? "A refine is already running. Wait for it to finish or stop it."
    : hasEdits
      ? "Send your edits and pushbacks back to the model for another pass"
      : "Make at least one edit or pushback to refine";
  return (
    <div className="border-border bg-background/95 fixed inset-x-0 bottom-0 z-10 border-t backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <ContentColumn className="flex items-center justify-between gap-3 px-5 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={working !== "idle"}
        >
          {working === "cancelling" ? "Cancelling…" : "Cancel briefing"}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onRefine}
            disabled={refineDisabled}
            title={refineTitle}
          >
            {isRefining ? "Refining…" : "Refine again"}
          </Button>
          <Button
            type="button"
            onClick={onAccept}
            disabled={!canAccept}
            title={
              canAccept
                ? "Create a plan with these tasks"
                : isRefining
                  ? "Wait for the current refine to finish before accepting"
                  : "Need at least one task to accept"
            }
          >
            {working === "accepting" ? "Creating plan…" : "Accept and create plan"}
          </Button>
        </div>
      </ContentColumn>
    </div>
  );
}
