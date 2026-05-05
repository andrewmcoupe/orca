import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ContentColumn } from "@/components/layout/content-column";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  useAcceptBriefing,
  useApplyBriefingEdits,
  useCancelBriefing,
  useCancelBriefingGeneration,
  useRefineBriefing,
} from "../hooks";
import {
  emptyEdits,
  type Briefing,
  type BriefingDraft,
  type BriefingEdits,
  type DraftAssumption,
  type DraftTask,
  type FileCertainty,
  type RelevantFile,
  type TaskEdit,
} from "../types";

// ============================================================================
// Edit-merge helpers (mirror the Rust apply_edits_to_draft)
// ============================================================================

function mergeDraft(draft: BriefingDraft, edits: BriefingEdits): BriefingDraft {
  const out: BriefingDraft = {
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
    edits.assumption_pushbacks.length > 0;

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

  const setPushback = (assumptionId: string, text: string) => {
    setEdits((p) => {
      const others = p.assumption_pushbacks.filter(
        (pb) => pb.assumption_id !== assumptionId,
      );
      if (!text.trim()) return { ...p, assumption_pushbacks: others };
      return {
        ...p,
        assumption_pushbacks: [
          ...others,
          { assumption_id: assumptionId, pushback: text.trim() },
        ],
      };
    });
  };

  // ------------------------------------------------------------------ actions

  const persistEditsIfAny = async () => {
    if (!hasEdits) return;
    await applyEdits.mutateAsync({ briefingId: briefing.id, edits });
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
      const plan = await accept.mutateAsync(briefing.id);
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
    merged.tasks.length === 0 || working !== "idle" || isRefining;

  // ------------------------------------------------------------------ render

  return (
    <ContentColumn className="space-y-6 px-5 py-6 pb-32">
      <Header
        title={merged.title}
        onTitleChange={setTitle}
        generationCount={briefing.generation_count}
        provider={briefing.provider}
        model={briefing.model}
      />

      <Section label="Description">
        <Textarea
          value={merged.description}
          onChange={(e) => setDescription(e.target.value)}
          rows={Math.max(4, merged.description.split("\n").length)}
          className="text-sm leading-relaxed"
        />
      </Section>

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
}: {
  title: string;
  onTitleChange: (next: string) => void;
  generationCount: number;
  provider: string;
  model: string;
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
        </div>
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

      <div className="space-y-1.5">
        <Label className="text-muted-foreground text-xs uppercase tracking-wide">
          Acceptance criteria
        </Label>
        <Textarea
          value={task.spec_markdown}
          onChange={(e) => onSpecChange(e.target.value)}
          rows={Math.max(3, task.spec_markdown.split("\n").length)}
          className="font-mono text-sm leading-relaxed"
          placeholder="Numbered list of acceptance criteria…"
        />
      </div>

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
