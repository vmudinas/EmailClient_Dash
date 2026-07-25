import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PERSISTENCE_VERSION,
  clearPersistedScope,
  persistenceKey,
  pruneForeignPersistence,
  readPersisted,
  removePersisted,
  writePersisted
} from "./persistentState";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("persisted values", () => {
  it("round-trips a value", () => {
    writePersisted("folders", ["a", "b"]);
    expect(readPersisted<string[]>("folders")).toEqual(["a", "b"]);
  });

  it("returns null for a key that was never written", () => {
    expect(readPersisted("missing")).toBeNull();
  });

  it("keeps scopes apart so one account cannot read another's state", () => {
    writePersisted("lastLocation", { archiveId: "alice" }, { scope: "user-1" });
    writePersisted("lastLocation", { archiveId: "bob" }, { scope: "user-2" });

    expect(readPersisted("lastLocation", { scope: "user-1" })).toEqual({ archiveId: "alice" });
    expect(readPersisted("lastLocation", { scope: "user-2" })).toEqual({ archiveId: "bob" });
    // An unscoped read must not fall through to somebody's scoped entry.
    expect(readPersisted("lastLocation")).toBeNull();
  });

  it("ignores an entry written by a superseded version", () => {
    // Simulates a deploy that changed the stored shape: parsing it could crash the app, so a
    // version mismatch is treated as absent.
    window.localStorage.setItem(
      persistenceKey("folders"),
      JSON.stringify({ version: PERSISTENCE_VERSION - 1, savedAt: Date.now(), value: ["stale"] })
    );
    expect(readPersisted("folders")).toBeNull();
  });

  it("discards an entry past its maximum age and removes it", () => {
    window.localStorage.setItem(
      persistenceKey("lastLocation"),
      JSON.stringify({ version: PERSISTENCE_VERSION, savedAt: Date.now() - 10_000, value: { archiveId: "old" } })
    );
    expect(readPersisted("lastLocation", { maxAgeMs: 1_000 })).toBeNull();
    expect(window.localStorage.getItem(persistenceKey("lastLocation"))).toBeNull();
  });

  it("keeps an entry that is still inside its maximum age", () => {
    writePersisted("lastLocation", { archiveId: "fresh" });
    expect(readPersisted("lastLocation", { maxAgeMs: 60_000 })).toEqual({ archiveId: "fresh" });
  });

  it("drops a corrupt entry instead of throwing", () => {
    // A hand-edited or truncated entry must not break every subsequent page load.
    window.localStorage.setItem(persistenceKey("folders"), "{not json");
    expect(readPersisted("folders")).toBeNull();
    expect(window.localStorage.getItem(persistenceKey("folders"))).toBeNull();
  });

  it("reports failure rather than throwing when a value will not serialise", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(writePersisted("cyclic", cyclic)).toBe(false);
  });

  it("removes a single key without touching its neighbours", () => {
    writePersisted("a", 1);
    writePersisted("b", 2);
    removePersisted("a");
    expect(readPersisted("a")).toBeNull();
    expect(readPersisted<number>("b")).toBe(2);
  });
});

describe("clearPersistedScope", () => {
  it("drops only the given scope", () => {
    writePersisted("lastLocation", { archiveId: "alice" }, { scope: "user-1" });
    writePersisted("lastLocation", { archiveId: "bob" }, { scope: "user-2" });

    clearPersistedScope("user-1");

    expect(readPersisted("lastLocation", { scope: "user-1" })).toBeNull();
    expect(readPersisted("lastLocation", { scope: "user-2" })).toEqual({ archiveId: "bob" });
  });

  it("leaves unrelated application keys alone", () => {
    window.localStorage.setItem("some-other-app", "keep me");
    writePersisted("folders", ["a"], { scope: "user-1" });
    clearPersistedScope("user-1");
    expect(window.localStorage.getItem("some-other-app")).toBe("keep me");
  });
});

describe("pruneForeignPersistence", () => {
  it("removes other scopes and older versions but keeps the active scope", () => {
    writePersisted("lastLocation", { archiveId: "alice" }, { scope: "user-1" });
    writePersisted("lastLocation", { archiveId: "bob" }, { scope: "user-2" });
    window.localStorage.setItem(
      `archive-mail:v${PERSISTENCE_VERSION - 1}:user-1:lastLocation`,
      JSON.stringify({ version: PERSISTENCE_VERSION - 1, savedAt: Date.now(), value: {} })
    );
    window.localStorage.setItem("unrelated", "keep");

    const removed = pruneForeignPersistence("user-1");

    expect(removed).toBe(2);
    expect(readPersisted("lastLocation", { scope: "user-1" })).toEqual({ archiveId: "alice" });
    expect(readPersisted("lastLocation", { scope: "user-2" })).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });
});
