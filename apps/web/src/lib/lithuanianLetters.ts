import { LITHUANIAN_SPECIAL_LETTERS } from "@email-client/shared";

/**
 * The letters Lithuanian has and English does not, and what they sound like.
 *
 * Lucas reads English every day, so the part of a Lithuanian word he will get wrong is almost
 * always one of these -- and the accent is easy to drop when copying a word down. Marking them
 * makes the difference the visible part of the word rather than something to notice on his own.
 */

export interface LetterRun {
  text: string;
  /** What this letter sounds like, or null for letters English shares. */
  note: string | null;
}

function noteFor(letter: string): string | null {
  return LITHUANIAN_SPECIAL_LETTERS[letter.toLowerCase()] ?? null;
}

/**
 * Splits text into runs so the Lithuanian-only letters can be marked one by one. Ordinary letters
 * are merged into as few runs as possible, so a word is a handful of nodes rather than one per
 * character.
 */
export function spellOut(text: string): LetterRun[] {
  const runs: LetterRun[] = [];
  for (const letter of text) {
    const note = noteFor(letter);
    const previous = runs[runs.length - 1];
    if (note === null && previous && previous.note === null) previous.text += letter;
    else runs.push({ text: letter, note });
  }
  return runs;
}

/**
 * The distinct Lithuanian-only letters in a word, in the order they appear. Shown as a short list
 * under the word: a tooltip is no use on the tablet this is mostly read on.
 */
export function specialLetters(text: string): LetterRun[] {
  const seen = new Set<string>();
  const found: LetterRun[] = [];
  for (const letter of text) {
    const lower = letter.toLowerCase();
    const note = noteFor(lower);
    if (note === null || seen.has(lower)) continue;
    seen.add(lower);
    found.push({ text: lower, note });
  }
  return found;
}
