import { describe, expect, it } from "vitest";
import {
  buildCriterionReviewItems,
  hasUsableCriterionMapping,
  hunkRefsForUnmapped,
  parseAcceptanceCriteria,
  revisionKey,
} from "./review-model";

describe("review model", () => {
  it("parses acceptance criteria from a headed checklist", () => {
    const criteria = parseAcceptanceCriteria(`
## Task
Do the thing.

## Acceptance Criteria
- [ ] Heart button toggles state
- Persists favourites
1. Empty state appears

## Notes
- not a criterion
`);

    expect(criteria).toEqual([
      { id: "ac_1", index: 1, title: "Heart button toggles state" },
      { id: "ac_2", index: 2, title: "Persists favourites" },
      { id: "ac_3", index: 3, title: "Empty state appears" },
    ]);
  });

  it("attaches auditor hunk mappings to parsed criteria", () => {
    const items = buildCriterionReviewItems(
      [
        { id: "ac_1", index: 1, title: "One" },
        { id: "ac_2", index: 2, title: "Two" },
      ],
      [
        {
          criterion_id: "ac_2",
          hunks: [{ file: "src/a.ts", hunk_index: 0 }],
          satisfied: true,
          notes: "Covered.",
        },
      ],
    );

    expect(items[0].hunkRefs).toEqual([]);
    expect(items[1].hunkRefs).toEqual([{ file: "src/a.ts", hunkIndex: 0 }]);
    expect(items[1].satisfied).toBe(true);
    expect(hasUsableCriterionMapping(items)).toBe(true);
  });

  it("normalises unmapped hunk refs and revision keys", () => {
    expect(
      hunkRefsForUnmapped([
        { file: "package.json", hunk_index: 0, category: "dependency" },
        { file: "bad", hunk_index: -1, category: "unknown" },
      ]),
    ).toEqual([{ file: "package.json", hunkIndex: 0 }]);
    expect(revisionKey("task-1", "abc", "run-1")).toBe("task-1:abc:run-1");
  });
});
