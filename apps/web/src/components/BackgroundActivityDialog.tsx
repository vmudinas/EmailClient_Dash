import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Pause, Play, RotateCcw } from "lucide-react";
import {
  formatInterval,
  formatSince,
  type PollingLoopConfig,
  type PollingSettings,
  type PollingStatusMap
} from "../lib/polling";

export interface BackgroundActivityDialogProps {
  open: boolean;
  onClose: () => void;
  settings: PollingSettings;
  statuses: PollingStatusMap;
  /** Persists one loop's overrides. Rejections surface inline rather than as a toast. */
  onUpdate: (key: string, patch: { enabled?: boolean; intervalMs?: number; activeIntervalMs?: number }) => Promise<void>;
  readOnly?: boolean;
}

function secondsValue(ms: number): string {
  const seconds = ms / 1_000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

export function BackgroundActivityDialog({
  open,
  onClose,
  settings,
  statuses,
  onUpdate,
  readOnly = false
}: BackgroundActivityDialogProps) {
  // Re-render on a timer so "3s ago" and the countdown stay honest while the dialog sits open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (!open) return null;

  const apply = async (key: string, patch: { enabled?: boolean; intervalMs?: number; activeIntervalMs?: number }) => {
    setBusyKey(key);
    setError("");
    try {
      await onUpdate(key, patch);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The change could not be saved");
    } finally {
      setBusyKey(null);
    }
  };

  const renderLoop = (loop: PollingLoopConfig) => {
    const status = statuses[loop.key];
    const pending = busyKey === loop.key;
    const countdown = status?.nextRunAt ? Math.max(0, status.nextRunAt - now) : null;

    return (
      <li key={loop.key} className={`polling-loop${loop.enabled ? "" : " polling-loop-paused"}`}>
        <div className="polling-loop-header">
          <div>
            <h4>{loop.label}</h4>
            <p className="polling-loop-description">{loop.description}</p>
          </div>
          <button
            type="button"
            className="secondary-button polling-toggle"
            disabled={pending || readOnly}
            aria-label={loop.enabled ? `Pause ${loop.label}` : `Resume ${loop.label}`}
            onClick={() => void apply(loop.key, { enabled: !loop.enabled })}
          >
            {loop.enabled ? <Pause size={14} /> : <Play size={14} />}
            {loop.enabled ? "Pause" : "Resume"}
          </button>
        </div>

        <dl className="polling-loop-stats">
          <div>
            <dt>Status</dt>
            <dd>
              {!loop.enabled
                ? "Paused"
                : status?.running
                  ? "Running now"
                  : status?.mounted
                    ? countdown === null ? "Scheduled" : `Next in ${Math.ceil(countdown / 1_000)}s`
                    : "Idle (not needed right now)"}
            </dd>
          </div>
          <div>
            <dt>Last run</dt>
            <dd>{formatSince(status?.lastRunAt ?? null, now)}</dd>
          </div>
          <div>
            <dt>Last duration</dt>
            <dd>{status?.lastDurationMs === undefined || status?.lastDurationMs === null ? "—" : `${status.lastDurationMs} ms`}</dd>
          </div>
          <div>
            <dt>Runs</dt>
            <dd>
              {status?.runCount ?? 0}
              {(status?.errorCount ?? 0) > 0 && <span className="polling-error-count"> · {status?.errorCount} failed</span>}
            </dd>
          </div>
        </dl>

        {status?.lastError && (
          <p className="polling-loop-error">
            <AlertTriangle size={14} /> {status.lastError}
          </p>
        )}

        <div className="polling-loop-controls">
          <label>
            <span>Every</span>
            <input
              type="number"
              min={settings.minimumIntervalMs / 1_000}
              max={settings.maximumIntervalMs / 1_000}
              step="0.5"
              defaultValue={secondsValue(loop.intervalMs)}
              disabled={pending || readOnly}
              aria-label={`${loop.label} interval in seconds`}
              onBlur={(event) => {
                const seconds = Number(event.target.value);
                if (!Number.isFinite(seconds)) return;
                const intervalMs = Math.round(seconds * 1_000);
                if (intervalMs === loop.intervalMs) return;
                void apply(loop.key, { intervalMs });
              }}
            />
            <span>seconds</span>
          </label>

          {loop.activeIntervalMs !== null && (
            <label>
              <span>{loop.activeLabel ?? "While busy"}</span>
              <input
                type="number"
                min={settings.minimumIntervalMs / 1_000}
                max={settings.maximumIntervalMs / 1_000}
                step="0.5"
                defaultValue={secondsValue(loop.activeIntervalMs)}
                disabled={pending || readOnly}
                aria-label={`${loop.label} busy interval in seconds`}
                onBlur={(event) => {
                  const seconds = Number(event.target.value);
                  if (!Number.isFinite(seconds)) return;
                  const activeIntervalMs = Math.round(seconds * 1_000);
                  if (activeIntervalMs === loop.activeIntervalMs) return;
                  void apply(loop.key, { activeIntervalMs });
                }}
              />
              <span>seconds</span>
            </label>
          )}

          {loop.customized && !readOnly && (
            <button
              type="button"
              className="link-button"
              disabled={pending}
              onClick={() => void apply(loop.key, {
                enabled: true,
                intervalMs: loop.defaultIntervalMs,
                ...(loop.defaultActiveIntervalMs !== null ? { activeIntervalMs: loop.defaultActiveIntervalMs } : {})
              })}
            >
              <RotateCcw size={13} /> Reset to default
              {" "}({formatInterval(loop.defaultIntervalMs)})
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog polling-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Background activity"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h3><Activity size={18} /> Background activity</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>

        <p className="dialog-intro">
          These refreshes run in every open browser tab, so their cost lands on the server whether
          or not you are looking at the result. Slowing one down, or pausing it, is the quickest way
          to give a busy import room to work.
        </p>

        {error && <p className="dialog-error" role="alert">{error}</p>}

        {settings.loops.length === 0
          ? <p className="dialog-empty">No background refreshes are registered.</p>
          : <ul className="polling-loop-list">{settings.loops.map(renderLoop)}</ul>}
      </div>
    </div>
  );
}
