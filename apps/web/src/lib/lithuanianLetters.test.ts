import { describe, expect, it } from "vitest";
import { spellOut, specialLetters } from "./lithuanianLetters.js";

describe("spellOut", () => {
  it("marks only the letters English does not have", () => {
    expect(spellOut("ačiū")).toEqual([
      { text: "a", note: null },
      { text: "č", note: expect.stringContaining("ch") },
      { text: "i", note: null },
      { text: "ū", note: expect.stringContaining("oo") }
    ]);
  });

  it("keeps ordinary letters together rather than one node each", () => {
    expect(spellOut("labas")).toEqual([{ text: "labas", note: null }]);
  });

  it("marks a capitalised letter the same as a lowercase one", () => {
    const [first] = spellOut("Ūsas");
    expect(first).toEqual({ text: "Ū", note: expect.stringContaining("oo") });
  });

  it("leaves a word with no special letters alone", () => {
    expect(spellOut("rytas").every((run) => run.note === null)).toBe(true);
  });
});

describe("specialLetters", () => {
  it("lists each special letter once, in the order it appears", () => {
    expect(specialLetters("šešėlis").map((letter) => letter.text)).toEqual(["š", "ė"]);
  });

  it("says nothing about a word English could spell", () => {
    expect(specialLetters("labas rytas")).toEqual([]);
  });

  it("folds a capital onto the same letter", () => {
    expect(specialLetters("Šešios").map((letter) => letter.text)).toEqual(["š"]);
  });
});
