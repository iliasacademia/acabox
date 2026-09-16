import { useEffect, useSyncExternalStore } from 'react';
import type { PublishedInfo } from '../shared/share';

/**
 * Renderer-side cache of "is this tool/file published, and is the published
 * copy stale" — read by the tool header chip, the Tools page sharing block,
 * and the Files tab (U3-U6), and refreshed in place by the publish dialog
 * after a publish/unpublish.
 *
 * Same `useSyncExternalStore` shape as `toolStatusStore.ts`: a module-level
 * cache keyed by a string, one `listeners` set driving every subscriber, and
 * a snapshot getter that must return the *same object reference* for a key
 * that hasn't changed — otherwise every consumer re-renders on every write to
 * any other key. The cache is keyed `app:<dirName>` / `file:<filePath>` so
 * the two kinds can never collide.
 *
 * Unlike `toolStatusStore`, this store also owns fetching: a key's first use
 * (by either hook, or by `refreshToolShare`) triggers exactly one
 * `window.shareAPI.statusApp`/`statusFile` call, and a single lazy
 * subscription to `window.shareAPI.onChanged` keeps every previously-used key
 * fresh. There is no polling — the host is the one thing that knows when a
 * publish/unpublish happened, and it says so via that event.
 */

export interface ToolShareState {
  published: PublishedInfo | null;
  behind: boolean;
  loading: boolean;
}

/** Shared, frozen — safe to hand out to any number of idle keys. */
const IDLE_STATE: ToolShareState = { published: null, behind: false, loading: false };

/**
 * What a key nobody has fetched yet reads as. It MUST say `loading: true`:
 * the first `useToolShare` render happens before its own mount effect starts
 * the fetch, and if that render reported `loading: false` with `published:
 * null` it would be indistinguishable from a confirmed "not shared". The
 * publish dialog once worked around that with a latch that waited to observe
 * a true→false transition — which then never came when a sibling chip had
 * already warmed the key (found by U5's composed test). Unknown means
 * loading; only a settled fetch may say otherwise.
 */
const UNKNOWN_STATE: ToolShareState = { published: null, behind: false, loading: true };

type StatusResult = { published: PublishedInfo | null; behind: boolean };
type Fetcher = () => Promise<StatusResult>;

const cache = new Map<string, ToolShareState>();
const listeners = new Set<() => void>();

let onChangedSubscribed = false;
let unsubscribeOnChanged: (() => void) | null = null;

function appKey(dirName: string): string {
  return `app:${dirName}`;
}

function fileKey(filePath: string): string {
  return `file:${filePath}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Lazily wires the single `onChanged` subscription. Idempotent — safe to call
 * from every fetch site. An event only ever refetches a key already in the
 * cache: a dirName/filePath nobody has asked about yet is none of this
 * store's business, and fetching it would mean caching state a `useToolShare`
 * caller can never see load (nothing is subscribed to a key until a hook or
 * `refreshToolShare` asks for it).
 */
function ensureOnChangedSubscribed(): void {
  if (onChangedSubscribed) return;
  onChangedSubscribed = true;
  unsubscribeOnChanged = window.shareAPI.onChanged((evt) => {
    if (evt.dirName !== undefined) {
      const dirName = evt.dirName;
      const key = appKey(dirName);
      if (cache.has(key)) void runFetch(key, () => window.shareAPI.statusApp(dirName));
    }
    if (evt.filePath !== undefined) {
      const filePath = evt.filePath;
      const key = fileKey(filePath);
      if (cache.has(key)) void runFetch(key, () => window.shareAPI.statusFile(filePath));
    }
  });
}

/**
 * Runs `fetcher`, publishing a loading snapshot first (preserving whatever
 * was already cached, so a refetch doesn't blank a chip that was already
 * showing a published URL) and the resolved/rejected result after. Always
 * replaces the whole object for `key` rather than mutating one in place, so
 * `Object.is` sees the change and unrelated keys stay referentially stable.
 */
function runFetch(key: string, fetcher: Fetcher): Promise<void> {
  ensureOnChangedSubscribed();
  const prev = cache.get(key) ?? IDLE_STATE;
  cache.set(key, { published: prev.published, behind: prev.behind, loading: true });
  notify();

  return fetcher().then(
    (result) => {
      cache.set(key, { published: result.published, behind: result.behind, loading: false });
      notify();
    },
    (err: unknown) => {
      console.warn('[shareStore] status fetch failed', err);
      cache.set(key, { published: null, behind: false, loading: false });
      notify();
    },
  );
}

/** Fetches `key` only if nothing has asked for it yet. */
function ensureKeyLoaded(key: string, fetcher: Fetcher): void {
  ensureOnChangedSubscribed();
  if (cache.has(key)) return;
  void runFetch(key, fetcher);
}

function getSnapshotFor(key: string | null): ToolShareState {
  if (key === null) return IDLE_STATE;
  return cache.get(key) ?? UNKNOWN_STATE;
}

export function useToolShare(dirName: string): ToolShareState {
  const key = appKey(dirName);
  // useSyncExternalStore's own subscription is itself a passive effect, and
  // effects run in the order their hooks were declared. Reading the store
  // BEFORE the effect below means that subscription is already registered
  // by the time our effect synchronously fetches-and-`notify()`s on mount —
  // otherwise the very first "now loading" notification finds no listener
  // yet and is silently dropped, so the loading state next appears only
  // when the fetch itself resolves and calls `notify()` a second time.
  const state = useSyncExternalStore(subscribe, () => getSnapshotFor(key));

  useEffect(() => {
    ensureKeyLoaded(key, () => window.shareAPI.statusApp(dirName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

export function useFileShare(filePath: string | null): ToolShareState {
  const key = filePath !== null ? fileKey(filePath) : null;
  const state = useSyncExternalStore(subscribe, () => getSnapshotFor(key));

  useEffect(() => {
    if (key === null || filePath === null) return;
    ensureKeyLoaded(key, () => window.shareAPI.statusFile(filePath));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/** Forces a refetch of `app:<dirName>`, regardless of whether it's cached. */
export function refreshToolShare(dirName: string): Promise<void> {
  return runFetch(appKey(dirName), () => window.shareAPI.statusApp(dirName));
}

/** Test seam: drop all cached state and the `onChanged` subscription. */
export function __resetShareStoreForTests(): void {
  cache.clear();
  listeners.clear();
  if (unsubscribeOnChanged) unsubscribeOnChanged();
  unsubscribeOnChanged = null;
  onChangedSubscribed = false;
}
