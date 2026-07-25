/**
 * Speech synthesis and microphone capture for the Lithuanian trainer.
 *
 * Both browser APIs are optional: jsdom has neither, Linux desktops frequently ship without a
 * Lithuanian voice, and the microphone needs a user grant. Every entry point therefore reports
 * what is available instead of throwing, so the screen can explain the gap to Lucas.
 */

export type SpeechAvailability = "ready" | "unsupported" | "missing-voice";

function synthesis(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

export function canSpeak(): boolean {
  return synthesis() !== null && typeof window.SpeechSynthesisUtterance === "function";
}

/**
 * Voices load asynchronously in Chrome, so the first call after a page load can legitimately
 * return an empty list. Callers re-check on the voiceschanged event.
 */
export function voiceFor(locale: string): SpeechSynthesisVoice | null {
  const speech = synthesis();
  if (!speech || typeof speech.getVoices !== "function") return null;
  const language = locale.toLowerCase();
  const prefix = language.split("-")[0] ?? language;
  const voices = speech.getVoices() ?? [];
  return voices.find((voice) => voice.lang?.toLowerCase() === language)
    ?? voices.find((voice) => voice.lang?.toLowerCase().startsWith(`${prefix}-`))
    ?? voices.find((voice) => voice.lang?.toLowerCase() === prefix)
    ?? null;
}

export function speechAvailability(locale: string): SpeechAvailability {
  if (!canSpeak()) return "unsupported";
  return voiceFor(locale) ? "ready" : "missing-voice";
}

export function onVoicesChanged(handler: () => void): () => void {
  const speech = synthesis();
  if (!speech || typeof speech.addEventListener !== "function") return () => {};
  speech.addEventListener("voiceschanged", handler);
  return () => speech.removeEventListener("voiceschanged", handler);
}

/**
 * Speaks one word. A missing voice for the locale is not a failure: the browser still reads the
 * word with its default voice, which is better than silence while a language pack is installed.
 */
export function speak(text: string, locale: string): boolean {
  const speech = synthesis();
  if (!speech || typeof window.SpeechSynthesisUtterance !== "function") return false;
  speech.cancel();
  const utterance = new window.SpeechSynthesisUtterance(text);
  utterance.lang = locale;
  const voice = voiceFor(locale);
  if (voice) utterance.voice = voice;
  // Learners need the word slower than conversational speed.
  utterance.rate = 0.85;
  speech.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  synthesis()?.cancel();
}

export function canRecord(): boolean {
  return typeof window !== "undefined"
    && typeof window.MediaRecorder === "function"
    && typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function";
}

/**
 * Explains why recording is unavailable, or null when it works. Phones and laptops reach this
 * app over the LAN, and every current browser hides the microphone entirely on a plain-HTTP
 * origin -- which otherwise looks identical to an unsupported browser.
 */
export function recordingBlockedReason(): string | null {
  if (canRecord()) return null;
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "Recording needs a secure connection. Open this page over HTTPS to use the microphone.";
  }
  return "This browser cannot record audio, so recordings are unavailable.";
}

/**
 * A 44-byte WAV with no samples. Playing it inside a tap or click is what grants an <audio>
 * element permission to play under every browser autoplay policy; see the note where it is used.
 */
export const SILENT_CLIP =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

export interface FinishedRecording {
  audio: Blob;
  durationMs: number;
  /** What speech recognition heard, or null when it was unavailable or heard nothing. */
  transcript: string | null;
}

interface RecognitionResult {
  transcript: string;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<RecognitionResult>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => RecognitionLike;

/** How long a take waits for a late transcript before being saved unscored. */
const RecognitionGraceMs = 1_500;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  });
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

/** Whether a take can be scored. Without this the audio is still recorded, just not marked. */
export function canScore(): boolean {
  return recognitionConstructor() !== null;
}

/**
 * A single take. `start` asks for the microphone, `stop` resolves with the captured audio, and
 * `cancel` throws the take away. The microphone track is always released either way, so the
 * browser's recording indicator does not stay on after practice.
 */
export class PronunciationRecorder {
  private recorder: MediaRecorder | null = null;
  private recognition: RecognitionLike | null = null;
  private chunks: Blob[] = [];
  private heard = "";
  private startedAt = 0;

  get recording(): boolean {
    return this.recorder !== null;
  }

  /**
   * Captures the take and, in parallel, transcribes it so the attempt can be scored. Recognition
   * is best-effort: if the browser has none, or it hears nothing, the audio is still saved and
   * the take is simply left unscored.
   */
  async start(locale: string): Promise<void> {
    if (!canRecord()) throw new Error("This browser cannot record audio");
    if (this.recorder) throw new Error("A recording is already running");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    this.chunks = [];
    this.heard = "";
    this.startedAt = Date.now();
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder = recorder;
    recorder.start();
    this.listen(locale);
  }

  stop(): Promise<FinishedRecording> {
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error("Nothing is being recorded"));
    // Recognition often delivers its result after the tap that ended the take, so the transcript
    // is waited for before the take is reported -- bounded, because a browser that never fires
    // onend must not leave the learner staring at a spinner.
    const transcribed = this.finishListening();
    return new Promise<FinishedRecording>((resolve, reject) => {
      recorder.onstop = () => {
        const type = recorder.mimeType || this.chunks[0]?.type || "audio/webm";
        const audio = new Blob(this.chunks, { type });
        const durationMs = Math.max(0, Date.now() - this.startedAt);
        this.release();
        if (audio.size === 0) {
          reject(new Error("Nothing was recorded. Check the microphone and try again."));
          return;
        }
        void transcribed.then(() => {
          const transcript = this.heard.trim();
          resolve({ audio, durationMs, transcript: transcript.length > 0 ? transcript : null });
        });
      };
      recorder.onerror = () => {
        this.release();
        reject(new Error("The recording stopped unexpectedly"));
      };
      recorder.stop();
    });
  }

  private finishListening(): Promise<void> {
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, RecognitionGraceMs);
      const settle = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      recognition.onend = settle;
      recognition.onerror = settle;
      try { recognition.stop(); } catch { settle(); }
    });
  }

  cancel(): void {
    const recorder = this.recorder;
    if (!recorder) return;
    recorder.onstop = null;
    recorder.onerror = null;
    try { recorder.stop(); } catch { /* already stopped */ }
    this.release();
  }

  private listen(locale: string): void {
    const Recognition = recognitionConstructor();
    if (!Recognition) return;
    try {
      const recognition = new Recognition();
      recognition.lang = locale;
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        const alternative = event.results?.[0]?.[0];
        if (alternative?.transcript) this.heard = alternative.transcript;
      };
      // A recognition failure only costs the score, so it is swallowed rather than surfaced.
      recognition.onerror = () => {};
      recognition.onend = () => {};
      this.recognition = recognition;
      recognition.start();
    } catch {
      this.recognition = null;
    }
  }

  private release(): void {
    this.recorder?.stream?.getTracks?.().forEach((track) => track.stop());
    // Already null when stop() ran; set on the cancel path, where the transcript is discarded.
    try { this.recognition?.abort(); } catch { /* already stopped */ }
    this.recognition = null;
    this.recorder = null;
    this.chunks = [];
  }
}
