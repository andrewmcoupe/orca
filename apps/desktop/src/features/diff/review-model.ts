import type {
  AuditorCriterionMapping,
  AuditorUnmappedHunk,
  HighlightedDiffFile,
  HighlightedTaskDiff,
} from "./types";

export type AcceptanceCriterion = {
  id: string;
  index: number;
  title: string;
};

export type HunkRef = {
  file: string;
  hunkIndex: number;
};

export type CriterionReviewItem = AcceptanceCriterion & {
  mapping: AuditorCriterionMapping | null;
  hunkRefs: HunkRef[];
  satisfied: boolean | null;
  notes: string | null;
};

export type ReviewMode = "by_criterion" | "by_file";
export type ReviewSelection = string | "other";

const AC_HEADING_RE =
  /^(#{1,6}\s*)?(acceptance criteria|acceptance|criteria)\s*:?\s*$/i;

export function parseAcceptanceCriteria(markdown: string): AcceptanceCriterion[] {
  const lines = markdown.split(/\r?\n/);
  let inSection = false;
  const criteria: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#{1,6}\s+/.test(line)) {
      if (AC_HEADING_RE.test(line.replace(/^#{1,6}\s+/, ""))) {
        inSection = true;
        continue;
      }
      if (inSection) break;
    }

    if (!inSection && AC_HEADING_RE.test(line)) {
      inSection = true;
      continue;
    }

    const item = parseCriterionLine(line);
    if (item && (inSection || criteria.length === 0)) {
      criteria.push(item);
      continue;
    }

    if (inSection && criteria.length > 0 && !line.startsWith("-") && !/^\d+[.)]/.test(line)) {
      break;
    }
  }

  return criteria.map((title, index) => ({
    id: `ac_${index + 1}`,
    index: index + 1,
    title,
  }));
}

function parseCriterionLine(line: string): string | null {
  const checklist = line.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/);
  if (checklist) return cleanupCriterion(checklist[1]);

  const bullet = line.match(/^[-*]\s+(.+)$/);
  if (bullet) return cleanupCriterion(bullet[1]);

  const numbered = line.match(/^\d+[.)]\s+(.+)$/);
  if (numbered) return cleanupCriterion(numbered[1]);

  return null;
}

function cleanupCriterion(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildCriterionReviewItems(
  criteria: AcceptanceCriterion[],
  mappings: AuditorCriterionMapping[] | undefined | null,
): CriterionReviewItem[] {
  const byId = new Map((mappings ?? []).map((mapping) => [mapping.criterion_id, mapping]));
  return criteria.map((criterion) => {
    const mapping = byId.get(criterion.id) ?? null;
    return {
      ...criterion,
      mapping,
      hunkRefs:
        mapping?.hunks
          .filter((hunk) => Number.isInteger(hunk.hunk_index) && hunk.hunk_index >= 0)
          .map((hunk) => ({ file: hunk.file, hunkIndex: hunk.hunk_index })) ?? [],
      satisfied: mapping?.satisfied ?? null,
      notes: mapping?.notes ?? null,
    };
  });
}

export function hasUsableCriterionMapping(items: CriterionReviewItem[]): boolean {
  return items.some((item) => item.hunkRefs.length > 0 || item.mapping !== null);
}

export function filesForHunkRefs(
  diff: HighlightedTaskDiff,
  refs: HunkRef[],
): HighlightedDiffFile[] {
  if (refs.length === 0) return [];
  const wanted = new Map<string, Set<number>>();
  for (const ref of refs) {
    const indexes = wanted.get(ref.file) ?? new Set<number>();
    indexes.add(ref.hunkIndex);
    wanted.set(ref.file, indexes);
  }
  return diff.files.filter((file) => wanted.has(file.path) || (file.old_path && wanted.has(file.old_path)));
}

export function hunkRefsForUnmapped(unmapped: AuditorUnmappedHunk[] | undefined | null): HunkRef[] {
  return (unmapped ?? [])
    .filter((hunk) => Number.isInteger(hunk.hunk_index) && hunk.hunk_index >= 0)
    .map((hunk) => ({ file: hunk.file, hunkIndex: hunk.hunk_index }));
}

export function revisionKey(taskId: string, headCommit: string, verdictPhaseRunId?: string | null) {
  return `${taskId}:${headCommit || "no-head"}:${verdictPhaseRunId ?? "no-verdict"}`;
}
