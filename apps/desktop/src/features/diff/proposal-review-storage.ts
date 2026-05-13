const PREFIX = "orca:last-reviewed";

export function proposalReviewStorageKey(userId: string, taskId: string) {
  return `${PREFIX}:${userId}:${taskId}`;
}

export function readLastReviewedAt(userId: string, taskId: string): number | null {
  const raw = window.localStorage.getItem(proposalReviewStorageKey(userId, taskId));
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function markProposalReviewed(
  userId: string,
  taskId: string,
  reviewedAt = Date.now(),
) {
  window.localStorage.setItem(
    proposalReviewStorageKey(userId, taskId),
    String(reviewedAt),
  );
}

