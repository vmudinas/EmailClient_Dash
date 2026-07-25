import { describe, expect, it } from "vitest";
import type { LithuanianWord } from "@email-client/shared";
import { daysSince, localDayKey, practiceStatus } from "./practiceDays.js";

/** Local midday, so a timezone offset can never push the fixture onto a neighbouring day. */
function localNoon(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 12, 0, 0);
}

function word(created: Date, id = created.toISOString()): LithuanianWord {
  return { id, lithuanian: "labas", english: "hello", createdAt: created.toISOString(), recordings: [] };
}

const TODAY = localNoon(2026, 7, 25);

describe("practiceStatus", () => {
  it("owes a word when none was added today", () => {
    const status = practiceStatus([word(localNoon(2026, 7, 24))], TODAY);

    expect(status.addedToday).toBe(0);
    expect(status.dueToday).toBe(true);
  });

  it("counts the goal as met once today has a word", () => {
    const status = practiceStatus([word(localNoon(2026, 7, 25))], TODAY);

    expect(status.addedToday).toBe(1);
    expect(status.dueToday).toBe(false);
  });

  it("counts consecutive days ending today", () => {
    const status = practiceStatus([
      word(localNoon(2026, 7, 25)),
      word(localNoon(2026, 7, 24)),
      word(localNoon(2026, 7, 23))
    ], TODAY);

    expect(status.streakDays).toBe(3);
  });

  it("keeps yesterday's streak alive while today is still open", () => {
    // A word is owed, but the run is not broken until the day actually ends -- otherwise the
    // screen would report a lost streak every morning.
    const status = practiceStatus([
      word(localNoon(2026, 7, 24)),
      word(localNoon(2026, 7, 23))
    ], TODAY);

    expect(status.dueToday).toBe(true);
    expect(status.streakDays).toBe(2);
  });

  it("breaks the streak after a missed day", () => {
    const status = practiceStatus([
      word(localNoon(2026, 7, 23)),
      word(localNoon(2026, 7, 22))
    ], TODAY);

    expect(status.streakDays).toBe(0);
  });

  it("counts several words on one day as a single streak day", () => {
    const status = practiceStatus([
      word(localNoon(2026, 7, 25), "a"),
      word(localNoon(2026, 7, 25), "b"),
      word(localNoon(2026, 7, 24), "c")
    ], TODAY);

    expect(status.addedToday).toBe(2);
    expect(status.streakDays).toBe(2);
  });

  it("survives a month boundary", () => {
    const status = practiceStatus([
      word(localNoon(2026, 8, 1)),
      word(localNoon(2026, 7, 31))
    ], localNoon(2026, 8, 1));

    expect(status.streakDays).toBe(2);
  });

  it("reports an empty list as due with no streak", () => {
    const status = practiceStatus([], TODAY);

    expect(status).toEqual({ addedToday: 0, dueToday: true, streakDays: 0, lastAddedDay: null });
  });
});

describe("localDayKey", () => {
  it("uses the local date rather than the UTC one", () => {
    // 23:30 local on the 25th is the 25th here, whatever it is in UTC.
    const late = new Date(2026, 6, 25, 23, 30, 0);

    expect(localDayKey(late)).toBe("2026-07-25");
  });

  it("returns an empty key for an unparseable date", () => {
    expect(localDayKey("not-a-date")).toBe("");
  });
});

describe("daysSince", () => {
  it("counts whole days back to the last word", () => {
    expect(daysSince("2026-07-20", TODAY)).toBe(5);
    expect(daysSince("2026-07-25", TODAY)).toBe(0);
    expect(daysSince(null, TODAY)).toBeNull();
  });

  it("is not thrown off by a daylight-saving shift", () => {
    // Europe/Vilnius springs forward on 2026-03-29; the gap is still 2 days, not 1.96.
    expect(daysSince("2026-03-28", localNoon(2026, 3, 30))).toBe(2);
  });
});
