import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CalendarDays,
  CircleAlert,
  CircleCheck,
  Flame,
  Gamepad2,
  Languages,
  Lightbulb,
  LoaderCircle,
  LogOut,
  Mic,
  Play,
  Plus,
  Square,
  Trash2,
  Volume2
} from "lucide-react";
import {
  LITHUANIAN_LOCALE,
  LITHUANIAN_MAX_PHRASE_SUGGESTIONS,
  LITHUANIAN_MAX_PHRASE_WORDS,
  LITHUANIAN_PASS_MARK,
  type LithuanianEntryKind,
  type LithuanianRecording,
  type LithuanianWord
} from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { formatDate, formatDateTime } from "../lib/format.js";
import { daysSince, practiceStatus } from "../lib/practiceDays.js";
import { spellOut, specialLetters } from "../lib/lithuanianLetters.js";
import { LithuanianGameView } from "./LithuanianGameView.js";
import {
  PronunciationRecorder,
  SILENT_CLIP,
  canRecord,
  canScore,
  canSpeak,
  onVoicesChanged,
  recordingBlockedReason,
  speak,
  speechAvailability,
  stopSpeaking
} from "../lib/pronunciation.js";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * How long typing has to pause before the English is sent for translation. Long enough that a
 * word is not translated letter by letter, short enough that the Lithuanian is already there by
 * the time the learner looks up from the keyboard.
 */
const TranslateDebounceMs = 600;

/**
 * A Lithuanian word with the letters English does not have marked.
 *
 * The marking is decoration: splitting a word into per-letter elements makes some screen readers
 * spell it out, so a word that has such letters carries the whole word alongside for assistive
 * tech. A word English could spell needs neither, and is left as plain text.
 */
function SpelledWord({ text }: { text: string }) {
  const runs = spellOut(text);
  if (runs.every((run) => run.note === null)) return <>{text}</>;
  return (
    <>
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true">
        {runs.map((run, index) => run.note === null
          ? <span key={index}>{run.text}</span>
          : <em key={index} className="trainer-letter">{run.text}</em>)}
      </span>
    </>
  );
}

function bestScore(recordings: LithuanianRecording[]): number | null {
  const scores = recordings.map((take) => take.score).filter((score): score is number => score !== null);
  return scores.length > 0 ? Math.max(...scores) : null;
}

/**
 * Lucas's only screen: Lithuanian vocabulary practice.
 *
 * A word pair is one Lithuanian word and its English meaning. Only the Lithuanian side is spoken
 * and recorded -- the English word is there to say what it means, not to be learned. Each take is
 * transcribed by the browser, scored against the target word by the server, and kept with the
 * date it was made. One new word a day is the goal, and the screen says so when one is owed.
 */
export function LithuanianTrainerView({
  api,
  displayName,
  onSignOut
}: {
  api: ApiClient;
  displayName: string;
  onSignOut: () => void;
}) {
  const [words, setWords] = useState<LithuanianWord[]>([]);
  const [passMark, setPassMark] = useState(LITHUANIAN_PASS_MARK);
  const [highScore, setHighScore] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lithuanian, setLithuanian] = useState("");
  const [english, setEnglish] = useState("");
  const [kind, setKind] = useState<LithuanianEntryKind>("word");
  const [translating, setTranslating] = useState(false);
  const [phrases, setPhrases] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [hintingId, setHintingId] = useState<string | null>(null);
  const [sayingId, setSayingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recordingWordId, setRecordingWordId] = useState<string | null>(null);
  const [savingWordId, setSavingWordId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [voiceRevision, setVoiceRevision] = useState(0);

  const recorder = useRef(new PronunciationRecorder());
  // True once Lucas has typed a Lithuanian word himself, which stops suggestions overwriting it.
  const lithuanianEdited = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrls = useRef(new Map<string, string>());
  const audioUnlocked = useRef(false);

  const speechSupported = canSpeak();
  const recordingSupported = canRecord();
  const recordingBlocked = recordingBlockedReason();
  const scoringSupported = canScore();
  // Recomputed when the browser finishes loading its voice list.
  const missingVoice = useMemo(() => {
    void voiceRevision;
    return speechSupported && speechAvailability(LITHUANIAN_LOCALE) === "missing-voice";
  }, [speechSupported, voiceRevision]);
  // Whether any word still depends on this device having a voice. Once the server can say them
  // all, warning about the device's voices would be telling the learner about a problem the
  // screen no longer has.
  const leansOnDeviceVoice = useMemo(
    () => words.length === 0 || words.some((word) => !word.hasPronunciation),
    [words]
  );
  const practice = useMemo(() => practiceStatus(words), [words]);
  const idleDays = daysSince(practice.lastAddedDay);

  useEffect(() => onVoicesChanged(() => setVoiceRevision((value) => value + 1)), []);

  /**
   * Lucas writes what he wants to say in English and the Lithuanian he will practise is filled in
   * for him. It only ever writes into a field he has not typed in himself, so correcting the
   * suggestion -- or ignoring it and writing the Lithuanian directly -- always wins. A failed or
   * unavailable translation is silent: the field is still typeable, which is how the screen
   * worked before this existed.
   */
  useEffect(() => {
    const wanted = english.trim();
    if (!wanted) {
      // Only an unwanted suggestion is withdrawn; a word typed by hand outlives the English.
      if (!lithuanianEdited.current) setLithuanian("");
      setTranslating(false);
      return;
    }
    // A word already in the box -- typed or suggested -- is never replaced. Emptying the box is
    // what asks for a fresh suggestion, which is why `lithuanian` belongs in the dependencies:
    // without it, clearing the field would leave it blank until the English was retyped.
    if (lithuanian.trim()) {
      setTranslating(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setTranslating(true);
      api.translateLithuanian({ english: wanted, kind }, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.lithuanian) setLithuanian(result.lithuanian);
        })
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) setTranslating(false);
        });
    }, TranslateDebounceMs);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [api, english, kind, lithuanian]);

  /**
   * Offers phrases built around the single word being typed, so one word can grow into something
   * Lucas could actually say. Only offered while adding a word -- once he is writing a phrase the
   * offer would be competing with what he is already typing.
   */
  useEffect(() => {
    const wanted = english.trim();
    if (kind !== "word" || wanted.split(/\s+/).length !== 1 || wanted.length < 2) {
      setPhrases([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.suggestLithuanianPhrases(wanted, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setPhrases(result.phrases.slice(0, LITHUANIAN_MAX_PHRASE_SUGGESTIONS));
        })
        .catch(() => {});
    }, TranslateDebounceMs);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [api, english, kind]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const practice = await api.lithuanianPractice();
      setWords(practice.words);
      setPassMark(practice.passMark);
      setHighScore(practice.bestScore);
      setError("");
    } catch (reason) {
      setError(errorText(reason, "The word list could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const takes = recorder.current;
    const urls = objectUrls.current;
    return () => {
      takes.cancel();
      stopSpeaking();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  const announce = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "" : current), 5_000);
  };

  // Switching between a word and a phrase withdraws a suggestion made for the other one so a
  // fresh one is asked for. A word typed by hand is left alone.
  const chooseKind = (next: LithuanianEntryKind) => {
    setKind(next);
    if (!lithuanianEdited.current) setLithuanian("");
  };

  /**
   * Takes up one of the offered phrases. The English is replaced and the Lithuanian is cleared so
   * the translator writes the phrase rather than leaving the single word's translation behind.
   */
  const choosePhrase = (offer: string) => {
    setKind("phrase");
    setEnglish(offer);
    setPhrases([]);
    lithuanianEdited.current = false;
    setLithuanian("");
  };

  const addWord = async (event: FormEvent) => {
    event.preventDefault();
    const nextLithuanian = lithuanian.trim();
    const nextEnglish = english.trim();
    if (!nextLithuanian || !nextEnglish) return;
    setAdding(true);
    setError("");
    try {
      const created = await api.createLithuanianWord({
        lithuanian: nextLithuanian,
        english: nextEnglish,
        kind
      });
      setWords((current) => [created, ...current]);
      setLithuanian("");
      setEnglish("");
      setPhrases([]);
      lithuanianEdited.current = false;
      announce(practice.dueToday
        ? `${created.lithuanian} added. Today's ${kind} is done.`
        : `${created.lithuanian} added.`);
    } catch (reason) {
      setError(errorText(reason, `The ${kind} could not be added`));
    } finally {
      setAdding(false);
    }
  };

  const regenerateHints = async (word: LithuanianWord) => {
    setHintingId(word.id);
    setError("");
    try {
      const updated = await api.refreshLithuanianHints(word.id);
      setWords((current) => current.map((item) => item.id === word.id ? updated : item));
    } catch (reason) {
      setError(errorText(reason, "The word-by-word hints could not be built"));
    } finally {
      setHintingId(null);
    }
  };

  /**
   * Says a word that has no recording yet: one added before a key was configured, or one that
   * predates the server saying them at all. Without this those words would be stuck on the
   * device's own voice forever.
   */
  const regeneratePronunciation = async (word: LithuanianWord) => {
    setSayingId(word.id);
    setError("");
    try {
      const updated = await api.refreshLithuanianPronunciation(word.id);
      setWords((current) => current.map((item) => item.id === word.id ? updated : item));
      announce(`${word.lithuanian} can now be played properly.`);
    } catch (reason) {
      setError(errorText(reason, "The spoken version could not be made"));
    } finally {
      setSayingId(null);
    }
  };

  /**
   * Opens the game.
   *
   * The trainer stays mounted behind it, so its unmount cleanup does not run: a take in progress
   * has to be stopped here, or the microphone would keep recording -- with no stop button on
   * screen -- for the whole game.
   */
  const startGame = () => {
    recorder.current.cancel();
    setRecordingWordId(null);
    stopSpeaking();
    setPlaying(true);
  };

  const removeWord = async (word: LithuanianWord) => {
    if (!window.confirm(`Remove ${word.lithuanian} and its recordings?`)) return;
    setBusyId(word.id);
    setError("");
    try {
      await api.deleteLithuanianWord(word.id);
      setWords((current) => current.filter((item) => item.id !== word.id));
      announce(`${word.lithuanian} removed.`);
    } catch (reason) {
      setError(errorText(reason, "The word could not be removed"));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * One word out of a phrase. Only whole entries are generated on the server, so a piece of a
   * phrase is always the device's own voice.
   */
  const sayWithDeviceVoice = (text: string) => {
    setError("");
    if (!speak(text, LITHUANIAN_LOCALE)) setError("This browser cannot speak words out loud");
  };

  /**
   * Says a word out loud, preferring the version the server generated.
   *
   * The browser's own voice only says Lithuanian properly on a device that happens to have a
   * Lithuanian voice installed; without one it reads the word with an English voice, which
   * teaches the wrong sounds. The generated audio is the same on every device, so it is what is
   * played whenever it exists -- the browser voice is the fallback, not the other way round.
   */
  const pronounce = async (word: LithuanianWord) => {
    setError("");
    if (!word.hasPronunciation) {
      if (!speak(word.lithuanian, LITHUANIAN_LOCALE)) setError("This browser cannot speak words out loud");
      return;
    }

    const key = `say:${word.id}`;
    const player = audio.current;
    let url = objectUrls.current.get(key);
    // Claims playback permission during the tap, for the same reason play() does.
    if (player && !url && !audioUnlocked.current) {
      audioUnlocked.current = true;
      player.src = SILENT_CLIP;
      void Promise.resolve(player.play()).catch(() => { audioUnlocked.current = false; });
    }
    setBusyId(key);
    try {
      if (!url) {
        url = URL.createObjectURL(await api.lithuanianPronunciationBlob(word.id));
        objectUrls.current.set(key, url);
      }
      if (!player) return;
      player.src = url;
      await player.play();
    } catch {
      // A missing or unplayable file is not worth an error message when the browser can have a
      // go at it instead.
      speak(word.lithuanian, LITHUANIAN_LOCALE);
    } finally {
      setBusyId(null);
    }
  };

  const toggleRecording = async (word: LithuanianWord) => {
    setError("");
    if (recordingWordId === word.id) {
      setRecordingWordId(null);
      setSavingWordId(word.id);
      try {
        const take = await recorder.current.stop();
        const saved = await api.saveLithuanianRecording(
          word.id, take.audio, take.durationMs, take.transcript);
        setWords((current) => current.map((item) => item.id === word.id
          ? { ...item, recordings: [saved, ...item.recordings] }
          : item));
        announce(saved.score === null
          ? `Saved. This browser could not check the pronunciation.`
          : saved.passed
            ? `${saved.score}% — pass. Nice, ${word.lithuanian} sounded right.`
            : `${saved.score}% — keep practising ${word.lithuanian}. ${passMark}% passes.`);
      } catch (reason) {
        setError(errorText(reason, "The recording could not be saved"));
      } finally {
        setSavingWordId(null);
      }
      return;
    }
    if (recordingWordId) {
      recorder.current.cancel();
      setRecordingWordId(null);
    }
    // Speaking over the microphone would record the synthesized voice too.
    stopSpeaking();
    try {
      await recorder.current.start(LITHUANIAN_LOCALE);
      setRecordingWordId(word.id);
    } catch (reason) {
      setError(errorText(reason, "The microphone is unavailable. Allow microphone access and try again."));
    }
  };

  const play = async (recordingId: string) => {
    setError("");
    setBusyId(recordingId);
    const player = audio.current;
    let url = objectUrls.current.get(recordingId);
    // Browsers grant an <audio> element permission to play when play() runs inside the tap or
    // click that triggered it, and downloading the recording first breaks that chain. Playing a
    // silent clip claims the permission while the gesture is still live; the element keeps it for
    // every later playback. Required by iOS Safari, matches Chrome's autoplay policy on Android
    // and desktop, and harmless where playback was never blocked.
    if (player && !url && !audioUnlocked.current) {
      audioUnlocked.current = true;
      player.src = SILENT_CLIP;
      void Promise.resolve(player.play()).catch(() => { audioUnlocked.current = false; });
    }
    try {
      if (!url) {
        url = URL.createObjectURL(await api.lithuanianRecordingBlob(recordingId));
        objectUrls.current.set(recordingId, url);
      }
      if (!player) return;
      player.src = url;
      await player.play();
    } catch (reason) {
      setError(errorText(reason, "The recording could not be played"));
    } finally {
      setBusyId(null);
    }
  };

  const removeRecording = async (wordId: string, recordingId: string) => {
    setBusyId(recordingId);
    setError("");
    try {
      await api.deleteLithuanianRecording(recordingId);
      setWords((current) => current.map((word) => word.id === wordId
        ? { ...word, recordings: word.recordings.filter((item) => item.id !== recordingId) }
        : word));
      const url = objectUrls.current.get(recordingId);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrls.current.delete(recordingId);
      }
    } catch (reason) {
      setError(errorText(reason, "The recording could not be removed"));
    } finally {
      setBusyId(null);
    }
  };

  if (playing) {
    return (
      <LithuanianGameView
        api={api}
        words={words}
        bestScore={highScore}
        onFinished={setHighScore}
        onClose={() => setPlaying(false)}
      />
    );
  }

  return (
    <main className="trainer-screen">
      <header className="trainer-topbar">
        <div className="trainer-brand">
          <span className="brand-mark"><Languages size={20} /></span>
          <div>
            <strong>Lithuanian practice</strong>
            <span>Learning with {displayName}</span>
          </div>
        </div>
        <button className="icon-button logout-trigger" onClick={onSignOut} title="Sign out" aria-label="Sign out">
          <LogOut size={18} />
        </button>
      </header>

      <div className="trainer-body">
        {!loading && words.length > 0 && (
          <section className="trainer-play">
            <div>
              <strong>Play a round</strong>
              <span>{highScore > 0 ? `Best ${highScore}` : "No score yet — go and set one"}</span>
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={startGame}
              // Leaving mid-take would throw the recording away; scoring one is worth waiting for.
              disabled={recordingWordId !== null || savingWordId !== null}
            >
              <Gamepad2 size={17} /> Play
            </button>
          </section>
        )}
        {!loading && (
          <section className={`trainer-today ${practice.dueToday ? "due" : "done"}`} aria-live="polite">
            <div className="trainer-today-day">
              <CalendarDays size={17} />
              <div>
                <strong>{formatDate(new Date().toISOString())}</strong>
                <span>{practice.dueToday ? "Today's word is not added yet" : "Today's word is added"}</span>
              </div>
            </div>
            <p className="trainer-today-note">
              {practice.dueToday
                ? idleDays === null
                  ? "Add the first word to start the streak. One new word every day."
                  : idleDays <= 1
                    ? `One word a day — add today's to keep the ${practice.streakDays}-day streak.`
                    : `${idleDays} days since the last word. Add one today to start again.`
                : `${practice.addedToday} today · ${practice.streakDays}-day streak`}
            </p>
            {practice.streakDays > 0 && !practice.dueToday && (
              <span className="trainer-streak"><Flame size={15} /> {practice.streakDays}</span>
            )}
          </section>
        )}

        <form className="trainer-add" onSubmit={(event) => void addWord(event)}>
          <h2>Add {kind === "word" ? "a word" : "a phrase"}</h2>
          <div className="trainer-kind" role="group" aria-label="What to add">
            <button
              type="button"
              className={kind === "word" ? "selected" : ""}
              onClick={() => chooseKind("word")}
              aria-pressed={kind === "word"}
            >
              Single word
            </button>
            <button
              type="button"
              className={kind === "phrase" ? "selected" : ""}
              onClick={() => chooseKind("phrase")}
              aria-pressed={kind === "phrase"}
            >
              Phrase
            </button>
          </div>
          <div className="trainer-add-fields">
            <label>
              English
              <input
                value={english}
                onChange={(event) => setEnglish(event.target.value)}
                placeholder={kind === "word" ? "hello" : "good morning"}
                maxLength={kind === "word" ? 64 : 200}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
            <span className="trainer-add-equals" aria-hidden="true">=</span>
            <label>
              <span className="trainer-field-label">
                Lithuanian
                {translating && (
                  <span className="trainer-translating" role="status">
                    <LoaderCircle className="spin" size={12} aria-hidden="true" /> translating
                  </span>
                )}
              </span>
              <input
                value={lithuanian}
                // Clearing the field by hand hands control back to the translator, so a suggestion
                // can be thrown away and asked for again without retyping the English.
                onChange={(event) => {
                  lithuanianEdited.current = event.target.value.trim().length > 0;
                  setLithuanian(event.target.value);
                }}
                placeholder={kind === "word" ? "labas" : "labas rytas"}
                maxLength={kind === "word" ? 64 : 200}
                aria-busy={translating}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
            <button
              className="primary-button trainer-add-submit"
              disabled={adding || !lithuanian.trim() || !english.trim()}
            >
              {adding ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} Add
            </button>
          </div>
          {phrases.length > 0 && (
            <div className="trainer-phrase-offers">
              <span className="trainer-phrase-lead">Say more with it:</span>
              {phrases.map((offer) => (
                <button
                  key={offer}
                  type="button"
                  className="trainer-phrase-offer"
                  onClick={() => choosePhrase(offer)}
                >
                  {offer}
                </button>
              ))}
            </div>
          )}
          <small>
            {kind === "word"
              ? "Type the English and the Lithuanian is written for you — change it if you know a better word. Only the Lithuanian side is practised."
              : `Type the English and the Lithuanian is written for you. Up to ${LITHUANIAN_MAX_PHRASE_WORDS} words. Every Lithuanian word gets its own hint so the phrase is not one long block.`}
          </small>
        </form>

        {!speechSupported && leansOnDeviceVoice && (
          <p className="trainer-warning" role="status">
            <CircleAlert size={16} /> This browser cannot speak words out loud, so only your own recordings will play.
          </p>
        )}
        {missingVoice && leansOnDeviceVoice && (
          <p className="trainer-warning" role="status">
            <CircleAlert size={16} /> No Lithuanian voice is installed, so words are read with the default voice.
          </p>
        )}
        {recordingBlocked && (
          <p className="trainer-warning" role="status">
            <CircleAlert size={16} /> {recordingBlocked}
          </p>
        )}
        {recordingSupported && !scoringSupported && (
          <p className="trainer-warning" role="status">
            <CircleAlert size={16} /> This browser cannot check pronunciation, so recordings are saved without a score.
          </p>
        )}
        {error && <p className="trainer-error" role="alert">{error}</p>}
        {notice && <p className="trainer-notice" role="status">{notice}</p>}

        {loading ? (
          <div className="trainer-loading"><LoaderCircle className="spin" size={22} /> Loading your words…</div>
        ) : words.length === 0 ? (
          <div className="trainer-empty">
            <Languages size={28} />
            <strong>No words yet</strong>
            <p>Add a Lithuanian word and its English meaning to start practising.</p>
          </div>
        ) : (
          <ul className="trainer-words">
            {words.map((word) => {
              const isRecording = recordingWordId === word.id;
              const isSaving = savingWordId === word.id;
              const best = bestScore(word.recordings);
              return (
                <li key={word.id} className="trainer-card">
                  <div className="trainer-card-head">
                    <time className="trainer-card-date" dateTime={word.createdAt}>
                      <CalendarDays size={14} /> Added {formatDate(word.createdAt)}
                    </time>
                    {word.kind === "phrase" && <span className="trainer-kind-tag">Phrase</span>}
                    {best !== null && (
                      <span className={`trainer-best ${best >= passMark ? "pass" : "fail"}`}>
                        {best >= passMark ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
                        Best {best}%
                      </span>
                    )}
                  </div>

                  <div className="trainer-word trainer-word-lt">
                    <div className="trainer-word-text">
                      <span className="trainer-word-label">Lithuanian</span>
                      <strong lang={LITHUANIAN_LOCALE}><SpelledWord text={word.lithuanian} /></strong>
                    </div>
                    <div className="trainer-word-actions">
                      <button
                        type="button"
                        className="trainer-action"
                        onClick={() => void pronounce(word)}
                        // A word the server can say needs no voice on this device at all.
                        disabled={(!speechSupported && !word.hasPronunciation) || isRecording}
                        title={`Listen to ${word.lithuanian}`}
                        aria-label={`Listen to ${word.lithuanian}`}
                      >
                        <Volume2 size={18} /> Listen
                      </button>
                      <button
                        type="button"
                        className={`trainer-action ${isRecording ? "recording" : ""}`}
                        onClick={() => void toggleRecording(word)}
                        disabled={!recordingSupported || isSaving || (recordingWordId !== null && !isRecording)}
                        aria-label={isRecording
                          ? `Stop recording ${word.lithuanian}`
                          : `Record ${word.lithuanian}`}
                      >
                        {isSaving
                          ? <><LoaderCircle className="spin" size={18} /> Scoring</>
                          : isRecording
                            ? <><Square size={18} /> Stop</>
                            : <><Mic size={18} /> Record</>}
                      </button>
                    </div>
                  </div>

                  <p className="trainer-meaning"><span>Means</span> {word.english}</p>

                  {specialLetters(word.lithuanian).length > 0 && (
                    <ul className="trainer-letters" aria-label="Letters English does not have">
                      {specialLetters(word.lithuanian).map((letter) => (
                        <li key={letter.text}>
                          <em className="trainer-letter" lang={LITHUANIAN_LOCALE}>{letter.text}</em>
                          <span>{letter.note}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {word.kind === "phrase" && (
                    word.hints.length > 0 ? (
                      <ul className="trainer-hints">
                        {word.hints.map((hint, index) => (
                          <li key={`${hint.word}-${index}`}>
                            <button
                              type="button"
                              className="trainer-hint-word"
                              onClick={() => sayWithDeviceVoice(hint.word)}
                              disabled={!speechSupported || isRecording}
                              aria-label={`Listen to ${hint.word} on its own`}
                            >
                              <Volume2 size={14} />
                              <span lang={LITHUANIAN_LOCALE}>{hint.word}</span>
                            </button>
                            <div className="trainer-hint-text">
                              <strong>{hint.meaning}</strong>
                              {hint.tip && <span>{hint.tip}</span>}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <button
                        type="button"
                        className="text-button trainer-hint-build"
                        onClick={() => void regenerateHints(word)}
                        disabled={hintingId === word.id}
                      >
                        {hintingId === word.id
                          ? <><LoaderCircle className="spin" size={15} /> Building hints</>
                          : <><Lightbulb size={15} /> Explain word by word</>}
                      </button>
                    )
                  )}

                  {/* A word added before the server could say them, or before a key was
                      configured, is stuck on this device's voice until it is said once. */}
                  {!word.hasPronunciation && (
                    <button
                      type="button"
                      className="text-button trainer-say-build"
                      onClick={() => void regeneratePronunciation(word)}
                      disabled={sayingId === word.id}
                    >
                      {sayingId === word.id
                        ? <><LoaderCircle className="spin" size={15} /> Saying it</>
                        : <><Volume2 size={15} /> Say it properly on every device</>}
                    </button>
                  )}

                  {word.recordings.length > 0 && (
                    <ul className="trainer-takes">
                      {word.recordings.map((recording) => (
                        <li key={recording.id}>
                          <button
                            type="button"
                            className="trainer-take-play"
                            onClick={() => void play(recording.id)}
                            disabled={busyId === recording.id}
                            aria-label={`Play the recording from ${formatDateTime(recording.recordedAt)}`}
                          >
                            {busyId === recording.id ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
                          </button>
                          <span className={`trainer-take-score ${recording.score === null
                            ? "unscored"
                            : recording.passed ? "pass" : "fail"}`}>
                            {recording.score === null
                              ? "Not scored"
                              : `${recording.score}% ${recording.passed ? "pass" : "fail"}`}
                          </span>
                          <time dateTime={recording.recordedAt}>{formatDateTime(recording.recordedAt)}</time>
                          <button
                            type="button"
                            className="icon-button subtle"
                            onClick={() => void removeRecording(word.id, recording.id)}
                            disabled={busyId === recording.id}
                            title="Delete recording"
                            aria-label={`Delete the recording from ${formatDateTime(recording.recordedAt)}`}
                          >
                            <Trash2 size={15} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <button
                    type="button"
                    className="text-button trainer-remove-word"
                    onClick={() => void removeWord(word)}
                    disabled={busyId === word.id}
                  >
                    <Trash2 size={15} /> Remove word
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <audio ref={audio} hidden />
    </main>
  );
}
