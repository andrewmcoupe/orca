import { describe, expect, it } from "vitest";
import { shouldShowSinceLastReview } from "./proposal-section";

describe("proposal section review filtering", () => {
  it("shows all changes when the task has never been reviewed", () => {
    expect(shouldShowSinceLastReview(200, null)).toBe(true);
  });

  it("hides unchanged proposals after the last review timestamp", () => {
    expect(shouldShowSinceLastReview(200, 300)).toBe(false);
  });

  it("shows proposals recomputed after the last review timestamp", () => {
    expect(shouldShowSinceLastReview(400, 300)).toBe(true);
  });
});

