import { describe, expect, it } from "vitest";
import type { LithuanianWord } from "@email-client/shared";
import {
  GAME_BASE_POINTS,
  GAME_CHOICE_COUNT,
  GAME_MAX_MULTIPLIER,
  GAME_QUESTION_MS,
  answerMatches,
  buildRound,
  multiplierFor,
  pointsFor
} from "./lithuanianGame.js";

function word(id: string, lithuanian: string, english: string): LithuanianWord {
  return {
    id,
    lithuanian,
    english,
    kind: "word",
    createdAt: "2026-07-25T10:00:00.000Z",
    hints: [],
    hasPronunciation: false,
    recordings: []
  };
}

const SIX = [
  word("1", "labas", "hello"),
  word("2", "ačiū", "thanks"),
  word("3", "rytas", "morning"),
  word("4", "vanduo", "water"),
  word("5", "duona", "bread"),
  word("6", "katė", "cat")
];

/** Fixed rolls, so a round is the same every run. */
function rolls(values: number[]) {
  let index = 0;
  return () => values[index++ % values.length]!;
}

describe("answerMatches", () => {
  it("forgives case and surrounding space", () => {
    expect(answerMatches("  Ačiū ", "ačiū")).toBe(true);
  });

  it("does not forgive a missing diacritic, which is the spelling being taught", () => {
    expect(answerMatches("aciu", "ačiū")).toBe(false);
    expect(answerMatches("aciū", "ačiū")).toBe(false);
  });
});

describe("pointsFor", () => {
  it("pays the base plus what is left on the clock", () => {
    expect(pointsFor(GAME_QUESTION_MS, 0)).toBe(GAME_BASE_POINTS * 2);
    expect(pointsFor(0, 0)).toBe(GAME_BASE_POINTS);
  });

  it("multiplies by the combo already running", () => {
    expect(pointsFor(0, 2)).toBe(GAME_BASE_POINTS * 3);
  });

  it("caps the multiplier so a long run cannot run away with it", () => {
    expect(multiplierFor(99)).toBe(GAME_MAX_MULTIPLIER);
    expect(pointsFor(0, 99)).toBe(GAME_BASE_POINTS * GAME_MAX_MULTIPLIER);
  });

  it("treats an overrun clock as no time left rather than negative points", () => {
    expect(pointsFor(-5_000, 0)).toBe(GAME_BASE_POINTS);
  });
});

describe("buildRound", () => {
  it("asks about the learner's own words and no others", () => {
    const round = buildRound(SIX, 4, rolls([0.1, 0.5, 0.9]));
    expect(round).toHaveLength(4);
    for (const question of round) {
      expect(SIX.some((entry) => entry.id === question.wordId)).toBe(true);
    }
  });

  it("offers the answer among the choices, without repeats", () => {
    const round = buildRound(SIX, 6, rolls([0.1, 0.3, 0.7, 0.2, 0.5]));
    const picked = round.filter((question) => question.kind !== "spell");
    expect(picked.length).toBeGreaterThan(0);
    for (const question of picked) {
      expect(question.choices).toContain(question.answer);
      expect(question.choices).toHaveLength(GAME_CHOICE_COUNT);
      expect(new Set(question.choices).size).toBe(question.choices.length);
    }
  });

  it("falls back to typing when there are too few words for a choice", () => {
    const round = buildRound([word("1", "labas", "hello")], 4, rolls([0.5]));
    expect(round).toHaveLength(1);
    expect(round[0]!.kind).toBe("spell");
    expect(round[0]!.choices).toEqual([]);
    // A game on the day the first word is added is still a game.
    expect(round[0]!.answer).toBe("labas");
  });

  it("is shorter than a full round rather than repeating a word to fill one", () => {
    const round = buildRound(SIX.slice(0, 3), 8, rolls([0.4]));
    expect(round).toHaveLength(3);
    expect(new Set(round.map((question) => question.wordId)).size).toBe(3);
  });

  it("has nothing to ask when nothing has been added", () => {
    expect(buildRound([], 8, rolls([0.5]))).toEqual([]);
  });

  it("skips a half-written entry rather than asking an unanswerable question", () => {
    expect(buildRound([word("1", "  ", "hello")], 4, rolls([0.5]))).toEqual([]);
  });
});
