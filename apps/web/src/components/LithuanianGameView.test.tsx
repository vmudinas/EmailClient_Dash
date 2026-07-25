import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LithuanianWord } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { LithuanianGameView } from "./LithuanianGameView.js";
import { GAME_QUESTION_MS } from "../lib/lithuanianGame.js";

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

const ONE = [word("1", "ačiū", "thanks")];

function client(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    saveLithuanianGame: vi.fn().mockResolvedValue({ score: 0, bestScore: 0, record: false }),
    ...overrides
  } as unknown as ApiClient;
}

/** Lets the verdict pause and any pending save settle. */
async function settle(ms = 1_000) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // One word means every question is typed, which keeps a round deterministic.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: class { lang = ""; rate = 1; voice: unknown = null; constructor(readonly text: string) {} }
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => [{ lang: "lt-LT", name: "Lietuvių" }],
      speak: vi.fn(),
      cancel: vi.fn(),
      addEventListener: () => {},
      removeEventListener: () => {}
    }
  });
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  URL.createObjectURL = vi.fn(() => "blob:said");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe("LithuanianGameView", () => {
  it("scores a correct answer and ends the round", async () => {
    const saveLithuanianGame = vi.fn().mockResolvedValue({ score: 200, bestScore: 200, record: true });
    render(
      <LithuanianGameView
        api={client({ saveLithuanianGame })}
        words={ONE}
        bestScore={0}
        onFinished={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("thanks")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Spell it in Lithuanian"), { target: { value: "ačiū" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(screen.getByRole("status").textContent).toContain("Correct");
    await settle();

    // The only word was the only question, so the round is over.
    expect(saveLithuanianGame).toHaveBeenCalledTimes(1);
    expect(screen.getByText("New best score!")).toBeTruthy();
  });

  it("does not accept a word spelled without its diacritics", async () => {
    render(
      <LithuanianGameView
        api={client()}
        words={ONE}
        bestScore={0}
        onFinished={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Spell it in Lithuanian"), { target: { value: "aciu" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    // The diacritics are the spelling the game is there to teach, so they are not forgiven.
    expect(screen.getByRole("status").textContent).toContain("It was ačiū");
  });

  it("takes a life when the clock runs out, without waiting for an answer", async () => {
    render(
      <LithuanianGameView
        api={client()}
        words={ONE}
        bestScore={0}
        onFinished={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByLabelText("3 lives left")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(GAME_QUESTION_MS + 200);
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toContain("It was ačiū");
  });

  it("reports the new best to the screen behind it", async () => {
    const onFinished = vi.fn();
    render(
      <LithuanianGameView
        api={client({
          saveLithuanianGame: vi.fn().mockResolvedValue({ score: 150, bestScore: 900, record: false })
        })}
        words={ONE}
        bestScore={900}
        onFinished={onFinished}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Spell it in Lithuanian"), { target: { value: "ačiū" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await settle();

    expect(onFinished).toHaveBeenCalledWith(900);
    expect(screen.getByText("Best 900")).toBeTruthy();
  });

  it("still shows the score when it could not be saved", async () => {
    render(
      <LithuanianGameView
        api={client({ saveLithuanianGame: vi.fn().mockRejectedValue(new Error("offline")) })}
        words={ONE}
        bestScore={0}
        onFinished={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Spell it in Lithuanian"), { target: { value: "ačiū" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await settle();

    // It is a game, not a record to defend: a failed save costs the high score, not the result.
    expect(screen.getByText("Game over")).toBeTruthy();
  });

  it("plays the server's recording rather than the device voice", async () => {
    // 0.1 rolls a "what does this mean?" question, which is the one with a Listen button.
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    // Every word is cached, so the assertion does not depend on which one is drawn first.
    const spoken = [
      ONE[0]!,
      word("2", "labas", "hello"),
      word("3", "rytas", "morning"),
      word("4", "duona", "bread"),
      word("5", "katė", "cat")
    ].map((entry) => ({ ...entry, hasPronunciation: true }));
    const lithuanianPronunciationBlob = vi.fn()
      .mockResolvedValue(new Blob(["said"], { type: "audio/mpeg" }));
    render(
      <LithuanianGameView
        api={client({ lithuanianPronunciationBlob })}
        words={spoken}
        bestScore={0}
        onFinished={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const listen = screen.getAllByRole("button", { name: /^Listen to / })[0]!;
    await act(async () => {
      fireEvent.click(listen);
      await Promise.resolve();
    });

    // Falling back to synthesis here would put back the wrong-language pronunciation the cached
    // audio exists to avoid.
    expect(lithuanianPronunciationBlob).toHaveBeenCalled();
    expect(speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("uses the device voice for a word the server has not said", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const lithuanianPronunciationBlob = vi.fn();
    render(
      <LithuanianGameView
        api={client({ lithuanianPronunciationBlob })}
        words={[
          ONE[0]!,
          word("2", "labas", "hello"),
          word("3", "rytas", "morning"),
          word("4", "duona", "bread"),
          word("5", "katė", "cat")
        ]}
        bestScore={0}
        onFinished={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Listen to / })[0]!);
      await Promise.resolve();
    });

    expect(lithuanianPronunciationBlob).not.toHaveBeenCalled();
    expect(speechSynthesis.speak).toHaveBeenCalled();
  });

  it("says there is nothing to play with before any word is added", () => {
    const onClose = vi.fn();
    render(
      <LithuanianGameView
        api={client()}
        words={[]}
        bestScore={0}
        onFinished={vi.fn()}
        onClose={onClose}
      />
    );

    expect(screen.getByText("Nothing to play with yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the words" }));
    expect(onClose).toHaveBeenCalled();
  });
});
