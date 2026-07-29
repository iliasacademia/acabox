import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';

/**
 * Whether each tool currently builds.
 *
 * Build failure is not a *status* — statuses describe what is happening now and
 * are rightly transient. "This tool does not build" is a property of the tool,
 * as durable as its name, and it stays true whether or not anyone is looking at
 * it. Keeping it in the viewer component meant a broken tool looked perfectly
 * healthy on the home grid the moment you navigated away.
 *
 * Recorded here, next to where builds actually run, and persisted so it is
 * still true after a restart. Deliberately NOT in the tool's manifest.json:
 * that file travels with the folder when a tool is exported or shared, and a
 * build failure on this machine says nothing about anyone else's.
 */

export interface BuildHealth {
  dirName: string;
  ok: boolean;
  /** esbuild's output when it failed. Empty when healthy. */
  error?: string;
  at: number;
}

let health = new Map<string, BuildHealth>();
let loaded = false;
const listeners = new Set<(all: BuildHealth[]) => void>();

function storePath(): string {
  return path.join(app.getPath('userData'), 'tool-build-health.json');
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf-8'));
    if (Array.isArray(parsed)) {
      for (const h of parsed) {
        if (h && typeof h.dirName === 'string') health.set(h.dirName, h);
      }
    }
  } catch {
    // Missing or corrupt — a tool with no record is treated as healthy, which
    // is the right default: we only know it is broken once a build has failed.
  }
}

function persist(): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify([...health.values()], null, 2), 'utf-8');
  } catch (err) {
    log.warn(`[BuildHealth] Could not persist: ${(err as Error).message}`);
  }
}

function emit(): void {
  persist();
  const all = listBuildHealth();
  for (const l of listeners) {
    try { l(all); } catch { /* a listener must not break a build */ }
  }
}

export function recordBuildResult(dirName: string, ok: boolean, error?: string): void {
  load();
  const prev = health.get(dirName);
  const next: BuildHealth = { dirName, ok, error: ok ? undefined : (error ?? '').slice(0, 4000), at: Date.now() };
  if (prev && prev.ok === next.ok && prev.error === next.error) return;
  if (ok) health.delete(dirName); // healthy is the absence of a record
  else health.set(dirName, next);
  emit();
}

/** Forget a tool entirely — used when it is deleted. */
export function forgetBuildHealth(dirName: string): void {
  load();
  if (health.delete(dirName)) emit();
}

/** Only the unhealthy ones; a miss means the tool is fine. */
export function listBuildHealth(): BuildHealth[] {
  load();
  return [...health.values()].map((h) => ({ ...h }));
}

export function subscribeBuildHealth(listener: (all: BuildHealth[]) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function __resetBuildHealth(): void {
  health = new Map();
  loaded = true;
  listeners.clear();
}
