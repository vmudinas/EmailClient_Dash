import { describe, expect, it, vi } from "vitest";
import { BULK_MOVE_BATCH_SIZE, bulkMoveBatches, reviewProcessedMessages } from "./reviewFiling.js";

describe("reviewProcessedMessages", () => {
  it("batches every duplicate copy within the API bulk-move limit", () => {
    const ids = Array.from({ length: BULK_MOVE_BATCH_SIZE * 2 + 1 }, (_, index) => `message-${index}`);

    const batches = bulkMoveBatches(ids);

    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 1]);
    expect(batches.flat()).toEqual(ids);
  });

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
