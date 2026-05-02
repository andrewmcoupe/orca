import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  usePrompt,
  useResetPrompt,
  useSavePrompt,
} from "@/features/prompts/hooks";
import type { PhaseType } from "@/features/prompts/api";

const PHASES: PhaseType[] = ["test_author", "implementer", "auditor"];

const COMMON_VARS =
  "task_title, acceptance_criteria, prior_phase_commits, is_retry, retry_context";
const PER_PHASE_HINT: Record<PhaseType, string> = {
  test_author: COMMON_VARS,
  implementer: `${COMMON_VARS}, prior_phase_commits.test_author`,
  auditor: `${COMMON_VARS}, git_diff`,
};

export function PromptsPanel({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="space-y-5">
      <div className="bg-muted/30 rounded-md border p-3 text-xs">
        <div className="text-muted-foreground mb-1 font-semibold uppercase tracking-wide">
          Available variables
        </div>
        <p>
          Templates use Handlebars syntax. Reference variables with{" "}
          <code className="font-mono">{"{{name}}"}</code> and conditional blocks
          with <code className="font-mono">{"{{#if name}}…{{/if}}"}</code>.
        </p>
      </div>
      {PHASES.map((phase) => (
        <PromptEditor key={phase} workspaceId={workspaceId} phase={phase} />
      ))}
    </div>
  );
}

function PromptEditor({
  workspaceId,
  phase,
}: {
  workspaceId: string;
  phase: PhaseType;
}) {
  const promptQ = usePrompt(workspaceId, phase);
  const save = useSavePrompt(workspaceId, phase);
  const reset = useResetPrompt(workspaceId, phase);
  const [draft, setDraft] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (promptQ.data && !touched) setDraft(promptQ.data.content);
  }, [promptQ.data, touched]);

  if (promptQ.isLoading || !promptQ.data) {
    return (
      <div className="space-y-2">
        <Label className="font-mono text-sm">{phase}</Label>
        <p className="text-muted-foreground text-xs">Loading…</p>
      </div>
    );
  }

  const dirty = draft !== promptQ.data.content;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label className="font-mono text-sm">{phase}</Label>
        <span className="text-muted-foreground text-[11px]">
          {promptQ.data.is_customised ? "customised" : "bundled default"}
        </span>
      </div>
      <p className="text-muted-foreground text-[11px]">
        Variables: <code className="font-mono">{PER_PHASE_HINT[phase]}</code>
      </p>
      <Textarea
        rows={14}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setTouched(true);
        }}
        className="font-mono text-xs"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() =>
            save.mutate(draft, {
              onSuccess: () => setTouched(false),
            })
          }
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!promptQ.data.is_customised || reset.isPending}
          onClick={() =>
            reset.mutate(undefined, {
              onSuccess: () => setTouched(false),
            })
          }
        >
          Reset to default
        </Button>
        {(save.error || reset.error) && (
          <span className="text-destructive text-xs">
            {String(save.error ?? reset.error)}
          </span>
        )}
      </div>
    </div>
  );
}
