import { describe, expect, it } from "vitest";
import {
  BUILT_IN_INTERVALS,
  formatInterval,
  formatSince,
  resolveIntervalMs,
  type PollingLoopConfig
} from "./polling";

function config(overrides: Partial<PollingLoopConfig> = {}): PollingLoopConfig {
  return {
    key: "importJobs",
    label: "Import progress",
    description: "",
    enabled: true,
    intervalMs: 15_000,
    defaultIntervalMs: 15_000,
    activeIntervalMs: 1_500,
    defaultActiveIntervalMs: 1_500,
    activeLabel: "While importing",
    customized: false,
    ...overrides
  };
}

describe("resolveIntervalMs", () => {
  it("uses the configured idle interval when nothing is busy", () => {
    expect(resolveIntervalMs(config(), "importJobs", false)).toBe(15_000);
  });

  it("switches to the busy interval for loops that declare one", () => {
    expect(resolveIntervalMs(config(), "importJobs", true)).toBe(1_500);
  });

  it("ignores the busy flag for loops without a busy rate", () => {
    const reviewQueue = config({ key: "reviewQueue", intervalMs: 30_000, activeIntervalMs: null });
    expect(resolveIntervalMs(reviewQueue, "reviewQueue", true)).toBe(30_000);
  });

  it("falls back to the loop's own built-in interval when settings are missing", () => {
    // Regression guard: an earlier version fell back to the global 1s minimum, which would
    // have turned every loop into a one-second poll for any non-admin session.
    expect(resolveIntervalMs(undefined, "reviewQueue", false)).toBe(30_000);
    expect(resolveIntervalMs(undefined, "newsHeadlines", false)).toBe(600_000);
    expect(resolveIntervalMs(undefined, "importJobs", true)).toBe(1_500);
  });

  it("never falls back to something faster than a second for an unknown loop", () => {
    expect(resolveIntervalMs(undefined, "somethingNew", false)).toBeGreaterThanOrEqual(1_000);
  });

  it("keeps built-in intervals in step with the loops the app registers", () => {
    expect(Object.keys(BUILT_IN_INTERVALS).sort()).toEqual([
      "gmailConnections",
      "importJobs",
      "newsHeadlines",
      "reviewQueue",
      "stockQuotes"
    ]);
  });
});

describe("formatInterval", () => {
  it("renders sub-second, second and minute scales", () => {
    expect(formatInterval(500)).toBe("500 ms");
    expect(formatInterval(1_500)).toBe("1.5s");
    expect(formatInterval(30_000)).toBe("30s");
    expect(formatInterval(600_000)).toBe("10 min");
  });

  it("renders a dash when there is no interval in effect", () => {
    expect(formatInterval(null)).toBe("—");
  });
});

describe("formatSince", () => {
  const now = 1_000_000_000;

  it("describes recent and older runs", () => {
    expect(formatSince(null, now)).toBe("never");
    expect(formatSince(now - 400, now)).toBe("just now");
    expect(formatSince(now - 5_000, now)).toBe("5s ago");
    expect(formatSince(now - 120_000, now)).toBe("2 min ago");
    expect(formatSince(now - 7_200_000, now)).toBe("2 hr ago");
  });

  it("does not render negative ages from clock skew", () => {
    expect(formatSince(now + 5_000, now)).toBe("just now");
  });
});
