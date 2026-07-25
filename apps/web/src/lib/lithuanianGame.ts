import type { LithuanianWord } from "@email-client/shared";

/**
 * The rules of the practice game, kept apart from the screen that draws it.
 *
 * Everything here is a pure function of the learner's own words plus an injectable source of
 * randomness, so a round can be built and scored in a test without rendering anything or
 * depending on what Math.random happens to return.
 */

/** Lives a game starts with. Three is enough to survive a slip without ending the run. */
export const GAME_LIVES = 3;

/** Questions in a full round. */
export const GAME_ROUND_SIZE = 8;

/** How long each question is on the clock, in milliseconds. */
export const GAME_QUESTION_MS = 12_000;

/** Points a correct answer is worth before the clock and the combo are counted. */
export const GAME_BASE_POINTS = 100;

/** The most a combo can multiply a score by, so a long run cannot run away with it. */
export const GAME_MAX_MULTIPLIER = 5;

/** How many choices a multiple-choice question offers, the answer included. */
export const GAME_CHOICE_COUNT = 4;

export type GameQuestionKind = "meaning" | "word" | "spell";

export interface GameQuestion {
  wordId: string;
  kind: GameQuestionKind;
  /** What the learner is shown. */
  prompt: string;
  /** Whether the prompt is the English or the Lithuanian side. */
  promptIsLithuanian: boolean;
  /** The Lithuanian word this question is about, for saying it out loud. */
  lithuanian: string;
  answer: string;
  /** Empty for a question that is typed rather than picked. */
  choices: string[];
}

export type Random = () => number;

function shuffle<T>(items: readonly T[], random: Random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

/**
 * How well a typed answer matched: letter for letter, right but for the diacritics, or wrong.
 */
export type AnswerGrade = "exact" | "close" | "wrong";

/** Case, surrounding space and the two ways a browser can encode an accent, all settled. */
function tidy(value: string): string {
  return value.trim().toLocaleLowerCase("lt").normalize("NFC");
}

/** The same word with its accents taken off, so `kate` and `katė` compare as one. */
function bare(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * How close a typed answer is.
 *
 * Case and surrounding space are forgiven outright. A missing diacritic is forgiven too, and
 * counts as a right answer: an English keyboard has no ė on it, and losing a life to the keyboard
 * rather than to the word teaches nothing. It comes back as `close` rather than `exact` so the
 * game can show the spelling that was meant -- which is the part worth learning.
 */
export function gradeAnswer(typed: string, answer: string): AnswerGrade {
  const given = tidy(typed);
  const wanted = tidy(answer);
  if (given === wanted) return "exact";
  return bare(given) === bare(wanted) ? "close" : "wrong";
}

/**
 * What a correct answer is worth: the base, plus what is left on the clock, times the combo.
 *
 * `combo` is how many were already answered correctly in a row before this one, so the first
 * correct answer of a run scores flat and a streak is what pays.
 */
export function pointsFor(msLeft: number, combo: number): number {
  const remaining = Math.max(0, Math.min(msLeft, GAME_QUESTION_MS));
  const speed = Math.round(GAME_BASE_POINTS * (remaining / GAME_QUESTION_MS));
  const multiplier = Math.min(1 + combo, GAME_MAX_MULTIPLIER);
  return (GAME_BASE_POINTS + speed) * multiplier;
}

/** The multiplier a combo is currently worth, for showing on screen. */
export function multiplierFor(combo: number): number {
  return Math.min(1 + combo, GAME_MAX_MULTIPLIER);
}

/**
 * Builds one question about a word. Multiple choice needs enough other words to draw wrong
 * answers from; without them the question is typed instead, which needs nothing but the word
 * itself. That is what makes a game playable on the day the first word is added.
 */
function questionFor(
  word: LithuanianWord,
  others: readonly LithuanianWord[],
  random: Random
): GameQuestion {
  const wrongEnglish = others.filter((other) => other.english !== word.english);
  const wrongLithuanian = others.filter((other) => other.lithuanian !== word.lithuanian);
  const canPick = wrongEnglish.length >= GAME_CHOICE_COUNT - 1
    && wrongLithuanian.length >= GAME_CHOICE_COUNT - 1;
  const roll = random();
  const kind: GameQuestionKind = !canPick ? "spell" : roll < 0.4 ? "meaning" : roll < 0.8 ? "word" : "spell";

  if (kind === "spell") {
    return {
      wordId: word.id,
      kind,
      prompt: word.english,
      promptIsLithuanian: false,
      lithuanian: word.lithuanian,
      answer: word.lithuanian,
      choices: []
    };
  }

  const showsLithuanian = kind === "meaning";
  const answer = showsLithuanian ? word.english : word.lithuanian;
  const pool = showsLithuanian ? wrongEnglish : wrongLithuanian;
  const decoys = shuffle(pool, random)
    .map((other) => (showsLithuanian ? other.english : other.lithuanian))
    .filter((choice, index, all) => choice !== answer && all.indexOf(choice) === index)
    .slice(0, GAME_CHOICE_COUNT - 1);

  return {
    wordId: word.id,
    kind,
    prompt: showsLithuanian ? word.lithuanian : word.english,
    promptIsLithuanian: showsLithuanian,
    lithuanian: word.lithuanian,
    answer,
    choices: shuffle([answer, ...decoys], random)
  };
}

/**
 * A round drawn from the learner's own words. Shorter than a full round when he has not added
 * enough yet -- a game of three questions is better than no game at all.
 */
export function buildRound(
  words: readonly LithuanianWord[],
  size: number = GAME_ROUND_SIZE,
  random: Random = Math.random
): GameQuestion[] {
  const usable = words.filter((word) => word.lithuanian.trim() && word.english.trim());
  if (usable.length === 0) return [];
  return shuffle(usable, random)
    .slice(0, Math.max(1, size))
    .map((word) => questionFor(word, usable, random));
}
