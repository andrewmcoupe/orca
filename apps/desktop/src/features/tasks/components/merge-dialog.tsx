import { useEffect, useMemo, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  isMergeCommandError,
  type MergeAnalysis,
  type MergeCommandError,
  type MergeStrategy,
} from "@/features/tasks/merge-api";
import {
  useAnalyzeTaskMerge,
  useExecuteTaskMerge,
} from "@/features/tasks/merge-hooks";

type Props = {
  taskId: string;
  taskTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const SHORT_SHA_LEN = 8;

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LEN);
}

function defaultCommitMessage(taskTitle: string, taskId: string): string {
  return `${taskTitle.trim()}\n\nTask: ${taskId}\n`;
}

/**
 * Replaces the land form while Git is running. We swap the body rather than
 * overlaying it because the overlay's translucent background was barely
 * distinguishable from the dialog itself in some themes — users couldn't tell
 * the click had registered. A dedicated panel makes the in-flight state
 * unambiguous.
 */
function MergingProgress({
  analysis,
}: {
  analysis: MergeAnalysis;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-10 text-center"
      role="status"
      aria-live="polite"
    >
      <CircleNotch className="size-8 animate-spin" />
      <p className="text-base font-medium">Landing…</p>
      <p className="text-muted-foreground max-w-sm text-xs">
        Applying the proposal into{" "}
        <code className="font-mono">{analysis.target_branch}</code>. This can
        take a few seconds for large changes.
      </p>
    </div>
  );
}

export function MergeDialog({ taskId, taskTitle, open, onOpenChange }: Props) {
  const analyze = useAnalyzeTaskMerge();
  const execute = useExecuteTaskMerge();

  const strategy: MergeStrategy = "squash";
  const [message, setMessage] = useState<string>(() =>
    defaultCommitMessage(taskTitle, taskId),
  );
  // Track whether the user has manually edited the message — if not, regenerate
  // the default when the title changes between dialog opens.
  const [messageDirty, setMessageDirty] = useState(false);
  // Persist the analysis result locally so the dialog still has something to render
  // while a follow-up mutation is in flight.
  const [analysis, setAnalysis] = useState<MergeAnalysis | null>(null);
  const [analyzeError, setAnalyzeError] = useState<unknown>(null);
  const [executeError, setExecuteError] = useState<unknown>(null);

  const reset = () => {
    setAnalysis(null);
    setAnalyzeError(null);
    setExecuteError(null);
    setMessage(defaultCommitMessage(taskTitle, taskId));
    setMessageDirty(false);
    analyze.reset();
    execute.reset();
  };

  // Kick off analysis when the dialog opens.
  useEffect(() => {
    if (!open) return;
    reset();
    analyze.mutate(taskId, {
      onSuccess: (result) => {
        setAnalysis(result);
      },
      onError: (err) => {
        setAnalyzeError(err);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId]);

  // If the parent passes a new title without remounting, refresh the default message
  // when the user hasn't started editing.
  useEffect(() => {
    if (!messageDirty) {
      setMessage(defaultCommitMessage(taskTitle, taskId));
    }
  }, [taskTitle, taskId, messageDirty]);

  const handleConfirm = () => {
    setExecuteError(null);
    execute.mutate(
      { taskId, strategy, commitMessage: message },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
        onError: (err) => setExecuteError(err),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{titleFor(analysis, taskTitle)}</DialogTitle>
          {analysis && !analysis.already_merged && (
            <DialogDescription className="font-mono text-xs">
              <code>{analysis.source_branch}</code>
              <span className="text-muted-foreground"> → </span>
              <code>{analysis.target_branch}</code>
              <span className="text-muted-foreground">
                {" "}
                · {shortSha(analysis.source_head_sha)} →{" "}
                {shortSha(analysis.target_head_sha)}
              </span>
            </DialogDescription>
          )}
        </DialogHeader>

        {!analysis && analyzeError == null && (
          <div className="flex items-center gap-2 py-6">
            <CircleNotch className="size-5 animate-spin" />
            <p className="text-muted-foreground text-sm">
              Checking whether this proposal can land…
            </p>
          </div>
        )}

        {analyzeError != null && (
          <AnalysisErrorView
            error={analyzeError}
            onClose={() => onOpenChange(false)}
          />
        )}

        {analysis?.already_merged && (
          <AlreadyMergedView
            analysis={analysis}
            onClose={() => onOpenChange(false)}
          />
        )}

        {analysis && !analysis.already_merged && analysis.conflicts.length > 0 && (
          <ConflictView
            analysis={analysis}
            onClose={() => onOpenChange(false)}
          />
        )}

        {analysis &&
          !analysis.already_merged &&
          analysis.conflicts.length === 0 &&
          (execute.isPending ? (
            <MergingProgress analysis={analysis} />
          ) : (
            <CleanMergeForm
              analysis={analysis}
              strategy={strategy}
              message={message}
              onMessageChange={(v) => {
                setMessage(v);
                setMessageDirty(true);
              }}
              onConfirm={handleConfirm}
              onCancel={() => onOpenChange(false)}
              executing={execute.isPending}
              executeError={executeError}
            />
          ))}
      </DialogContent>
    </Dialog>
  );
}

function titleFor(analysis: MergeAnalysis | null, taskTitle: string): string {
  if (!analysis) return "Land task";
  if (analysis.already_merged) return "Already landed";
  if (analysis.conflicts.length > 0) return "Collisions detected";
  return `Land "${taskTitle}"`;
}

function AlreadyMergedView({
  analysis,
  onClose,
}: {
  analysis: MergeAnalysis;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        This task is already landed into{" "}
        <code className="font-mono">{analysis.target_branch}</code> as{" "}
        <code className="font-mono">{shortSha(analysis.target_head_sha)}</code>.
      </p>
      <DialogFooter>
        <Button onClick={onClose}>Got it</Button>
      </DialogFooter>
    </div>
  );
}

function ConflictView({
  analysis,
  onClose,
}: {
  analysis: MergeAnalysis;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        These files have collisions between the proposal and{" "}
        <code className="font-mono">{analysis.source_branch}</code> and{" "}
        <code className="font-mono">{analysis.target_branch}</code>:
      </p>
      <ul className="scrollbar-styled bg-muted/30 max-h-40 space-y-1 overflow-y-auto rounded-md border p-2 font-mono text-xs">
        {analysis.conflicts.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(path)}
              title="Copy path"
              className="hover:bg-muted block w-full truncate text-left"
            >
              {path}
            </button>
          </li>
        ))}
      </ul>
      <div className="text-muted-foreground space-y-1 text-xs">
        <p>Resolve these collisions manually before landing. You can:</p>
        <ul className="list-disc space-y-0.5 pl-5">
          <li>Switch to your parent task files</li>
          <li>
            Use your terminal or editor to resolve collisions, or
          </li>
          <li>Apply the changes by hand</li>
        </ul>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </div>
  );
}

function CleanMergeForm({
  analysis,
  strategy,
  message,
  onMessageChange,
  onConfirm,
  onCancel,
  executing,
  executeError,
}: {
  analysis: MergeAnalysis;
  strategy: MergeStrategy;
  message: string;
  onMessageChange: (s: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  executing: boolean;
  executeError: unknown;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const fileList = useMemo(() => {
    return analysis.source_commits.length > 0 ? analysis.source_commits : [];
  }, [analysis]);
  const stats = analysis.diff_summary;

  return (
    <div className="space-y-3">
      <div className="bg-muted/20 rounded-md border p-3 text-sm">
        <div className="font-mono text-xs">
          {stats.files_changed} file{stats.files_changed === 1 ? "" : "s"}{" "}
          changed
          <span className="text-emerald-600 dark:text-emerald-400">
            , {stats.insertions} insertion{stats.insertions === 1 ? "" : "s"}(+)
          </span>
          <span className="text-red-600 dark:text-red-400">
            , {stats.deletions} deletion{stats.deletions === 1 ? "" : "s"}(-)
          </span>
        </div>
        {fileList.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setFilesOpen((v) => !v)}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
            >
              {filesOpen ? "Hide" : "Show"} {fileList.length} revision
              {fileList.length === 1 ? "" : "s"}
            </button>
            {filesOpen && (
              <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
                {fileList.map((c) => (
                  <li key={c.sha} className="truncate">
                    <span className="text-muted-foreground">
                      {shortSha(c.sha)}
                    </span>{" "}
                    {c.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="text-muted-foreground text-[11px] uppercase tracking-wide">
          Strategy
        </Label>
        <div className="rounded-sm border bg-muted/20 px-2 py-1.5 text-xs">
          Land as one revision
          {strategy === "squash" && (
            <span className="text-muted-foreground"> · workspace default</span>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor="merge-commit-message"
          className="text-muted-foreground text-[11px] uppercase tracking-wide"
        >
          Revision message
        </Label>
        <Textarea
          id="merge-commit-message"
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          rows={6}
          className="font-mono text-xs"
        />
      </div>

      {executeError != null && <ExecuteErrorBanner error={executeError} />}

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={executing}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={executing || !message.trim()}>
          {executing && <CircleNotch className="size-4 animate-spin" />}
          {executing ? "Landing…" : "Land"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function ExecuteErrorBanner({ error }: { error: unknown }) {
  const parsed = parseError(error);
  return (
    <div className="border-destructive/40 bg-destructive/10 space-y-1 rounded-md border p-3 text-xs">
      <div className="text-destructive font-medium">{parsed.title}</div>
      {parsed.body && <div className="text-foreground/80">{parsed.body}</div>}
      {parsed.fileList && parsed.fileList.length > 0 && (
        <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
          {parsed.fileList.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AnalysisErrorView({
  error,
  onClose,
}: {
  error: unknown;
  onClose: () => void;
}) {
  const parsed = parseError(error);
  return (
    <div className="space-y-3">
      <div className="border-destructive/40 bg-destructive/10 space-y-1 rounded-md border p-3 text-sm">
        <div className="text-destructive font-medium">{parsed.title}</div>
        {parsed.body && <div className="text-foreground/80">{parsed.body}</div>}
        {parsed.fileList && parsed.fileList.length > 0 && (
          <ul className="scrollbar-styled mt-1 max-h-40 space-y-0.5 overflow-y-auto font-mono text-[11px]">
            {parsed.fileList.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </div>
  );
}

type ParsedError = {
  title: string;
  body?: string;
  fileList?: string[];
};

function parseError(err: unknown): ParsedError {
  if (isMergeCommandError(err)) {
    return mergeErrorToParsed(err);
  }
  return { title: "Land failed", body: String(err) };
}

function mergeErrorToParsed(err: MergeCommandError): ParsedError {
  switch (err.kind) {
    case "WorkingTreeDirty":
      return {
        title: "Unsaved parent changes",
        body: "Your parent task files have pending changes. Create a revision or clear them before landing.",
        fileList: err.details.dirty_files,
      };
    case "DetachedHead":
      return {
        title: "Parent target unavailable",
        body: "The parent target is detached. Select a normal parent line before landing.",
      };
    case "Conflicts":
      return {
        title: "Collisions detected during land",
        body: "These files have collisions. Resolve them manually and try again.",
        fileList: err.details.conflicts,
      };
    case "AlreadyMerged":
      return {
        title: "Already landed",
        body: `Proposal is already landed at ${err.details.commit_sha.slice(0, SHORT_SHA_LEN)}.`,
      };
    case "SourceBranchMissing":
      return {
        title: "Proposal source missing",
        body: `Proposal source ${err.details} was not found. Have the task files been removed?`,
      };
    case "TargetBranchMissing":
      return { title: "Parent target missing", body: err.details };
    case "InvalidStrategy":
      return { title: "Invalid land strategy", body: err.details };
    case "TaskNotFound":
      return { title: "Task not found" };
    case "TaskNotApproved":
      return {
        title: "Approval required",
        body: "This task is not approved. Wait for the current review to finish, then approve it before landing.",
      };
    case "PhaseRunning":
      return {
        title: "Task still running",
        body: "A task phase is still running. Wait for it to finish before landing.",
      };
    case "NoActiveWorkspace":
      return { title: "No active workspace" };
    case "NoWorktreeBranch":
      return {
        title: "No task files available",
        body: "There is no recorded proposal source for this task to land.",
      };
    case "GitError":
      return { title: "Version-control error", body: err.details };
    case "InternalError":
      return { title: "Internal error", body: err.details };
  }
}
