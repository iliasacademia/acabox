/**
 * The list of chats the reference picker chooses from.
 *
 * A module store rather than per-component state because two composers are
 * mounted at once — the docked one and the tool side panel's — and every tab
 * in this app stays mounted forever behind `display: none`. Per-component
 * fetching would mean two identical `sessions:list` round trips on every
 * keystroke that opens a picker, and two copies that can disagree after a
 * rename.
 *
 * Refreshed on `sessions:changed` and on `sessions:titleUpdated`, which is the
 * one that matters in practice: a brand-new chat is titled asynchronously a
 * few seconds after its first turn, so a picker opened in between would
 * otherwise offer "New Chat" forever.
 */
import { useSyncExternalStore } from 'react';

export interface ChatIndexEntry {
  id: string;
  title: string;
  updatedAt: string;
  appDirName: string | null;
}

let entries: ChatIndexEntry[] = [];
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

async function fetchIndex(): Promise<void> {
  try {
    const rows = await window.sessionsAPI?.list();
    entries = (rows ?? []).map((row: any) => ({
      id: row.id,
      title: row.title ?? 'New Chat',
      updatedAt: row.updated_at ?? row.created_at ?? '',
      appDirName: row.app_dir_name ?? null,
    }));
    loaded = true;
    emit();
  } catch {
    // A failed list leaves the previous entries in place. The picker showing
    // a slightly stale list beats it emptying itself on a transient IPC error.
  } finally {
    inFlight = null;
  }
}

/** Fetch once per app run, and again whenever something invalidates it. */
export function ensureChatIndex(force = false): void {
  if (inFlight) return;
  if (loaded && !force) return;
  inFlight = fetchIndex();
}

let wired = false;
function wireInvalidation(): void {
  if (wired) return;
  wired = true;
  // Guarded because not every surface that renders a composer has the
  // preload bridge: the find-bar window and the server-rendered component
  // tests both mount this tree with no `sessionsAPI` on `window`. Throwing
  // here would take the whole composer down over a feature that is allowed
  // to be absent.
  try {
    window.sessionsAPI?.onSessionsChanged(() => ensureChatIndex(true));
    window.sessionsAPI?.onTitleUpdated(() => ensureChatIndex(true));
  } catch {
    /* no bridge here; the index simply stays empty */
  }
}

function subscribe(listener: () => void): () => void {
  wireInvalidation();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): ChatIndexEntry[] {
  return entries;
}

export function useChatIndex(): ChatIndexEntry[] {
  // The third argument is the server snapshot, and it is not optional in
  // practice: the composer components are rendered with `renderToStaticMarkup`
  // in their own tests, and without it React throws rather than falling back.
  // The same snapshot is correct for both — it is a plain module array.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Resolve a written (possibly shortened) reference against the cached index. */
export function lookupChatRef(written: string): ChatIndexEntry | undefined {
  const lower = written.toLowerCase();
  const matches = entries.filter((e) => e.id.toLowerCase().startsWith(lower));
  // Exactly one, or nothing: an ambiguous prefix is reported by main in the
  // message the agent receives, and a chip that silently picked the first
  // match would tell the user something different from what actually happens.
  return matches.length === 1 ? matches[0] : undefined;
}

/** Substring filter over titles, most recently active first. */
export function filterChats(all: ChatIndexEntry[], query: string, excludeId?: string): ChatIndexEntry[] {
  const q = query.trim().toLowerCase();
  return all
    .filter((e) => e.id !== excludeId)
    .filter((e) => !q || e.title.toLowerCase().includes(q))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
