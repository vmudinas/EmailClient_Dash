import { LITHUANIAN_DAILY_WORD_GOAL, type LithuanianWord } from "@email-client/shared";

/**
 * The daily-word goal, measured in the learner's own days.
 *
 * Deliberately computed in the browser rather than on the server: "today" has to mean the day it
 * is where Lucas is sitting, and the stored timestamps are UTC. At 01:00 in Vilnius a UTC day
 * boundary would call yesterday's word today's.
 */
export interface PracticeStatus {
  /** Words added during the local day. */
  addedToday: number;
  /** Still owed today. */
  dueToday: boolean;
  /** Consecutive days ending today, or ending yesterday while today is still open. */
  streakDays: number;
  /** Local day key of the most recent word, or null when there are none. */
  lastAddedDay: string | null;
}

/** Local YYYY-MM-DD, which is what "a day" means here -- never the UTC date. */
export function localDayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shiftDays(day: string, offset: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return localDayKey(new Date(year!, month! - 1, date! + offset));
}

export function practiceStatus(words: LithuanianWord[], now = new Date()): PracticeStatus {
  const today = localDayKey(now);
  const days = new Set<string>();
  for (const word of words) {
    const key = localDayKey(word.createdAt);
    if (key) days.add(key);
  }

  const addedToday = words.filter((word) => localDayKey(word.createdAt) === today).length;
  // The streak survives until the day is over: an untouched today does not break a run that was
  // still alive yesterday, it just leaves a word owed.
  let cursor = days.has(today) ? today : shiftDays(today, -1);
  let streakDays = 0;
  while (days.has(cursor)) {
    streakDays += 1;
    cursor = shiftDays(cursor, -1);
  }

  const lastAddedDay = [...days].sort().pop() ?? null;
  return {
    addedToday,
    dueToday: addedToday < LITHUANIAN_DAILY_WORD_GOAL,
    streakDays,
    lastAddedDay
  };
}

/** Whole local days since a word was last added, or null when none has been. */
export function daysSince(lastAddedDay: string | null, now = new Date()): number | null {
  if (!lastAddedDay) return null;
  const [year, month, day] = lastAddedDay.split("-").map(Number);
  const last = new Date(year!, month! - 1, day!);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today.getTime() - last.getTime()) / 86_400_000));
}
