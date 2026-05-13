import { describe, expect, it } from "vitest";
import {
  deriveTaskReviewState,
  displayTaskStatus,
  TASK_REVIEW_STATE_LABELS,
} from "./task-domain";

const baseTask = {
  status: "draft",
  worktree_status: "active",
  worktree_init_status: null,
  catch_up_state: "none",
};

describe("task domain vocabulary", () => {
  it("translates persisted task statuses into review language", () => {
    expect(displayTaskStatus("merged")).toBe("Landed");
    expect(displayTaskStatus("awaiting_review")).toBe("Under review");
    expect(displayTaskStatus("cancelled")).toBe("Rejected");
  });

  it("promotes approved active tasks to ready-to-land", () => {
    expect(
      deriveTaskReviewState({
        task: { ...baseTask, status: "approved" },
      }),
    ).toBe("ready_to_land");
    expect(TASK_REVIEW_STATE_LABELS.ready_to_land).toBe("Ready to land");
  });

  it("keeps approved tasks approved when task files are unavailable", () => {
    expect(
      deriveTaskReviewState({
        task: {
          ...baseTask,
          status: "approved",
          worktree_status: "removed",
        },
      }),
    ).toBe("approved");
  });

  it("uses auditor activity and verdict completion as under-review signals", () => {
    expect(
      deriveTaskReviewState({
        task: baseTask,
        activeRun: { phase: "auditor", status: "running" },
      }),
    ).toBe("under_review");

    expect(
      deriveTaskReviewState({
        task: baseTask,
        latestRun: { phase: "auditor", status: "completed" },
      }),
    ).toBe("under_review");
  });

  it("maps terminal task states without leaking old git vocabulary", () => {
    expect(
      deriveTaskReviewState({
        task: { ...baseTask, status: "merged" },
      }),
    ).toBe("landed");
    expect(
      deriveTaskReviewState({
        task: { ...baseTask, status: "cancelled" },
      }),
    ).toBe("rejected");
  });

  it("uses catch-up vocabulary when an approved proposal is stale", () => {
    expect(
      deriveTaskReviewState({
        task: { ...baseTask, status: "approved", catch_up_state: "clean" },
      }),
    ).toBe("needs_catch_up");
    expect(TASK_REVIEW_STATE_LABELS.needs_catch_up).toBe("Needs catch-up");
  });

  it("uses collisions vocabulary when catch-up cannot proceed cleanly", () => {
    expect(
      deriveTaskReviewState({
        task: { ...baseTask, status: "approved", catch_up_state: "colliding" },
      }),
    ).toBe("has_collisions");
    expect(TASK_REVIEW_STATE_LABELS.has_collisions).toBe("Has collisions");
  });
});
