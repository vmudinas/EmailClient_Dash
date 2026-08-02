/**
 * List edits applied before the server has answered.
 *
 * Moving or deleting mail is a round trip, and waiting for it leaves the row the user just
 * acted on sitting there looking ignored. These helpers take the row out immediately and keep
 * enough to put it back at its original position when the server refuses, so an optimistic
 * update never leaves the list claiming something that did not happen.
 */

/** A row that was taken out, with the position it needs to go back to. */
export interface RemovedEntry<T> {
  index: number;
  item: T;
}

export interface RemovalResult<T> {
  remaining: T[];
  removed: RemovedEntry<T>[];
}

type HasMessageId = { message: { id: string } };

/**
 * Splits the list into what stays on screen and what was taken out. Indices refer to positions
 * in the original list, which is what makes an ordered restore possible.
 */
export function removeByMessageId<T extends HasMessageId>(
  items: readonly T[],
  messageIds: readonly string[]
): RemovalResult<T> {
  const ids = new Set(messageIds);
  const remaining: T[] = [];
  const removed: RemovedEntry<T>[] = [];
  items.forEach((item, index) => {
    if (ids.has(item.message.id)) removed.push({ index, item });
    else remaining.push(item);
  });
  return { remaining, removed };
}

/**
 * Puts removed rows back. Restores in ascending index order so that each earlier row is in
 * place before a later one is positioned against it, which is what keeps a multi-row restore
 * in its original order rather than reversing it.
 *
 * A row already present is skipped: a background refresh may have returned it while the failed
 * request was still in flight, and re-inserting would show it twice.
 */
export function restoreRemoved<T extends HasMessageId>(
  current: readonly T[],
  removed: readonly RemovedEntry<T>[]
): T[] {
  const restored = [...current];
  const present = new Set(restored.map((item) => item.message.id));
  for (const { index, item } of [...removed].sort((a, b) => a.index - b.index)) {
    if (present.has(item.message.id)) continue;
    restored.splice(Math.min(index, restored.length), 0, item);
    present.add(item.message.id);
  }
  return restored;
}
