import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Flame, Heart, LoaderCircle, Trophy, Volume2, X } from "lucide-react";
import { LITHUANIAN_LOCALE, type LithuanianWord } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { SILENT_CLIP, speak, stopSpeaking } from "../lib/pronunciation.js";
import {
  GAME_LIVES,
  GAME_QUESTION_MS,
  type GameQuestion,
  answerMatches,
  buildRound,
  multiplierFor,
  pointsFor
} from "../lib/lithuanianGame.js";

/** How often the clock is redrawn. Fine enough to look continuous, coarse enough to be cheap. */
const TickMs = 100;

/** How long a right or wrong answer is shown before the next question. */
const VerdictMs = 900;

interface Verdict {
  correct: boolean;
  answer: string;
  points: number;
}

/**
 * The practice game.
 *
 * A round of questions drawn from Lucas's own words, against a clock, with three lives and a
 * combo that pays for a streak. It exists because one word a day is a habit that needs a reason
 * to come back, and a score he wants to beat is a better reason than a list he has already read.
 *
 * The game never adds, edits or deletes a word: it only asks about what is already there, so a
 * bad round costs nothing but the round.
 */
export function LithuanianGameView({
  api,
  words,
  bestScore,
  onFinished,
  onClose
}: {
  api: ApiClient;
  words: LithuanianWord[];
  bestScore: number;
  /** Reports the new best so the screen behind can show it without reloading. */
  onFinished: (best: number) => void;
  onClose: () => void;
}) {
  const [round] = useState<GameQuestion[]>(() => buildRound(words));
  const [index, setIndex] = useState(0);
  const [lives, setLives] = useState(GAME_LIVES);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [msLeft, setMsLeft] = useState(GAME_QUESTION_MS);
  const [typed, setTyped] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [over, setOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [best, setBest] = useState(bestScore);
  const [record, setRecord] = useState(false);

  const player = useRef<HTMLAudioElement | null>(null);
  const clips = useRef(new Map<string, string>());
  const audioUnlocked = useRef(false);
  const spoken = useMemo(
    () => new Map(words.map((entry) => [entry.id, entry.hasPronunciation])),
    [words]
  );

  const question = round[index] ?? null;
  const answered = verdict !== null;
  const finished = over || round.length === 0;

  // Held in a ref as well so the timer can end a game without being torn down and rebuilt on
  // every tick, which would keep restarting the clock it is trying to run down.
  const state = useRef({ score: 0, bestCombo: 0 });
  state.current = { score, bestCombo };

  const finish = useCallback(async () => {
    setOver(true);
    stopSpeaking();
    setSaving(true);
    try {
      const result = await api.saveLithuanianGame({
        score: state.current.score,
        bestCombo: state.current.bestCombo
      });
      setBest(result.bestScore);
      setRecord(result.record);
      onFinished(result.bestScore);
    } catch {
      // A score that could not be saved still gets shown; it is a game, not a record to defend.
      setBest((current) => Math.max(current, state.current.score));
    } finally {
      setSaving(false);
    }
  }, [api, onFinished]);

  const settle = useCallback((correct: boolean, remaining: number) => {
    if (!question) return;
    const points = correct ? pointsFor(remaining, combo) : 0;
    setVerdict({ correct, answer: question.answer, points });
    if (correct) {
      setScore((current) => current + points);
      setCombo((current) => {
        const next = current + 1;
        setBestCombo((highest) => Math.max(highest, next));
        return next;
      });
    } else {
      setCombo(0);
      setLives((current) => current - 1);
    }
  }, [combo, question]);

  // The clock. Runs only while a question is live: it is stopped once an answer is in, so the
  // verdict is readable without the timer running out underneath it.
  useEffect(() => {
    if (!question || answered || finished) return;
    setMsLeft(GAME_QUESTION_MS);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const remaining = GAME_QUESTION_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        window.clearInterval(timer);
        setMsLeft(0);
        settle(false, 0);
        return;
      }
      setMsLeft(remaining);
    }, TickMs);
    return () => window.clearInterval(timer);
  }, [question, answered, finished, settle]);

  // Moves on once the verdict has been read: to the next question, or to the end of the game when
  // the lives or the questions run out.
  useEffect(() => {
    if (!answered) return;
    const timer = window.setTimeout(() => {
      setVerdict(null);
      setTyped("");
      if (lives <= 0 || index + 1 >= round.length) void finish();
      else setIndex((current) => current + 1);
    }, VerdictMs);
    return () => window.clearTimeout(timer);
  }, [answered, lives, index, round.length, finish]);

  useEffect(() => {
    const urls = clips.current;
    return () => {
      stopSpeaking();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  /**
   * Says the word being asked about, preferring the server's recording for the same reason the
   * word list does: the browser's own voice only says Lithuanian properly on a device that has a
   * Lithuanian voice installed. Playing synthesis here would put back exactly the wrong-language
   * pronunciation the cached audio exists to avoid.
   */
  const say = useCallback(async (question: GameQuestion) => {
    if (!spoken.get(question.wordId)) {
      speak(question.lithuanian, LITHUANIAN_LOCALE);
      return;
    }
    const element = player.current;
    let url = clips.current.get(question.wordId);
    // Claims playback permission while the tap is still live, as the word list does.
    if (element && !url && !audioUnlocked.current) {
      audioUnlocked.current = true;
      element.src = SILENT_CLIP;
      void Promise.resolve(element.play()).catch(() => { audioUnlocked.current = false; });
    }
    try {
      if (!url) {
        url = URL.createObjectURL(await api.lithuanianPronunciationBlob(question.wordId));
        clips.current.set(question.wordId, url);
      }
      if (!element) return;
      element.src = url;
      await element.play();
    } catch {
      speak(question.lithuanian, LITHUANIAN_LOCALE);
    }
  }, [api, spoken]);

  const answer = (choice: string) => {
    if (answered || !question) return;
    settle(answerMatches(choice, question.answer), msLeft);
  };

  const submitTyped = (event: FormEvent) => {
    event.preventDefault();
    if (answered || !question) return;
    settle(answerMatches(typed, question.answer), msLeft);
  };

  const clock = Math.max(0, Math.min(100, (msLeft / GAME_QUESTION_MS) * 100));
  const multiplier = useMemo(() => multiplierFor(combo), [combo]);

  if (round.length === 0) {
    return (
      <div className="game" role="dialog" aria-label="Practice game">
        <div className="game-empty">
          <h2>Nothing to play with yet</h2>
          <p>Add a word first, then the game has something to ask about.</p>
          <button type="button" className="primary-button" onClick={onClose}>Back to the words</button>
        </div>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="game" role="dialog" aria-label="Game over">
        <div className="game-over">
          <Trophy size={38} className={record ? "game-trophy-won" : ""} aria-hidden="true" />
          <h2>{record ? "New best score!" : "Game over"}</h2>
          <p className="game-final" aria-live="polite">{score}</p>
          <p className="game-best">
            {saving ? <><LoaderCircle className="spin" size={14} /> Saving…</> : `Best ${best}`}
          </p>
          <p className="game-summary">
            Longest streak {bestCombo} · {round.length} question{round.length === 1 ? "" : "s"}
          </p>
          <button type="button" className="primary-button" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="game" role="dialog" aria-label="Practice game">
      {/* One element reused for every clip: browsers grant playback permission per element. */}
      <audio ref={player} hidden />
      <header className="game-bar">
        <button type="button" className="game-quit" onClick={onClose} aria-label="Leave the game">
          <X size={18} />
        </button>
        <span className="game-lives" aria-label={`${lives} lives left`}>
          {Array.from({ length: GAME_LIVES }, (_, life) => (
            <Heart key={life} size={17} className={life < lives ? "game-life" : "game-life-lost"} />
          ))}
        </span>
        <span className="game-score" aria-live="off">{score}</span>
        {combo > 1 && (
          <span className="game-combo"><Flame size={14} /> ×{multiplier}</span>
        )}
      </header>

      <div
        className={`game-clock ${clock < 30 ? "urgent" : ""}`}
        role="progressbar"
        aria-label="Time left"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clock)}
      >
        <span style={{ width: `${clock}%` }} />
      </div>

      <p className="game-progress">Question {index + 1} of {round.length}</p>

      <div className="game-question">
        <span className="game-ask">
          {question!.kind === "meaning"
            ? "What does this mean?"
            : question!.kind === "word"
              ? "How do you say this?"
              : "Spell it in Lithuanian"}
        </span>
        <strong
          className="game-prompt"
          lang={question!.promptIsLithuanian ? LITHUANIAN_LOCALE : "en"}
        >
          {question!.prompt}
        </strong>
        {question!.promptIsLithuanian && (
          <button
            type="button"
            className="game-listen"
            onClick={() => void say(question!)}
            aria-label={`Listen to ${question!.lithuanian}`}
          >
            <Volume2 size={16} /> Listen
          </button>
        )}
      </div>

      {question!.choices.length > 0 ? (
        <div className="game-choices">
          {question!.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className={`game-choice ${answered && choice === question!.answer ? "right" : ""} ${
                answered && verdict && !verdict.correct && choice !== question!.answer ? "dimmed" : ""
              }`}
              onClick={() => answer(choice)}
              disabled={answered}
              lang={question!.promptIsLithuanian ? "en" : LITHUANIAN_LOCALE}
            >
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <form className="game-spell" onSubmit={submitTyped}>
          <label>
            <span className="visually-hidden">Spell it in Lithuanian</span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="type it"
              lang={LITHUANIAN_LOCALE}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={answered}
              autoFocus
            />
          </label>
          <button type="submit" className="primary-button" disabled={answered || !typed.trim()}>
            Check
          </button>
        </form>
      )}

      {verdict && (
        <p className={`game-verdict ${verdict.correct ? "right" : "wrong"}`} role="status">
          {verdict.correct
            ? `Correct  +${verdict.points}`
            : `It was ${verdict.answer}`}
        </p>
      )}
    </div>
  );
}
