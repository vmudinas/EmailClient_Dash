import { describe, expect, it, vi } from "vitest";
import { reviewProcessedMessages } from "./reviewFiling.js";

describe("reviewProcessedMessages", () => {
  it("marks only IDs confirmed as processed and preserves review failures", async () => {
    const markReviewed = vi.fn(async (messageId: string) => {
      if (messageId === "moved-2") throw new Error("review failed");
    });

    const result = await reviewProcessedMessages(["moved-1", "moved-2", "moved-1"], markReviewed);

    expect(markReviewed.mock.calls).toEqual([["moved-1"], ["moved-2"]]);
    expect(result).toEqual({
      processedMessageIds: ["moved-1", "moved-2"],
      reviewedMessageIds: ["moved-1"],
      failedMessageIds: ["moved-2"]
    });
  });
});
