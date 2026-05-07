import type { LinearIssue } from "./types";
import type { ImportedBriefingSource } from "@/features/briefings/types";

const MAX_DESCRIPTION_CHARS = 8_000;
const MAX_COMMENT_CHARS = 1_200;
const MAX_COMMENTS = 8;

function compact(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "Not provided";
}

function truncate(value: string | null | undefined, maxChars: number) {
  const text = compact(value);
  if (text === "Not provided" || text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[Truncated by Orca after ${maxChars} characters.]`,
    truncated: true,
  };
}

export function linearIssuesToBriefingMarkdown(issues: LinearIssue[]) {
  if (issues.length === 0) return "";

  const sections = issues.map((issue) => {
    const labels = issue.labels.length > 0 ? issue.labels.join(", ") : "None";
    const description = truncate(issue.description, MAX_DESCRIPTION_CHARS);
    const commentsForPrompt = issue.comments.slice(0, MAX_COMMENTS);
    const omittedComments = Math.max(0, issue.comments.length - commentsForPrompt.length);
    const comments =
      commentsForPrompt.length > 0
        ? commentsForPrompt
            .map((comment) => {
              const author = comment.user_name ?? "Unknown author";
              const body = truncate(comment.body, MAX_COMMENT_CHARS);
              return `- ${author}: ${body.text}`;
            })
            .join("\n")
        : "No imported comments.";
    const truncationNotes = [
      description.truncated ? `- Description truncated to ${MAX_DESCRIPTION_CHARS} characters.` : null,
      omittedComments > 0 ? `- ${omittedComments} additional comment${omittedComments === 1 ? "" : "s"} omitted.` : null,
    ].filter(Boolean);

    return `### ${issue.identifier}: ${issue.title}

- Source: ${issue.url}
- Status: ${compact(issue.state)}
- Team: ${compact(issue.team_name ?? issue.team_key)}
- Assignee: ${compact(issue.assignee)}
- Labels: ${labels}

Description:

${description.text}

Imported comments:

${comments}
${truncationNotes.length > 0 ? `\n\nImport notes:\n\n${truncationNotes.join("\n")}` : ""}`;
  });

  return `Imported Linear issue context:

${sections.join("\n\n---\n\n")}`;
}

export function linearIssuesToBriefingSources(
  issues: LinearIssue[],
): ImportedBriefingSource[] {
  const importedAt = Date.now();
  return issues.map((issue) => ({
    provider: "linear",
    external_id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    imported_at: importedAt,
  }));
}
