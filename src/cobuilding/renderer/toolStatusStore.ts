import { useSyncExternalStore } from 'react';

/**
 * Live per-tool runtime status.
 *
 * Two independent inputs are merged here:
 *
 *  - **Lifecycle** — first-boot dependency install, esbuild rebuild, build
 *    failure. Pushed by MiniAppViewer via `setToolLifecycle`.
 *  - **Activity** — whether the tool is *executing something right now*.
 *    Ref-counted around the operations the host brokers on a mini-app's
 *    behalf (kernel code, shell commands, Claude calls) and around
 *    agent → mini-app MCP invocations, via `beginToolActivity`.
 *
 * `idle` is the resting state and it is the *default*: a tool with no entry is
 * idle, not working. Until 2026-07-28 the default was `running`, which is why
 * every tool the user had ever opened claimed RUNNING while sitting there
 * doing nothing — `running` was never set deliberately, it was the else-branch.
 *
 * Precedence, highest first: buildFailed > building > installing > working >
 * idle. A tool that can't build isn't "working" no matter what is in flight.
 *
 * Idle tools are deliberately **absent** from the snapshot map rather than
 * present with `{kind:'idle'}`. Surfaces that only want to signal news (home
 * cards, rail) can then render nothing on a miss, and `useToolStatus` fills in
 * idle for the surfaces that always show a chip.
 */

/** Delay before an in-flight operation is allowed to show WORKING. */
export const WORKING_SHOW_DELAY_MS = 200;
/** Once shown, WORKING stays up at least this long so it is readable. */
export const WORKING_MIN_VISIBLE_MS = 800;

export type ToolLifecycleStatus =
  | { kind: 'idle' }
  | { kind: 'installing'; done: number; total: number }
  | { kind: 'building' }
  | { kind: 'buildFailed'; message: string; at: number };

export type ToolRuntimeStatus =
  | ToolLifecycleStatus
  | { kind: 'working' }
  /**
   * Work was in flight when the app went away. `finishedWhileAway` means it
   * outlived us and its outcome is unknown; `interrupted` means it could not
   * have continued. Both are past events, so they rank below live work.
   */
  | { kind: 'interrupted'; reason: 'interrupted' | 'finishedWhileAway' };

const IDLE: ToolRuntimeStatus = { kind: 'idle' };

interface ActivityEntry {
  /** Number of operations currently in flight for this tool. */
  count: number;
  /** Pending delay-in timer; non-null means "in flight but not shown yet". */
  showTimer: ReturnType<typeof setTimeout> | null;
  /** Pending hold-out timer; non-null means "finished, still shown". */
  hideTimer: ReturnType<typeof setTimeout> | null;
  /** When WORKING became visible, for the minimum-visible calculation. */
  visibleSince: number | null;
}

const lifecycle = new Map<string, ToolLifecycleStatus>();
const activity = new Map<string, ActivityEntry>();
const listeners = new Set<() => void>();
const runEndListeners = new Set<(dirName: string) => void>();
/** Tools with an unacknowledged interrupted / finished-while-away job. */
const unfinished = new Map<string, 'interrupted' | 'finishedWhileAway'>();
/** Tools the host knows do not build, from `buildHealth`. Survives unmount. */
const hostBuildFailures = new Map<string, { message: string; at: number }>();

let snapshot: Map<string, ToolRuntimeStatus> = new Map();

function computeSnapshot(): Map<string, ToolRuntimeStatus> {
  const next = new Map<string, ToolRuntimeStatus>();
  // Host-recorded build failures come first: "this tool does not build" is true
  // whether or not its viewer is mounted, unlike the viewer-local lifecycle.
  for (const [dirName, entry] of hostBuildFailures) {
    next.set(dirName, { kind: 'buildFailed', message: entry.message, at: entry.at });
  }
  for (const [dirName, status] of lifecycle) {
    if (status.kind !== 'idle') next.set(dirName, status);
  }
  for (const [dirName, entry] of activity) {
    if (entry.visibleSince === null) continue;
    if (next.has(dirName)) continue; // a lifecycle state outranks activity
    next.set(dirName, { kind: 'working' });
  }
  for (const [dirName, reason] of unfinished) {
    if (next.has(dirName)) continue; // live state outranks a past one
    next.set(dirName, { kind: 'interrupted', reason });
  }
  return next;
}

function sameStatus(a: ToolRuntimeStatus, b: ToolRuntimeStatus): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'installing' && b.kind === 'installing') {
    return a.done === b.done && a.total === b.total;
  }
  if (a.kind === 'buildFailed' && b.kind === 'buildFailed') {
    return a.at === b.at && a.message === b.message;
  }
  if (a.kind === 'interrupted' && b.kind === 'interrupted') {
    return a.reason === b.reason;
  }
  return true;
}

/**
 * Recompute and publish. No-ops when nothing observable changed, so the
 * chattier writers (the install-progress effect, a rebuild settling back to
 * idle) can't spin every subscriber.
 */
function republish(): void {
  const next = computeSnapshot();
  if (next.size === snapshot.size) {
    let identical = true;
    for (const [dirName, status] of next) {
      const prev = snapshot.get(dirName);
      if (!prev || !sameStatus(prev, status)) { identical = false; break; }
    }
    if (identical) return;
  }
  snapshot = next;
  for (const l of listeners) l();
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

/** Record a tool's build/install lifecycle state. `idle` clears it. */
export function setToolLifecycle(dirName: string, status: ToolLifecycleStatus): void {
  const prev = lifecycle.get(dirName);
  if (prev && sameStatus(prev, status)) return;
  if (status.kind === 'idle') lifecycle.delete(dirName);
  else lifecycle.set(dirName, status);
  republish();
}

/**
 * Drop everything known about a tool — called when its viewer unmounts. Any
 * still-pending activity is abandoned: the iframe is gone, so nothing it
 * started can finish visibly.
 */
export function clearToolStatus(dirName: string): void {
  const entry = activity.get(dirName);
  if (entry) {
    if (entry.showTimer !== null) clearTimeout(entry.showTimer);
    if (entry.hideTimer !== null) clearTimeout(entry.hideTimer);
    activity.delete(dirName);
  }
  lifecycle.delete(dirName);
  republish();
}

// ── Activity ───────────────────────────────────────────────────────────────

/**
 * Mark one operation as in flight for `dirName`. Returns the (idempotent)
 * function that marks it finished. Ref-counted: overlapping operations hold
 * WORKING up until the last one settles.
 */
export function beginToolActivity(dirName: string): () => void {
  let entry = activity.get(dirName);
  if (!entry) {
    entry = { count: 0, showTimer: null, hideTimer: null, visibleSince: null };
    activity.set(dirName, entry);
  }
  const self = entry;
  self.count += 1;

  // A new operation during the hold-out window keeps the existing WORKING up
  // rather than blinking it off and on.
  if (self.hideTimer !== null) {
    clearTimeout(self.hideTimer);
    self.hideTimer = null;
  }
  if (self.visibleSince === null && self.showTimer === null) {
    self.showTimer = setTimeout(() => {
      if (activity.get(dirName) !== self) return;
      self.showTimer = null;
      self.visibleSince = Date.now();
      republish();
    }, WORKING_SHOW_DELAY_MS);
  }

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    endActivity(dirName, self);
  };
}

function endActivity(dirName: string, self: ActivityEntry): void {
  // The entry was reset (viewer unmounted) while this operation was in flight.
  if (activity.get(dirName) !== self) return;
  self.count = Math.max(0, self.count - 1);
  if (self.count > 0) return;

  // The episode is over. It counts as a run even if it was too brief to show.
  for (const l of runEndListeners) l(dirName);

  if (self.showTimer !== null) {
    clearTimeout(self.showTimer);
    self.showTimer = null;
    activity.delete(dirName);
    return; // never became visible — nothing to publish
  }
  if (self.visibleSince === null) {
    activity.delete(dirName);
    return;
  }
  const remaining = WORKING_MIN_VISIBLE_MS - (Date.now() - self.visibleSince);
  if (remaining <= 0) {
    activity.delete(dirName);
    republish();
    return;
  }
  self.hideTimer = setTimeout(() => {
    if (activity.get(dirName) !== self) return;
    activity.delete(dirName);
    republish();
  }, remaining);
}

/**
 * Reconcile the store against the host's job list.
 *
 * This is what makes the status outlive the tool's viewer. The host owns the
 * work — a shell command keeps running after you navigate away, and even after
 * the app quits — so the host's list, not a mounted component, decides whether
 * a tool is working. Each host job holds one activity slot through the same
 * delay-in / hold-out machinery as everything else, so the chip behaves
 * identically no matter where the work is tracked.
 */
const hostJobEnders = new Map<string, () => void>();

export function applyHostJobs(jobs: {
  id: string; dirName: string; status: string;
}[]): void {
  const seen = new Set<string>();

  for (const job of jobs) {
    if (job.status !== 'running') continue;
    seen.add(job.id);
    if (!hostJobEnders.has(job.id)) {
      hostJobEnders.set(job.id, beginToolActivity(job.dirName));
    }
  }

  for (const [id, end] of [...hostJobEnders]) {
    if (seen.has(id)) continue;
    hostJobEnders.delete(id);
    end();
  }

  // Past-tense states: work that was in flight when the app went away.
  const nextUnfinished = new Map<string, 'interrupted' | 'finishedWhileAway'>();
  for (const job of jobs) {
    if (job.status === 'interrupted' || job.status === 'finishedWhileAway') {
      // "finished while away" is the more informative of the two — prefer it.
      const existing = nextUnfinished.get(job.dirName);
      if (existing !== 'finishedWhileAway') {
        nextUnfinished.set(job.dirName, job.status as 'interrupted' | 'finishedWhileAway');
      }
    }
  }
  let changed = nextUnfinished.size !== unfinished.size;
  if (!changed) {
    for (const [k, v] of nextUnfinished) if (unfinished.get(k) !== v) { changed = true; break; }
  }
  if (changed) {
    unfinished.clear();
    for (const [k, v] of nextUnfinished) unfinished.set(k, v);
    republish();
  }
}

/**
 * Reconcile against the host's record of which tools build.
 *
 * Unlike the viewer-local `buildFailed` lifecycle, this persists: a tool that
 * does not build reads BROKEN on the home grid with nothing mounted, and still
 * does after a restart.
 */
export function applyBuildHealth(entries: { dirName: string; ok: boolean; error?: string; at: number }[]): void {
  const next = new Map<string, { message: string; at: number }>();
  for (const e of entries) {
    if (!e.ok) next.set(e.dirName, { message: e.error ?? 'Build failed.', at: e.at });
  }
  let changed = next.size !== hostBuildFailures.size;
  if (!changed) {
    for (const [k, v] of next) {
      const prev = hostBuildFailures.get(k);
      if (!prev || prev.at !== v.at || prev.message !== v.message) { changed = true; break; }
    }
  }
  if (!changed) return;
  hostBuildFailures.clear();
  for (const [k, v] of next) hostBuildFailures.set(k, v);
  republish();
}

/** `beginToolActivity` around a promise, ended on settle. */
export async function trackToolActivity<T>(dirName: string, run: () => Promise<T>): Promise<T> {
  const end = beginToolActivity(dirName);
  try {
    return await run();
  } finally {
    end();
  }
}

/**
 * Notified each time a tool's activity drops back to zero — i.e. the tool
 * finished doing something. Used to stamp the manifest's `lastRun`.
 */
export function onToolRunEnded(listener: (dirName: string) => void): () => void {
  runEndListeners.add(listener);
  return () => { runEndListeners.delete(listener); };
}

// ── Subscription ───────────────────────────────────────────────────────────

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Current non-idle statuses, keyed by dir name. A miss means idle. Stable
 * identity between changes (it is `useSyncExternalStore`'s snapshot).
 */
export function getToolStatusSnapshot(): Map<string, ToolRuntimeStatus> {
  return snapshot;
}

function getSnapshot(): Map<string, ToolRuntimeStatus> {
  return snapshot;
}

export function useToolStatus(dirName: string): ToolRuntimeStatus {
  const map = useSyncExternalStore(subscribe, getSnapshot);
  return map.get(dirName) ?? IDLE;
}

/** Non-idle tools only — a miss means idle. */
export function useToolStatuses(): Map<string, ToolRuntimeStatus> {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Test seam: drop all state and timers. */
export function __resetToolStatusStore(): void {
  for (const entry of activity.values()) {
    if (entry.showTimer !== null) clearTimeout(entry.showTimer);
    if (entry.hideTimer !== null) clearTimeout(entry.hideTimer);
  }
  activity.clear();
  lifecycle.clear();
  unfinished.clear();
  hostBuildFailures.clear();
  hostJobEnders.clear();
  runEndListeners.clear();
  snapshot = new Map();
}
