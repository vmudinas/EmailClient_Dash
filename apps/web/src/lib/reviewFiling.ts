export interface ReviewProcessedMessagesResult {
  processedMessageIds: string[];
  reviewedMessageIds: string[];
  failedMessageIds: string[];
}

export const BULK_MOVE_BATCH_SIZE = 500;

export function bulkMoveBatches<T>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += BULK_MOVE_BATCH_SIZE) {
    batches.push(items.slice(offset, offset + BULK_MOVE_BATCH_SIZE));
  }
  return batches;
}

export async function reviewProcessedMessages(
  processedMessageIds: string[],
  markReviewed: (messageId: string) => Promise<unknown>
): Promise<ReviewProcessedMessagesResult> {
  const uniqueIds = [...new Set(processedMessageIds)];
  const settled = await Promise.allSettled(uniqueIds.map(async (messageId) => {
    await markReviewed(messageId);
    return messageId;
  }));
  const reviewedMessageIds: string[] = [];
  const failedMessageIds: string[] = [];
  settled.forEach((result, index) => {
    const messageId = uniqueIds[index]!;
    if (result.status === "fulfilled") reviewedMessageIds.push(messageId);
    else failedMessageIds.push(messageId);
  });
  return { processedMessageIds: uniqueIds, reviewedMessageIds, failedMessageIds };
}
