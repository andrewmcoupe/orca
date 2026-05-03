import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Markdown } from "@/components/markdown";
import type {
  BriefingDraft,
  BriefingEdits,
  BriefingHistoryEntry,
  PathValidationResult,
  RelevantFile,
} from "../types";

/**
 * Read-only audit trail of a briefing — initial description, every draft, every
 * edit/pushback the user applied, the eventual completion or cancellation.
 *
 * Renders the raw event log with a clear visual hierarchy. The brief calls
 * for v1 to be plain ("doesn't need to be pretty") — this is exactly that.
 */
export function BriefingTranscriptView({
  entries,
}: {
  entries: BriefingHistoryEntry[];
}) {
  const ordered = useMemo(
    () => [...entries].sort((a, b) => a.seq - b.seq),
    [entries],
  );

  if (ordered.length === 0) {
    return (
      <p className="text-muted-foreground text-sm italic">
        No events recorded for this briefing.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {ordered.map((e) => (
        <li key={e.id}>
          <EntryCard entry={e} />
        </li>
      ))}
    </ol>
  );
}

function EntryCard({ entry }: { entry: BriefingHistoryEntry }) {
  return (
    <Card className="space-y-2 p-4">
      <header className="flex items-center justify-between gap-2">
        <Badge variant="secondary" className="font-mono text-[10px]">
          {entry.event_type}
        </Badge>
        <span className="text-muted-foreground text-[11px] tabular-nums">
          seq {entry.seq} · {formatTimestamp(entry.created_at)}
        </span>
      </header>
      <EntryBody entry={entry} />
    </Card>
  );
}

function EntryBody({ entry }: { entry: BriefingHistoryEntry }) {
  // The shape of `payload` varies by event_type; downcast progressively. Anything
  // we don't recognise falls through to a JSON dump so nothing is silently lost.
  const payload = entry.payload as Record<string, unknown>;

  switch (entry.event_type) {
    case "BriefingStarted":
      return (
        <div className="space-y-2 text-sm">
          <Field label="Provider">
            <code className="text-xs">
              {(payload.provider as string) ?? "?"}:
              {(payload.model as string) ?? "?"}
            </code>
          </Field>
          <Field label="Initial description">
            <Markdown>
              {(payload.initial_description as string) ?? ""}
            </Markdown>
          </Field>
        </div>
      );

    case "BriefingDraftProduced": {
      const draft = payload.draft as BriefingDraft | undefined;
      const validations = (payload.validation_results as PathValidationResult[]) ?? [];
      const missing = validations.filter((v) => !v.exists).length;
      const gen = payload.generation_index as number | undefined;
      const durationMs = payload.duration_ms as number | undefined;
      return (
        <div className="space-y-3 text-sm">
          <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {gen != null && <span>Generation {gen}</span>}
            {durationMs != null && <span>{(durationMs / 1000).toFixed(1)}s</span>}
            {validations.length > 0 && (
              <span>
                {validations.length} file path{validations.length === 1 ? "" : "s"}{" "}
                checked
                {missing > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {" "}
                    · {missing} missing
                  </span>
                )}
              </span>
            )}
          </div>
          {draft && <DraftSummary draft={draft} />}
        </div>
      );
    }

    case "BriefingDraftEdited": {
      const edits = payload.edits as BriefingEdits | undefined;
      if (!edits) return <RawJson value={payload} />;
      return <EditsSummary edits={edits} />;
    }

    case "BriefingPushedBack":
      return (
        <div className="space-y-1 text-sm">
          <Field label="Assumption">
            <code className="text-xs">
              {(payload.assumption_id as string) ?? "?"}
            </code>
          </Field>
          <Field label="Pushback">
            <p>{(payload.pushback as string) ?? ""}</p>
          </Field>
        </div>
      );

    case "BriefingRefineRequested":
      return (
        <p className="text-muted-foreground text-sm italic">
          User requested another refinement pass.
        </p>
      );

    case "BriefingCompleted":
      return (
        <div className="space-y-1 text-sm">
          <Field label="Plan">
            <code className="text-xs">{(payload.plan_id as string) ?? "?"}</code>
          </Field>
          {payload.final_generation_index != null && (
            <Field label="Final generation">
              {String(payload.final_generation_index)}
            </Field>
          )}
        </div>
      );

    case "BriefingCancelled":
      return (
        <Field label="Reason">
          <code className="text-xs">{(payload.reason as string) ?? "?"}</code>
        </Field>
      );

    default:
      return <RawJson value={payload} />;
  }
}

function DraftSummary({ draft }: { draft: BriefingDraft }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-base font-medium">{draft.title || "Untitled"}</p>
        {draft.description && (
          <div className="mt-1">
            <Markdown>{draft.description}</Markdown>
          </div>
        )}
      </div>
      {draft.assumptions.length > 0 && (
        <Field label={`Assumptions (${draft.assumptions.length})`}>
          <ul className="list-inside list-disc space-y-0.5 text-sm">
            {draft.assumptions.map((a) => (
              <li key={a.id}>{a.statement}</li>
            ))}
          </ul>
        </Field>
      )}
      <Field label={`Tasks (${draft.tasks.length})`}>
        <ul className="space-y-2">
          {draft.tasks.map((t) => (
            <li
              key={t.id}
              className="border-border bg-muted/20 rounded-sm border p-2"
            >
              <p className="text-sm font-medium">{t.title}</p>
              {t.spec_markdown && (
                <p className="text-muted-foreground mt-1 whitespace-pre-wrap text-xs">
                  {t.spec_markdown}
                </p>
              )}
              {t.relevant_files.length > 0 && (
                <FileList files={t.relevant_files} />
              )}
            </li>
          ))}
        </ul>
      </Field>
    </div>
  );
}

function FileList({ files }: { files: RelevantFile[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-1">
      {files.map((f, i) => (
        <li
          key={`${f.path}-${i}`}
          className="border-border inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px]"
          title={f.reason}
        >
          <span
            className={
              f.certainty === "Confirmed"
                ? "bg-foreground inline-block h-1.5 w-1.5 rounded-full"
                : "border-foreground/60 inline-block h-1.5 w-1.5 rounded-full border bg-transparent"
            }
          />
          {f.path}
        </li>
      ))}
    </ul>
  );
}

function EditsSummary({ edits }: { edits: BriefingEdits }) {
  const bits: string[] = [];
  if (edits.title !== null && edits.title !== undefined) bits.push("title");
  if (edits.description !== null && edits.description !== undefined)
    bits.push("description");
  if (edits.task_edits.length)
    bits.push(`${edits.task_edits.length} task edit${edits.task_edits.length === 1 ? "" : "s"}`);
  if (edits.task_additions.length)
    bits.push(`${edits.task_additions.length} task added`);
  if (edits.task_removals.length)
    bits.push(`${edits.task_removals.length} task removed`);
  if (edits.assumption_pushbacks.length)
    bits.push(
      `${edits.assumption_pushbacks.length} pushback${edits.assumption_pushbacks.length === 1 ? "" : "s"}`,
    );

  return (
    <div className="space-y-1 text-sm">
      <p>
        User applied edits:{" "}
        <span className="text-muted-foreground">
          {bits.length > 0 ? bits.join(", ") : "no-op"}
        </span>
      </p>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-[11px] uppercase tracking-wide">
        {label}
      </p>
      {children}
    </div>
  );
}

function RawJson({ value }: { value: unknown }) {
  return (
    <pre className="bg-muted/40 overflow-x-auto rounded-sm p-2 font-mono text-[11px]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function formatTimestamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
