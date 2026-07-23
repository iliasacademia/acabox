/**
 * Login-shell PATH resolution.
 *
 * A macOS/Linux app launched from Finder/Dock inherits the minimal launchd
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). That omits Homebrew (`/opt/homebrew/bin`),
 * nvm, and other locations where users install `node`, `npm`, and CLI tools.
 * Without augmenting it, every subprocess we spawn that depends on a
 * user-installed binary (npm, an esbuild fallback, the agent's Bash tool)
 * silently fails to find it in a packaged build, even though it works in
 * `npm start` (which inherits the terminal's PATH).
 *
 * We resolve the user's real login-shell PATH once and cache it. On Windows the
 * GUI/console PATH is already complete, so we use `process.env.PATH` verbatim.
 *
 * Subtleties, all handled below:
 *   - The synchronous resolver spawns a login shell, which can take a moment.
 *     Callers on the Electron main thread should `prewarmLoginShellPath()`
 *     early in startup so the later synchronous call hits a warm cache instead
 *     of blocking the event loop.
 *   - We read PATH through a POSIX `sh` child rather than the login shell
 *     directly. fish stores `$PATH` as a list that expands space-joined inside
 *     quotes, which would defeat our colon-based parsing; but every shell —
 *     fish included — *exports* PATH colon-joined, so a nested `sh` sees the
 *     correct value regardless of which shell the user runs.
 *   - Interactive shells ignore SIGTERM, so the spawn timeout must kill with
 *     SIGKILL or a blocking rc file would hang the call indefinitely.
 *   - A successful resolution is cached forever; a *failed* one is remembered
 *     separately so synchronous callers fall back instantly without re-paying
 *     the spawn, while the async prewarm may retry and recover later.
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import log from 'electron-log';

const execFileAsync = promisify(execFile);

// Set only by a successful resolution (or the win32 pass-through).
let cachedPath: string | null = null;
// Set when a resolution attempt failed. Served to sync callers so they never
// block retrying, but left out of cachedPath so a later prewarm can recover.
let fallbackPath: string | null = null;
// Single-flight guard so concurrent cold prewarms share one login-shell spawn
// (rc files — e.g. zsh compdump rebuilds — are not concurrency-safe).
let inflight: Promise<void> | null = null;

const RESOLVE_TIMEOUT_MS = 5000;

/**
 * Build the (shell, args) pair that prints the exported PATH between markers.
 * `-ilc` sources the user's login + interactive rc files (where Homebrew / nvm
 * / etc. amend PATH); the nested `sh -c` then prints the *exported* PATH, which
 * is colon-joined in every shell including fish. Markers let us recover the
 * value even if an rc file prints a banner to stdout.
 */
function loginShellCommand(): { shell: string; args: string[] } {
  const shell = process.env.SHELL || '/bin/bash';
  const inner = `sh -c 'printf "__CB_PATH__%s__CB_PATH__" "$PATH"'`;
  return { shell, args: ['-ilc', inner] };
}

function parseResolvedPath(out: string, fallback: string): string | null {
  const match = out.match(/__CB_PATH__([\s\S]*?)__CB_PATH__/);
  const resolved = match?.[1]?.trim();
  return resolved ? mergePaths(resolved, fallback) : null;
}

/**
 * Resolve and cache the login-shell PATH synchronously. Returns immediately on
 * a warm cache or a remembered failure. On a cold cache this spawns a login
 * shell and blocks until it exits (up to RESOLVE_TIMEOUT_MS) — prefer
 * `prewarmLoginShellPath()` at startup so main-thread callers never pay that
 * cost inline.
 */
export function getLoginShellPath(): string {
  if (cachedPath !== null) return cachedPath;

  const envPath = process.env.PATH ?? '';
  if (process.platform === 'win32') {
    cachedPath = envPath;
    return cachedPath;
  }
  // A previous attempt already failed; serve the fallback rather than
  // re-blocking this (possibly main-thread) caller. The async prewarm is
  // the retry path.
  if (fallbackPath !== null) return fallbackPath;

  const { shell, args } = loginShellCommand();
  try {
    const out = execFileSync(shell, args, {
      encoding: 'utf-8',
      timeout: RESOLVE_TIMEOUT_MS,
      // Interactive shells ignore SIGTERM (the default killSignal), which
      // would make the timeout a no-op against a blocking rc file.
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const resolved = parseResolvedPath(out, envPath);
    if (resolved) {
      cachedPath = resolved;
      return cachedPath;
    }
    log.warn('[ShellPath] Login shell returned no PATH; falling back to process.env.PATH');
  } catch (err) {
    // The marker may have been printed before a timeout killed the shell.
    const salvaged = parseResolvedPath(String((err as any)?.stdout ?? ''), envPath);
    if (salvaged) {
      cachedPath = salvaged;
      return cachedPath;
    }
    log.warn(`[ShellPath] Failed to resolve login shell PATH (${shell}): ${(err as Error).message}`);
  }

  fallbackPath = envPath;
  return fallbackPath;
}

/**
 * Resolve and cache the login-shell PATH without blocking the event loop.
 * Fire this early in startup (before any subprocess spawn) so the later
 * synchronous `getLoginShellPath()` — called on the main thread by
 * `buildSubprocessEnv` — hits a warm cache instead of spawning a login shell
 * on the hot path. Safe to call repeatedly: concurrent calls share one spawn,
 * and calls after a *failed* attempt retry (so a transient slow rc file
 * doesn't degrade the whole session), while calls after a success no-op.
 */
export function prewarmLoginShellPath(): Promise<void> {
  if (cachedPath !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    cachedPath = process.env.PATH ?? '';
    return Promise.resolve();
  }
  if (inflight) return inflight;
  inflight = resolveLoginShellPathAsync().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function resolveLoginShellPathAsync(): Promise<void> {
  const envPath = process.env.PATH ?? '';
  const { shell, args } = loginShellCommand();
  try {
    const pending = execFileAsync(shell, args, {
      encoding: 'utf-8',
      timeout: RESOLVE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    // execFile hands the child a pipe stdin we'd otherwise hold open; an rc
    // file that reads stdin (e.g. zsh compaudit's prompt) would block on it
    // until the timeout. End it so reads see EOF, matching the sync path's
    // 'ignore'.
    pending.child.stdin?.end();
    const { stdout } = await pending;
    // A concurrent synchronous call may have populated the cache while we
    // were awaiting; if so, leave its value in place.
    if (cachedPath !== null) return;
    const resolved = parseResolvedPath(stdout, envPath);
    if (resolved) {
      cachedPath = resolved;
      fallbackPath = null;
      return;
    }
    log.warn('[ShellPath] Login shell returned no PATH; falling back to process.env.PATH');
  } catch (err) {
    const salvaged = parseResolvedPath(String((err as any)?.stdout ?? ''), envPath);
    if (salvaged && cachedPath === null) {
      cachedPath = salvaged;
      fallbackPath = null;
      return;
    }
    log.warn(`[ShellPath] Failed to resolve login shell PATH (${shell}): ${(err as Error).message}`);
  }
  if (cachedPath === null) fallbackPath = envPath;
}

/**
 * Merge the login-shell PATH (primary) with the inherited PATH (fallback),
 * de-duplicating entries while preserving order. Keeping the inherited entries
 * means anything launchd added that the shell didn't is still reachable.
 */
function mergePaths(primary: string, fallback: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...primary.split(':'), ...fallback.split(':')]) {
    const p = part.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(':');
}
