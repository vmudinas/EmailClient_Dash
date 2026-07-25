import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Small persistence layer over localStorage, so a reload does not start from a blank screen.
 *
 * The API client's cache ({@link ../lib/api.ts}) lives in memory and dies with the page, so
 * every refresh currently refetches everything before anything renders. That is most painful
 * exactly when the server is busy. Persisting a little state lets the shell draw immediately
 * and then correct itself once fresh data arrives.
 *
 * WHAT BELONGS HERE: navigation position, view preferences, and small structural lists
 * (archives, folders) that make the shell render.
 *
 * WHAT MUST NOT: message bodies, search results, attachment text, draft contents, anything
 * from a payment or property record, and any credential or token. This is an email archive on
 * a machine that may be shared, localStorage has no expiry of its own, and it is readable by
 * any script on the origin. Persisted values also survive logout unless explicitly cleared,
 * which is why every key is scoped to a user id and dropped by {@link clearPersistedScope}.
 */

const NAMESPACE = "archive-mail";

/**
 * Bumped when a stored shape changes incompatibly. Entries written under an older version are
 * ignored and overwritten rather than parsed, so a deploy cannot resurrect a stale shape.
 */
export const PERSISTENCE_VERSION = 1;

export interface PersistedEnvelope<T> {
  version: number;
  savedAt: number;
  value: T;
}

export interface PersistOptions {
  /** Discard anything older than this. Omit to keep until explicitly cleared. */
  maxAgeMs?: number;
  /** Usually the signed-in user id, so one account never reads another's state. */
  scope?: string;
}

function storage(): Storage | null {
  try {
    // Access can throw outright in private-browsing modes and sandboxed iframes, so this is
    // probed rather than assumed.
    const probe = window.localStorage;
    const key = `${NAMESPACE}:probe`;
    probe.setItem(key, "1");
    probe.removeItem(key);
    return probe;
  } catch {
    return null;
  }
}

export function persistenceKey(key: string, scope?: string): string {
  return `${NAMESPACE}:v${PERSISTENCE_VERSION}:${scope ?? "shared"}:${key}`;
}

export function readPersisted<T>(key: string, options: PersistOptions = {}): T | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(persistenceKey(key, options.scope));
  if (raw === null) return null;
  try {
    const envelope = JSON.parse(raw) as PersistedEnvelope<T>;
    if (!envelope || typeof envelope !== "object") return null;
    if (envelope.version !== PERSISTENCE_VERSION) return null;
    if (options.maxAgeMs !== undefined && Date.now() - envelope.savedAt > options.maxAgeMs) {
      store.removeItem(persistenceKey(key, options.scope));
      return null;
    }
    return envelope.value;
  } catch {
    // Corrupt or hand-edited entry. Drop it rather than letting it break every load.
    store.removeItem(persistenceKey(key, options.scope));
    return null;
  }
}

export function writePersisted<T>(key: string, value: T, options: PersistOptions = {}): boolean {
  const store = storage();
  if (!store) return false;
  const envelope: PersistedEnvelope<T> = {
    version: PERSISTENCE_VERSION,
    savedAt: Date.now(),
    value
  };
  try {
    store.setItem(persistenceKey(key, options.scope), JSON.stringify(envelope));
    return true;
  } catch {
    // Quota exceeded, or a value that will not serialise. Persistence is an optimisation, so
    // failing to save must never surface to the user or interrupt a render.
    return false;
  }
}

export function removePersisted(key: string, options: PersistOptions = {}): void {
  storage()?.removeItem(persistenceKey(key, options.scope));
}

/** Drops every entry for one scope. Call on sign-out and when the signed-in user changes. */
export function clearPersistedScope(scope?: string): void {
  const store = storage();
  if (!store) return;
  const prefix = `${NAMESPACE}:v${PERSISTENCE_VERSION}:${scope ?? "shared"}:`;
  for (const key of Object.keys(store).filter((candidate) => candidate.startsWith(prefix))) {
    store.removeItem(key);
  }
}

/** Drops entries written by superseded versions, and by scopes other than the one given. */
export function pruneForeignPersistence(activeScope?: string): number {
  const store = storage();
  if (!store) return 0;
  const keep = `${NAMESPACE}:v${PERSISTENCE_VERSION}:${activeScope ?? "shared"}:`;
  const owned = Object.keys(store).filter((key) => key.startsWith(`${NAMESPACE}:`));
  let removed = 0;
  for (const key of owned) {
    if (key.startsWith(keep)) continue;
    store.removeItem(key);
    removed += 1;
  }
  return removed;
}

/**
 * useState that survives a reload. The initial render already has the stored value, so there
 * is no blank first paint followed by a correction.
 */
export function usePersistentState<T>(
  key: string,
  initialValue: T,
  options: PersistOptions = {}
): [T, (value: T | ((previous: T) => T)) => void] {
  const { maxAgeMs, scope } = options;
  const [state, setState] = useState<T>(() => {
    const stored = readPersisted<T>(key, { maxAgeMs, scope });
    return stored === null ? initialValue : stored;
  });

  // Re-read when the scope changes, so switching accounts does not carry state across.
  const scopeRef = useRef(scope);
  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    const stored = readPersisted<T>(key, { maxAgeMs, scope });
    setState(stored === null ? initialValue : stored);
    // initialValue is intentionally excluded: callers pass literals, and depending on it would
    // reset state on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, key, maxAgeMs]);

  const update = useCallback((value: T | ((previous: T) => T)) => {
    setState((previous) => {
      const next = typeof value === "function" ? (value as (previous: T) => T)(previous) : value;
      writePersisted(key, next, { maxAgeMs, scope });
      return next;
    });
  }, [key, maxAgeMs, scope]);

  return [state, update];
}

/**
 * Stale-while-revalidate: render whatever was stored, then replace it with fresh data.
 *
 * Returns `stale: true` while showing a persisted value that has not yet been confirmed, so
 * the UI can mark it rather than presenting old data as current.
 */
export interface HydratedResource<T> {
  value: T;
  stale: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useHydratedResource<T>(
  key: string,
  fallback: T,
  load: (() => Promise<T>) | null,
  options: PersistOptions = {}
): HydratedResource<T> {
  const { maxAgeMs, scope } = options;
  const [value, setValue] = useState<T>(() => readPersisted<T>(key, { maxAgeMs, scope }) ?? fallback);
  const [stale, setStale] = useState<boolean>(() => readPersisted<T>(key, { maxAgeMs, scope }) !== null);
  const [error, setError] = useState<string | null>(null);

  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    if (!loadRef.current) return;
    try {
      const fresh = await loadRef.current();
      setValue(fresh);
      setStale(false);
      setError(null);
      writePersisted(key, fresh, { maxAgeMs, scope });
    } catch (failure) {
      // Keep showing the persisted value: stale data beats an empty screen, as long as the
      // caller can tell the difference.
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [key, maxAgeMs, scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { value, stale, error, refresh };
}
