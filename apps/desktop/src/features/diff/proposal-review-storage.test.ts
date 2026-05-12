import { describe, expect, it } from "vitest";
import { proposalReviewStorageKey } from "./proposal-review-storage";

describe("proposal review storage", () => {
  it("keys review timestamps by user and task", () => {
    expect(proposalReviewStorageKey("local", "task-1")).toBe(
      "orca:last-reviewed:local:task-1",
    );
  });
});

