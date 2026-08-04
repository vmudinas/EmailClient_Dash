export interface ReviewProcessedMessagesResult {
  processedMessageIds: string[];
  reviewedMessageIds: string[];
  failedMessageIds: string[];
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
