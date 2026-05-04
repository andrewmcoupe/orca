/**
 * Session-level suppression set for file-overlap warnings (Brief 4 M8).
 *
 * The brief: "within the current session, don't show the warning twice
 * for the same `(starting_task, other_task)` combination". Held in a
 * module-scoped Set so it survives component remounts but is wiped on
 * full app reload — exactly the lifetime the brief asks for. Persisted
 * suppression isn't worth the storage churn given how short sessions
 * tend to be.
 */
const dismissed = new Set<string>();

export function isOverlapDismissed(key: string): boolean {
  return dismissed.has(key);
}

export function dismissOverlapPairs(keys: string[]): void {
  for (const k of keys) dismissed.add(k);
}

/** Test hook: reset the dismissed set. Not used in production code. */
export function _resetSuppressionForTests(): void {
  dismissed.clear();
}
