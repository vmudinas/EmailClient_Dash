import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Shared plumbing for the app's periodic refreshes.
 *
 * These loops used to be five hand-rolled setInterval blocks with hardcoded intervals and no
 * visibility. That made them impossible to reason about when the server was under load: the
 * import-jobs loop polls roughly forty times a minute while a job runs, and the review queue
 * reads a hundred message bodies on every pass, both of which land on the same contended
 * disks as an in-flight import. Routing them through one hook gives the admin screen a live
 * view and a way to slow a loop down or stop it.
 */

export interface PollingLoopConfig {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  intervalMs: number;
  defaultIntervalMs: number;
  activeIntervalMs: number | null;
  defaultActiveIntervalMs: number | null;
  activeLabel: string | null;
  customized: boolean;
}

export interface PollingSettings {
  minimumIntervalMs: number;
  maximumIntervalMs: number;
  loops: PollingLoopConfig[];
}

export interface PollingLoopStatus {
  key: string;
  /** False when the loop's own preconditions aren't met (panel closed, no session, ...). */
  mounted: boolean;
  running: boolean;
  /** The interval currently in effect, which may be the busy rate. */
  effectiveIntervalMs: number | null;
  usingActiveInterval: boolean;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
  nextRunAt: number | null;
}

export type PollingStatusMap = Record<string, PollingLoopStatus>;

export type PollingReporter = (
  key: string,
  update: Partial<PollingLoopStatus> | ((previous: PollingLoopStatus) => Partial<PollingLoopStatus>)
) => void;

/**
 * Client-side mirror of the server catalog's intervals. Used before the admin settings have
 * loaded, and for non-admin sessions that cannot read them at all. Without this a missing
 * config would fall back to the global minimum and turn every loop into a 1s poll -- the
 * exact opposite of what this feature is for.
 */
export const BUILT_IN_INTERVALS: Record<string, { intervalMs: number; activeIntervalMs: number | null }> = {
  importJobs: { intervalMs: 15_000, activeIntervalMs: 1_500 },
  gmailConnections: { intervalMs: 1_500, activeIntervalMs: null },
  reviewQueue: { intervalMs: 30_000, activeIntervalMs: null },
  stockQuotes: { intervalMs: 60_000, activeIntervalMs: null },
  newsHeadlines: { intervalMs: 600_000, activeIntervalMs: null }
};

export const DEFAULT_POLLING_SETTINGS: PollingSettings = {
  minimumIntervalMs: 1_000,
  maximumIntervalMs: 3_600_000,
  loops: []
};

function emptyStatus(key: string): PollingLoopStatus {
  return {
    key,
    mounted: false,
    running: false,
    effectiveIntervalMs: null,
    usingActiveInterval: false,
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
    runCount: 0,
    errorCount: 0,
    nextRunAt: null
  };
}

/** Collects live status from every mounted loop so the admin screen can render it. */
export function usePollingRegistry() {
  const [statuses, setStatuses] = useState<PollingStatusMap>({});
  const report = useCallback<PollingReporter>((key, update) => {
    setStatuses((current) => {
      const previous = current[key] ?? emptyStatus(key);
      const patch = typeof update === "function" ? update(previous) : update;
      return { ...current, [key]: { ...previous, ...patch, key } };
    });
  }, []);
  return { statuses, report };
}

export interface UsePollingLoopOptions {
  key: string;
  /** The work to repeat. Errors are recorded rather than thrown, so one failure can't kill the loop. */
  run: () => Promise<unknown> | unknown;
  settings: PollingSettings;
  report: PollingReporter;
  /** When false the loop is torn down entirely (no session, panel closed, read-only, ...). */
  active: boolean;
  /** Selects the faster rate, for loops that declare one — e.g. an import actually running. */
  busy?: boolean;
  /** Run once as soon as the loop becomes active, before waiting out the first interval. */
  runImmediately?: boolean;
}

export function resolveIntervalMs(
  config: PollingLoopConfig | undefined,
  key: string,
  busy: boolean
): number {
  if (!config) {
    const builtIn = BUILT_IN_INTERVALS[key];
    if (!builtIn) return 60_000;
    return busy && builtIn.activeIntervalMs ? builtIn.activeIntervalMs : builtIn.intervalMs;
  }
  if (busy && config.activeIntervalMs) return config.activeIntervalMs;
  return config.intervalMs;
}

export function usePollingLoop({
  key,
  run,
  settings,
  report,
  active,
  busy = false,
  runImmediately = true
}: UsePollingLoopOptions) {
  const config = useMemo(
    () => settings.loops.find((entry) => entry.key === key),
    [settings, key]
  );
  // Keeping the callback in a ref lets the effect depend only on scheduling inputs. Without
  // it a caller passing an inline function would tear down and restart the timer on every
  // render, which for the 1.5s import loop means it effectively never waits.
  const runRef = useRef(run);
  runRef.current = run;
  const reportRef = useRef(report);
  reportRef.current = report;

  const enabled = config ? config.enabled : true;
  const intervalMs = resolveIntervalMs(config, key, busy);
  const usingActiveInterval = Boolean(
    busy && (config ? config.activeIntervalMs : BUILT_IN_INTERVALS[key]?.activeIntervalMs)
  );

  useEffect(() => {
    if (!active || !enabled) {
      reportRef.current(key, {
        mounted: active,
        running: false,
        effectiveIntervalMs: null,
        nextRunAt: null,
        usingActiveInterval: false
      });
      return;
    }

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const startedAt = Date.now();
      reportRef.current(key, { running: true });
      try {
        await runRef.current();
        if (cancelled) return;
        reportRef.current(key, (previous) => ({
          running: false,
          lastRunAt: startedAt,
          lastDurationMs: Date.now() - startedAt,
          lastError: null,
          runCount: previous.runCount + 1,
          nextRunAt: Date.now() + intervalMs
        }));
      } catch (error) {
        if (cancelled) return;
        reportRef.current(key, (previous) => ({
          running: false,
          lastRunAt: startedAt,
          lastDurationMs: Date.now() - startedAt,
          lastError: error instanceof Error ? error.message : String(error),
          runCount: previous.runCount + 1,
          errorCount: previous.errorCount + 1,
          nextRunAt: Date.now() + intervalMs
        }));
      }
    };

    reportRef.current(key, {
      mounted: true,
      effectiveIntervalMs: intervalMs,
      usingActiveInterval,
      nextRunAt: Date.now() + intervalMs
    });
    if (runImmediately) void tick();
    const timer = window.setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key, active, enabled, intervalMs, usingActiveInterval, runImmediately]);

}

export function formatInterval(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes} min` : `${minutes.toFixed(1)} min`;
}

export function formatSince(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return "never";
  const delta = Math.max(0, now - timestamp);
  if (delta < 1_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  return `${Math.floor(delta / 3_600_000)} hr ago`;
}
