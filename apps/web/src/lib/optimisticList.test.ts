import { describe, expect, it } from "vitest";
import { removeByMessageId, restoreRemoved } from "./optimisticList.js";

interface Row {
  message: { id: string };
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ message: { id } }));
const ids = (items: readonly Row[]): string[] => items.map((item) => item.message.id);

describe("removeByMessageId", () => {
  it("takes out the named rows and keeps the rest in order", () => {
    const { remaining, removed } = removeByMessageId(rows("a", "b", "c", "d"), ["b", "d"]);
    expect(ids(remaining)).toEqual(["a", "c"]);
    expect(removed.map((entry) => entry.item.message.id)).toEqual(["b", "d"]);
  });

  it("records the position each row came from, not its position after earlier removals", () => {
    const { removed } = removeByMessageId(rows("a", "b", "c", "d"), ["b", "d"]);
    expect(removed.map((entry) => entry.index)).toEqual([1, 3]);
  });

  it("ignores ids that are not in the list", () => {
    const { remaining, removed } = removeByMessageId(rows("a", "b"), ["z"]);
    expect(ids(remaining)).toEqual(["a", "b"]);
    expect(removed).toEqual([]);
  });

  it("does not mutate the list it was given", () => {
    const original = rows("a", "b");
    removeByMessageId(original, ["a"]);
    expect(ids(original)).toEqual(["a", "b"]);
  });
});

describe("restoreRemoved", () => {
  it("puts a single row back where it was", () => {
    const { remaining, removed } = removeByMessageId(rows("a", "b", "c"), ["b"]);
    expect(ids(restoreRemoved(remaining, removed))).toEqual(["a", "b", "c"]);
  });

  it("restores several rows in their original order", () => {
    const { remaining, removed } = removeByMessageId(rows("a", "b", "c", "d", "e"), ["b", "d"]);
    expect(ids(restoreRemoved(remaining, removed))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("restores correctly when the removed rows were adjacent", () => {
    const { remaining, removed } = removeByMessageId(rows("a", "b", "c", "d"), ["b", "c"]);
    expect(ids(restoreRemoved(remaining, removed))).toEqual(["a", "b", "c", "d"]);
  });

  it("restores rows taken from the very start and end", () => {
    const { remaining, removed } = removeByMessageId(rows("a", "b", "c"), ["a", "c"]);
    expect(ids(restoreRemoved(remaining, removed))).toEqual(["a", "b", "c"]);
  });

  it("round-trips a list where every row was removed", () => {
    const { remaining, removed } = removeByMessageId(rows("a", "b", "c"), ["a", "b", "c"]);
    expect(ids(restoreRemoved(remaining, removed))).toEqual(["a", "b", "c"]);
  });

  it("skips a row a background refresh already brought back, rather than duplicating it", () => {
    const { removed } = removeByMessageId(rows("a", "b", "c"), ["b"]);
    const refreshed = rows("a", "b", "c");
    expect(ids(restoreRemoved(refreshed, removed))).toEqual(["a", "b", "c"]);
  });

  it("appends rather than throwing when the list shrank below the original index", () => {
    const { removed } = removeByMessageId(rows("a", "b", "c", "d"), ["d"]);
    expect(ids(restoreRemoved(rows("a"), removed))).toEqual(["a", "d"]);
  });

  it("does not mutate the list it was given", () => {
    const { removed } = removeByMessageId(rows("a", "b"), ["b"]);
    const current = rows("a");
    restoreRemoved(current, removed);
    expect(ids(current)).toEqual(["a"]);
  });
});
