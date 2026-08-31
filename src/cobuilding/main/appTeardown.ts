import log from 'electron-log';

/**
 * Quit teardown: the dozen non-idempotent shutdown steps, and the two `app.on`
 * handler bodies that decide when they run.
 *
 * Extracted out of `index.ts` for two reasons. First, the bug this module
 * fixes: `event.preventDefault()` does not interrupt `emit()` — Electron reads
 * the "prevented" flag only *after* every listener registered for that emit
 * has returned. So a `before-quit` listener that calls it, followed by ANY
 * OTHER `before-quit` listener (ours or anyone else's), still runs that other
 * listener to completion; it has no way to know the quit was cancelled.
 * That is exactly what put the 12 teardown steps on `before-quit` in the
 * original code: they ran unconditionally on every `before-quit` emission,
 * including the one where the user clicked "Cancel" on the confirmation
 * dialog and the app was meant to stay open. `will-quit` is the fix: Electron
 * only emits it once a `before-quit` emission has run to completion with
 * nothing having called `preventDefault()`, so it fires precisely when the
 * app is actually going away.
 *
 * Second, testability. The 12 steps reach into a dozen real subsystems
 * (agent server, kernel gateway, three SQLite handles, ...), so exercising
 * them "in place" would mean standing up the whole app. `createTeardown`
 * takes the step list as data and is exercised directly; `handleBeforeQuit`/
 * `handleWillQuit` take their Electron dependencies as an injected `deps`
 * object so the dialog/teardown *decision* can be driven with a fake event
 * and fake dialog answers, without touching Electron's real emitter.
 */

export type TeardownStep = [string, () => void];

let steps: TeardownStep[] = [];
let tornDown = false;

/**
 * Registers the teardown steps and returns an idempotent runner. `will-quit`
 * can fire more than once across the app's lifetime — a normal quit, the
 * Debug tab's hard reset (`app.relaunch()` + `app.quit()`), a tray quit — and
 * none of the 12 steps (killing the agent server, closing three database
 * handles, ...) is safe to run twice. The guard is a module-scope flag rather
 * than a per-call closure so that every caller of `run()` — however many
 * `will-quit` listeners end up registered — shares the same answer to
 * "has this already happened".
 *
 * Each step is individually try/caught and logged so one broken step (a
 * socket that's already closed, say) never stops the rest from running:
 * losing the database close because the agent server's SIGTERM hung would be
 * worse than logging both failures.
 */
export function createTeardown(newSteps: TeardownStep[]): { run(): void } {
  steps = newSteps;
  return {
    run(): void {
      if (tornDown) return;
      tornDown = true;
      for (const [name, fn] of steps) {
        try {
          fn();
        } catch (err) {
          log.error(`[APP] Cleanup step "${name}" failed:`, err);
        }
      }
    },
  };
}

/** Test seam — resets the module state `createTeardown` AND `handleWillQuit` close over. */
export function __resetTeardown(): void {
  steps = [];
  tornDown = false;
  quitting = false;
}

/**
 * Dependencies of `handleBeforeQuit`, injected so the decision logic (which
 * escape applies, which dialog button was clicked) can be unit tested without
 * a real `dialog.showMessageBoxSync` or a real `app`.
 */
export interface BeforeQuitDeps {
  isQuitConfirmed(): boolean;
  setQuitConfirmed(value: boolean): void;
  isSmokeTest(): boolean;
  allWindowsDestroyed(): boolean;
  activeJobs(): Array<{ dirName: string }>;
  cancelAll(): void;
  /** Shows the confirmation dialog; returns the clicked button index. */
  showQuitDialog(names: string[], count: number): number;
  /** `() => app.quit()` — kept behind a seam so tests never call the real one. */
  quit(): void;
}

/**
 * The sole remaining `before-quit` listener: decide whether to warn about work
 * in flight, and if so, act on the user's answer. Carries no teardown of its
 * own — see the module comment for why that had to move to `will-quit`.
 *
 * Escapes, checked in this order and preserved exactly from the original
 * listener: a confirmed quit already in flight, a headless `--smoke-test` run
 * (a modal would hang it forever with nobody there to answer), all windows
 * already destroyed, and no work actually running.
 */
export function handleBeforeQuit(event: { preventDefault(): void }, deps: BeforeQuitDeps): void {
  if (deps.isQuitConfirmed()) return;
  if (deps.isSmokeTest()) return;
  if (deps.allWindowsDestroyed()) return;

  const running = deps.activeJobs();
  if (running.length === 0) return;

  event.preventDefault();
  const names = [...new Set(running.map((j) => j.dirName))];
  const choice = deps.showQuitDialog(names, running.length);

  if (choice === 2) return;          // Cancel — stay open, teardown never runs.
  if (choice === 1) deps.cancelAll();
  deps.setQuitConfirmed(true);
  deps.quit();
}

// ---------------------------------------------------------------------------
// will-quit — R14: async-capable, watchdog-bounded, idempotent
// ---------------------------------------------------------------------------

/**
 * ~5s total — comfortably over the 2s grace `handleWillQuit` gives
 * `mcpHost.shutdown()` below, per R14's own figure (it cites `jobRegistry`'s
 * existing 3s SIGTERM→SIGKILL window as the precedent; this adds slack for
 * the extra hop). Exported so a test can override it via
 * `WillQuitDeps.watchdogMs` without sleeping the real duration.
 */
export const WILL_QUIT_WATCHDOG_MS = 5000;

/** The grace `handleWillQuit` gives `mcpHost.shutdown()` before the watchdog above fires regardless of whether it has settled. */
export const MCP_HOST_SHUTDOWN_GRACE_MS = 2000;

/**
 * Re-entrancy guard for `handleWillQuit` — see the function comment for why
 * `createTeardown`'s own `tornDown` flag is not enough on its own once this
 * listener is async. Reset by `__resetTeardown` alongside `tornDown`, since
 * every test in `quitTeardown.test.ts` already resets state through that one
 * function.
 */
let quitting = false;

export interface WillQuitDeps {
  /** The existing idempotent teardown runner — `createTeardown(...)`'s return value. */
  teardown: { run(): void };
  /** `mcpHost.shutdown` — stops every hosted MCP server's child process. */
  shutdownMcpHost(opts: { graceMs: number }): Promise<void>;
  /** `(code) => app.exit(code)` — see the function comment for why this must never be `app.quit()`. */
  exit(code: number): void;
  /** Overridable for tests; defaults to `WILL_QUIT_WATCHDOG_MS`. */
  watchdogMs?: number;
  /** Overridable for tests; defaults to `MCP_HOST_SHUTDOWN_GRACE_MS`. */
  graceMs?: number;
}

/**
 * The sole `will-quit` listener. Async, because hosted-MCP shutdown
 * (`mcpHost.shutdown`) signals each hosted server's child process and waits
 * up to its own grace window for a clean exit — not instantaneous the way
 * the 12 synchronous teardown steps are, which is exactly why this listener
 * could stay synchronous until now.
 *
 * Order: `deps.teardown.run()` first — synchronous, and already idempotent
 * on its own `tornDown` flag — THEN `await` the hosted-MCP shutdown. (R14
 * suggested the reverse, on the theory that a hosted server mid-`tools/call`
 * might be writing through a relay that touches the same database handles
 * `deps.teardown.run()` closes. That relay does not exist in this codebase:
 * Increment 4 — the wiring that would let the agent reach a hosted server's
 * tools at all — is unbuilt, and even once it lands, a hosted server is a
 * separate OS process with no access to Acabox's own SQLite handles. There
 * is therefore no dependency either way today; revisit the ordering if a
 * future increment ever gives a hosted server's call a real path back into
 * a handle this module also closes.)
 *
 * `app.exit(0)` is reached exactly once, via whichever of two races settles
 * first:
 *  - the happy path — `shutdownMcpHost` resolves, or rejects (logged and
 *    swallowed, never left to hang the quit);
 *  - the watchdog — an unconditional timer armed the instant this function
 *    is entered, before awaiting anything, and `.unref()`'d so it cannot
 *    itself keep a real process alive. A hung `client.close()` on a wedged
 *    stdio child is exactly the case this exists for: "await with a
 *    timeout" fails if the await itself never settles, which is why this is
 *    a real `setTimeout` racing the await rather than a `Promise.race`
 *    wrapper around it (a `Promise.race` still leaves the loser attached
 *    and unresolved, but does nothing extra to force the process to exit —
 *    the exit itself has to come from somewhere, and here it comes from the
 *    timer's own callback, independent of whether the raced promise ever
 *    settles).
 *
 * `quitting` guards re-entrancy: `will-quit` can fire more than once across
 * the app's lifetime (tray quit, ⌘Q, the Debug hard reset's
 * `app.relaunch()` + `app.quit()`). In the real app `app.exit()` terminates
 * the process before a second `will-quit` could ever be dispatched, but the
 * guard covers the window before that happens — and in tests, where `exit`
 * is a mock and the process does not actually die, it is the only thing
 * stopping a second call from running teardown again, arming a second
 * watchdog, or calling `exit` a second time.
 *
 * `app.exit(0)` — never `app.quit()` — because `app.quit()` re-emits
 * `before-quit`/`will-quit`, exactly the recursion this module exists to
 * break. `app.exit()` terminates the process directly: no further
 * `will-quit` listeners, and no `quit` event at all. That is the intent
 * once teardown has already run, but it means a future `quit` listener
 * would be silently dead — worth a line in whichever module adds one.
 */
export async function handleWillQuit(event: { preventDefault(): void }, deps: WillQuitDeps): Promise<void> {
  if (quitting) return;
  quitting = true;

  event.preventDefault();
  deps.teardown.run();

  let settled = false;
  const finish = (path: 'shutdown' | 'watchdog'): void => {
    if (settled) return;
    settled = true;
    log.info(`[APP] will-quit: exiting via the ${path} path`);
    deps.exit(0);
  };

  const watchdog = setTimeout(() => finish('watchdog'), deps.watchdogMs ?? WILL_QUIT_WATCHDOG_MS);
  watchdog.unref?.();

  try {
    await deps.shutdownMcpHost({ graceMs: deps.graceMs ?? MCP_HOST_SHUTDOWN_GRACE_MS });
  } catch (err) {
    log.error('[APP] mcpHost.shutdown() failed during quit:', err);
  } finally {
    clearTimeout(watchdog);
    finish('shutdown');
  }
}
