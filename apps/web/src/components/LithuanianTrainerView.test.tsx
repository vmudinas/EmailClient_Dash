import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LithuanianWord } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { LithuanianTrainerView } from "./LithuanianTrainerView.js";

function word(overrides: Partial<LithuanianWord> = {}): LithuanianWord {
  return {
    id: "word-1",
    lithuanian: "labas",
    english: "hello",
    kind: "word",
    createdAt: new Date().toISOString(),
    hints: [],
    // Most tests exercise the device-voice path; the server-audio tests opt in explicitly.
    hasPronunciation: false,
    recordings: [
      {
        id: "take-1",
        wordId: "word-1",
        contentType: "audio/webm",
        sizeBytes: 4_096,
        durationMs: 1_200,
        transcript: "labas",
        score: 100,
        passed: true,
        recordedAt: "2026-07-21T10:30:00.000Z"
      }
    ],
    ...overrides
  };
}

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();

interface SpeechState {
  spoken: Array<{ text: string; lang: string }>;
}

let speech: SpeechState;
let stopRecording: (() => void) | null;
let recognitionInstance: {
  lang: string;
  hear: (text: string) => void;
  onend: (() => void) | null;
} | null;

function installSpeech(voices: Array<{ lang: string; name: string }> = [{ lang: "lt-LT", name: "Lietuvių" }]) {
  speech = { spoken: [] };
  class Utterance {
    lang = "";
    rate = 1;
    voice: unknown = null;
    constructor(readonly text: string) {}
  }
  Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: Utterance });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => voices,
      speak: (utterance: Utterance) => speech.spoken.push({ text: utterance.text, lang: utterance.lang }),
      cancel: () => {},
      addEventListener: () => {},
      removeEventListener: () => {}
    }
  });
}

function installRecognition(available = true) {
  recognitionInstance = null;
  if (!available) {
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: undefined });
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: undefined });
    return;
  }
  class Recognition {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
    onerror: (() => void) | null = null;
    onend: (() => void) | null = null;
    start() {
      recognitionInstance = {
        lang: this.lang,
        hear: (text: string) => this.onresult?.({ results: [[{ transcript: text }]] }),
        onend: null
      };
      // Mirror the live handler so stop() can end it after the component swaps handlers in.
      Object.defineProperty(recognitionInstance, "onend", { get: () => this.onend, configurable: true });
    }
    stop() { this.onend?.(); }
    abort() {}
  }
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: Recognition });
}

function installRecorder() {
  class Recorder {
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly stream: { getTracks: () => Array<{ stop: () => void }> }) {}
    start() {
      stopRecording = () => {
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      };
    }
    stop() { stopRecording?.(); }
  }
  Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) }
  });
}

function client(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    lithuanianPractice: vi.fn().mockResolvedValue({ passMark: 85, bestScore: 0, words: [word()] }),
    refreshLithuanianHints: vi.fn(),
    // No suggestion by default, which is what an installation without a trainer key returns.
    translateLithuanian: vi.fn().mockResolvedValue({ lithuanian: "" }),
    suggestLithuanianPhrases: vi.fn().mockResolvedValue({ phrases: [] }),
    createLithuanianWord: vi.fn(),
    deleteLithuanianWord: vi.fn().mockResolvedValue(undefined),
    saveLithuanianRecording: vi.fn(),
    lithuanianRecordingBlob: vi.fn().mockResolvedValue(new Blob(["audio"], { type: "audio/webm" })),
    deleteLithuanianRecording: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as ApiClient;
}

beforeEach(() => {
  stopRecording = null;
  installSpeech();
  installRecorder();
  installRecognition();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  URL.createObjectURL = vi.fn(() => "blob:take-1");
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

describe("LithuanianTrainerView", () => {
  it("practises Lithuanian only — the English word is shown as the meaning, never spoken", async () => {
    render(<LithuanianTrainerView api={client()} displayName="Lucas" onSignOut={vi.fn()} />);
    await screen.findByText("labas");

    expect(screen.getByRole("button", { name: "Listen to labas" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record labas" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /hello/ })).toBeNull();
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("speaks the word with the Lithuanian locale", async () => {
    render(<LithuanianTrainerView api={client()} displayName="Lucas" onSignOut={vi.fn()} />);
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: "Listen to labas" }));

    expect(speech.spoken).toEqual([{ text: "labas", lang: "lt-LT" }]);
  });

  it("transcribes the take in Lithuanian and sends it for scoring", async () => {
    const saveLithuanianRecording = vi.fn().mockResolvedValue({
      id: "take-2",
      wordId: "word-1",
      contentType: "audio/webm",
      sizeBytes: 5,
      durationMs: 900,
      transcript: "labas",
      score: 100,
      passed: true,
      recordedAt: "2026-07-25T08:00:00.000Z"
    });
    render(
      <LithuanianTrainerView api={client({ saveLithuanianRecording })} displayName="Lucas" onSignOut={vi.fn()} />
    );
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: "Record labas" }));
    await waitFor(() => expect(recognitionInstance).not.toBeNull());
    expect(recognitionInstance!.lang).toBe("lt-LT");
    recognitionInstance!.hear("labas");
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording labas" }));

    await waitFor(() => expect(saveLithuanianRecording).toHaveBeenCalled());
    const [wordId, audio, durationMs, transcript] = saveLithuanianRecording.mock.calls[0]!;
    expect(wordId).toBe("word-1");
    expect((audio as Blob).size).toBeGreaterThan(0);
    expect(typeof durationMs).toBe("number");
    expect(transcript).toBe("labas");
  });

  it("reports a pass and a failure differently", async () => {
    const failing = {
      id: "take-3",
      wordId: "word-1",
      contentType: "audio/webm",
      sizeBytes: 5,
      durationMs: 900,
      transcript: "labai",
      score: 80,
      passed: false,
      recordedAt: "2026-07-25T08:00:00.000Z"
    };
    render(
      <LithuanianTrainerView
        api={client({ saveLithuanianRecording: vi.fn().mockResolvedValue(failing) })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: "Record labas" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording labas" }));

    expect(await screen.findByText(/80% — keep practising labas/)).toBeTruthy();
    expect(await screen.findByText("80% fail")).toBeTruthy();
    expect(screen.getByText("Best 100%")).toBeTruthy();
  });

  it("still saves the take when the browser cannot score it", async () => {
    installRecognition(false);
    const unscored = {
      id: "take-4",
      wordId: "word-1",
      contentType: "audio/webm",
      sizeBytes: 5,
      durationMs: 900,
      transcript: null,
      score: null,
      passed: null,
      recordedAt: "2026-07-25T08:00:00.000Z"
    };
    const saveLithuanianRecording = vi.fn().mockResolvedValue(unscored);
    render(
      <LithuanianTrainerView api={client({ saveLithuanianRecording })} displayName="Lucas" onSignOut={vi.fn()} />
    );
    await screen.findByText("labas");
    expect(screen.getByText(/cannot check pronunciation/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Record labas" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording labas" }));

    await waitFor(() => expect(saveLithuanianRecording).toHaveBeenCalled());
    expect(saveLithuanianRecording.mock.calls[0]![3]).toBeNull();
    expect(await screen.findByText("Not scored")).toBeTruthy();
  });

  it("says a word is owed when none was added today, and shows the streak", async () => {
    render(
      <LithuanianTrainerView
        api={client({ lithuanianPractice: vi.fn().mockResolvedValue({ passMark: 85, bestScore: 0, words: [word({ createdAt: YESTERDAY })] }) })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );

    expect(await screen.findByText("Today's word is not added yet")).toBeTruthy();
    expect(screen.getByText(/keep the 1-day streak/)).toBeTruthy();
  });

  it("confirms the goal is met once a word is added today", async () => {
    render(<LithuanianTrainerView api={client()} displayName="Lucas" onSignOut={vi.fn()} />);

    expect(await screen.findByText("Today's word is added")).toBeTruthy();
    expect(screen.getByText(/1 today · 1-day streak/)).toBeTruthy();
  });

  it("flags a long gap instead of pretending the streak survived", async () => {
    const stale = new Date(Date.now() - 5 * 86_400_000).toISOString();
    render(
      <LithuanianTrainerView
        api={client({ lithuanianPractice: vi.fn().mockResolvedValue({ passMark: 85, bestScore: 0, words: [word({ createdAt: stale })] }) })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );

    expect(await screen.findByText(/5 days since the last word/)).toBeTruthy();
  });

  it("lets the learner choose a phrase and explains it word by word", async () => {
    const phrase = word({
      id: "phrase-1",
      lithuanian: "labas rytas",
      english: "good morning",
      kind: "phrase",
      recordings: [],
      hints: [
        { word: "labas", meaning: "hello", tip: "The a is short, like in cat." },
        { word: "rytas", meaning: "morning", tip: "Roll the r a little." }
      ]
    });
    render(
      <LithuanianTrainerView
        api={client({ lithuanianPractice: vi.fn().mockResolvedValue({ passMark: 85, bestScore: 0, words: [phrase] }) })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas rytas");

    // "Phrase" is also the label of the add-form toggle, so match the card's tag specifically.
    expect(screen.getAllByText("Phrase").some((element) => element.tagName === "SPAN")).toBe(true);
    expect(screen.getByText("The a is short, like in cat.")).toBeTruthy();
    expect(screen.getByText("Roll the r a little.")).toBeTruthy();

    // Each word of the phrase can be heard on its own, which is the point of the breakdown.
    fireEvent.click(screen.getByRole("button", { name: "Listen to rytas on its own" }));
    expect(speech.spoken).toEqual([{ text: "rytas", lang: "lt-LT" }]);
  });

  it("sends the chosen kind when adding a phrase", async () => {
    const createLithuanianWord = vi.fn().mockResolvedValue(word({
      id: "phrase-2",
      lithuanian: "labas rytas",
      english: "good morning",
      kind: "phrase",
      hints: [],
      recordings: []
    }));
    render(
      <LithuanianTrainerView api={client({ createLithuanianWord })} displayName="Lucas" onSignOut={vi.fn()} />
    );
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: "Phrase" }));
    fireEvent.change(screen.getByLabelText("Lithuanian"), { target: { value: "labas rytas" } });
    fireEvent.change(screen.getByLabelText("English"), { target: { value: "good morning" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));

    await waitFor(() => expect(createLithuanianWord).toHaveBeenCalledWith({
      lithuanian: "labas rytas",
      english: "good morning",
      kind: "phrase"
    }));
  });

  it("offers to build the breakdown for a phrase that has no hints yet", async () => {
    const bare = word({ id: "phrase-3", lithuanian: "labas rytas", kind: "phrase", hints: [], recordings: [] });
    const refreshLithuanianHints = vi.fn().mockResolvedValue({
      ...bare,
      hints: [{ word: "labas", meaning: "hello", tip: "Short a." }]
    });
    render(
      <LithuanianTrainerView
        api={client({
          lithuanianPractice: vi.fn().mockResolvedValue({ passMark: 85, bestScore: 0, words: [bare] }),
          refreshLithuanianHints
        })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas rytas");

    fireEvent.click(screen.getByRole("button", { name: /Explain word by word/ }));

    await waitFor(() => expect(refreshLithuanianHints).toHaveBeenCalledWith("phrase-3"));
    expect(await screen.findByText("Short a.")).toBeTruthy();
  });

  it("judges takes against the pass mark the server reports, not a hardcoded 85", async () => {
    // An administrator lowered the bar to 60, so a 70% take is a pass.
    const seventy = word({
      recordings: [{
        id: "take-9",
        wordId: "word-1",
        contentType: "audio/webm",
        sizeBytes: 5,
        durationMs: 900,
        transcript: "labai",
        score: 70,
        passed: true,
        recordedAt: "2026-07-25T08:00:00.000Z"
      }]
    });
    render(
      <LithuanianTrainerView
        api={client({ lithuanianPractice: vi.fn().mockResolvedValue({ passMark: 60, bestScore: 0, words: [seventy] }) })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );

    expect(await screen.findByText("70% pass")).toBeTruthy();
    expect(screen.getByText("Best 70%")).toBeTruthy();
  });

  it("adds a word pair", async () => {
    const createLithuanianWord = vi.fn().mockResolvedValue({
      id: "word-2",
      lithuanian: "ačiū",
      english: "thanks",
      createdAt: new Date().toISOString(),
      recordings: []
    });
    render(
      <LithuanianTrainerView api={client({ createLithuanianWord })} displayName="Lucas" onSignOut={vi.fn()} />
    );
    await screen.findByText("labas");

    fireEvent.change(screen.getByLabelText("Lithuanian"), { target: { value: "ačiū" } });
    fireEvent.change(screen.getByLabelText("English"), { target: { value: "thanks" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));

    await waitFor(() => expect(createLithuanianWord).toHaveBeenCalledWith({
      lithuanian: "ačiū",
      english: "thanks",
      kind: "word"
    }));
    expect(await screen.findByText("ačiū")).toBeTruthy();
  });

  it("writes the Lithuanian for the English Lucas typed", async () => {
    const translateLithuanian = vi.fn().mockResolvedValue({ lithuanian: "ačiū" });
    const createLithuanianWord = vi.fn().mockResolvedValue(word({
      id: "word-2",
      lithuanian: "ačiū",
      english: "thanks",
      recordings: []
    }));
    render(
      <LithuanianTrainerView
        api={client({ translateLithuanian, createLithuanianWord })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas");

    fireEvent.change(screen.getByLabelText(/English/), { target: { value: "thanks" } });

    await waitFor(
      () => expect(translateLithuanian).toHaveBeenCalledWith(
        { english: "thanks", kind: "word" },
        expect.anything()
      ),
      { timeout: 2_000 }
    );
    await waitFor(() => expect(
      (screen.getByLabelText(/Lithuanian/) as HTMLInputElement).value
    ).toBe("ačiū"));

    // The suggestion is a starting point, not a decision: it is saved only when Add is pressed.
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() => expect(createLithuanianWord).toHaveBeenCalledWith({
      lithuanian: "ačiū",
      english: "thanks",
      kind: "word"
    }));
  });

  it("never overwrites a Lithuanian word Lucas typed himself", async () => {
    const translateLithuanian = vi.fn().mockResolvedValue({ lithuanian: "ačiū" });
    render(
      <LithuanianTrainerView
        api={client({ translateLithuanian })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas");

    fireEvent.change(screen.getByLabelText(/Lithuanian/), { target: { value: "dėkui" } });
    fireEvent.change(screen.getByLabelText(/English/), { target: { value: "thanks" } });

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(translateLithuanian).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Lithuanian/) as HTMLInputElement).value).toBe("dėkui");
  });

  it("plays the server's recording rather than the device voice when there is one", async () => {
    const spoken = word({ hasPronunciation: true });
    const lithuanianPronunciationBlob = vi.fn()
      .mockResolvedValue(new Blob(["said"], { type: "audio/mpeg" }));
    render(
      <LithuanianTrainerView
        api={client({
          lithuanianPractice: vi.fn().mockResolvedValue({ passMark: 85, bestScore: 0, words: [spoken] }),
          lithuanianPronunciationBlob
        })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: "Listen to labas" }));

    await waitFor(() => expect(lithuanianPronunciationBlob).toHaveBeenCalledWith("word-1"));
    // The generated audio is the reference; the device voice is not consulted at all.
    expect(speech.spoken).toEqual([]);
  });

  it("falls back to the device voice when the server has no recording", async () => {
    render(<LithuanianTrainerView api={client()} displayName="Lucas" onSignOut={vi.fn()} />);
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: "Listen to labas" }));

    expect(speech.spoken).toEqual([{ text: "labas", lang: "lt-LT" }]);
  });

  it("stops warning about a missing voice once the server can say every word", async () => {
    installSpeech([{ lang: "en-US", name: "English" }]);
    render(
      <LithuanianTrainerView
        api={client({
          lithuanianPractice: vi.fn().mockResolvedValue({
            passMark: 85,
            words: [word({ hasPronunciation: true })]
          })
        })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas");

    expect(screen.queryByText(/No Lithuanian voice is installed/)).toBeNull();
  });

  it("offers phrases around the word being typed and takes one up", async () => {
    const suggestLithuanianPhrases = vi.fn().mockResolvedValue({
      phrases: ["good morning", "morning coffee"]
    });
    const translateLithuanian = vi.fn()
      .mockResolvedValueOnce({ lithuanian: "rytas" })
      .mockResolvedValueOnce({ lithuanian: "labas rytas" });
    render(
      <LithuanianTrainerView
        api={client({ suggestLithuanianPhrases, translateLithuanian })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas");

    fireEvent.change(screen.getByLabelText(/English/), { target: { value: "morning" } });
    const offer = await screen.findByRole("button", { name: "good morning" }, { timeout: 2_000 });

    // Taking up an offer switches to a phrase and retranslates, rather than leaving the single
    // word's Lithuanian behind under a phrase's English.
    fireEvent.click(offer);
    expect((screen.getByLabelText(/English/) as HTMLInputElement).value).toBe("good morning");
    expect(screen.getByRole("button", { name: "Phrase" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(
      () => expect((screen.getByLabelText(/Lithuanian/) as HTMLInputElement).value).toBe("labas rytas"),
      { timeout: 2_000 }
    );
  });

  it("does not offer phrases once a phrase is what is being typed", async () => {
    const suggestLithuanianPhrases = vi.fn().mockResolvedValue({ phrases: ["good morning"] });
    render(
      <LithuanianTrainerView
        api={client({ suggestLithuanianPhrases })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: "Phrase" }));
    fireEvent.change(screen.getByLabelText(/English/), { target: { value: "morning" } });

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(suggestLithuanianPhrases).not.toHaveBeenCalled();
  });

  it("asks for a fresh suggestion when the Lithuanian field is cleared", async () => {
    const translateLithuanian = vi.fn()
      .mockResolvedValueOnce({ lithuanian: "ačiū" })
      .mockResolvedValueOnce({ lithuanian: "dėkui" });
    render(
      <LithuanianTrainerView
        api={client({ translateLithuanian })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas");

    fireEvent.change(screen.getByLabelText(/English/), { target: { value: "thanks" } });
    await waitFor(
      () => expect((screen.getByLabelText(/Lithuanian/) as HTMLInputElement).value).toBe("ačiū"),
      { timeout: 2_000 }
    );

    // Throwing the suggestion away has to ask for another one without the English being retyped,
    // otherwise the field stays empty and Add stays disabled.
    fireEvent.change(screen.getByLabelText(/Lithuanian/), { target: { value: "" } });
    await waitFor(
      () => expect((screen.getByLabelText(/Lithuanian/) as HTMLInputElement).value).toBe("dėkui"),
      { timeout: 2_000 }
    );
    expect(translateLithuanian).toHaveBeenCalledTimes(2);
  });

  it("leaves the Lithuanian field typeable when no translation comes back", async () => {
    const translateLithuanian = vi.fn().mockRejectedValue(new Error("no trainer key"));
    render(
      <LithuanianTrainerView
        api={client({ translateLithuanian })}
        displayName="Lucas"
        onSignOut={vi.fn()}
      />
    );
    await screen.findByText("labas");

    fireEvent.change(screen.getByLabelText(/English/), { target: { value: "thanks" } });
    await waitFor(() => expect(translateLithuanian).toHaveBeenCalled(), { timeout: 2_000 });

    // A failed suggestion is not an error the learner is shown, and it does not block the form.
    expect(screen.queryByText(/could not/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Lithuanian/), { target: { value: "dėkui" } });
    expect((screen.getByLabelText(/Lithuanian/) as HTMLInputElement).value).toBe("dėkui");
  });

  it("plays a saved recording through the audio element", async () => {
    const lithuanianRecordingBlob = vi.fn().mockResolvedValue(new Blob(["audio"], { type: "audio/webm" }));
    render(
      <LithuanianTrainerView api={client({ lithuanianRecordingBlob })} displayName="Lucas" onSignOut={vi.fn()} />
    );
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: /Play the recording from/ }));

    await waitFor(() => expect(lithuanianRecordingBlob).toHaveBeenCalledWith("take-1"));
    await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled());
  });

  it("claims playback permission during the tap so audio plays under every autoplay policy", async () => {
    // Chrome (Android and desktop) and Safari (iOS and macOS) all refuse a play() that happens
    // after an await. Playback has to be claimed while the tap is still in progress.
    let release: ((blob: Blob) => void) | null = null;
    const lithuanianRecordingBlob = vi.fn(() => new Promise<Blob>((resolve) => { release = resolve; }));
    render(
      <LithuanianTrainerView api={client({ lithuanianRecordingBlob })} displayName="Lucas" onSignOut={vi.fn()} />
    );
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: /Play the recording from/ }));

    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    release!(new Blob(["audio"], { type: "audio/webm" }));
    await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2));
  });

  it("names an insecure connection as the reason the microphone is missing", async () => {
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: undefined });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    render(<LithuanianTrainerView api={client()} displayName="Lucas" onSignOut={vi.fn()} />);

    expect(await screen.findByText(/Recording needs a secure connection/)).toBeTruthy();
  });

  it("warns when no Lithuanian voice is installed instead of failing silently", async () => {
    installSpeech([{ lang: "en-US", name: "English" }]);
    render(<LithuanianTrainerView api={client()} displayName="Lucas" onSignOut={vi.fn()} />);

    expect(await screen.findByText(/No Lithuanian voice is installed/)).toBeTruthy();
  });

  it("reports a refused microphone rather than leaving the button stuck", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error("Permission denied")) }
    });
    render(<LithuanianTrainerView api={client()} displayName="Lucas" onSignOut={vi.fn()} />);
    await screen.findByText("labas");

    fireEvent.click(screen.getByRole("button", { name: "Record labas" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Permission denied");
    expect(screen.getByRole("button", { name: "Record labas" })).toBeTruthy();
  });
});
