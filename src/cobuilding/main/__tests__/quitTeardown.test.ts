/**
 * Quit teardown: the dozen-step shutdown, and the `before-quit`/`will-quit`
 * handlers deciding when it runs.
 *
 * The bug this pins: `event.preventDefault()` sets a flag Electron reads only
 * *after* `emit()` returns, so it does not stop a second `before-quit`
 * listener from running to completion. Before the fix, the 12 teardown steps
 * lived on `before-quit` and ran on every emission of it — including
 * "Cancel", where the app was meant to stay open — and ran a second time on
 * accept, because the nested `app.quit()` re-emits `before-quit`.
 *
 * `appTeardown.ts` takes every Electron dependency (the dialog, `app.quit`,
 * `activeJobs`, ...) as an injected `deps` object for exactly this reason:
 * these tests drive `handleBeforeQuit`/`handleWillQuit` directly with fake
 * events and fake dialog answers, never Electron's real emitter. That also
 * means only `electron-log` needs mocking below — `electron` itself is never
 * imported by the module under test, and everything it would otherwise touch
 * (dialog, app.quit, job registry) arrives as a plain `jest.fn()` per test.
 */

jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import log from 'electron-log';
import {
  createTeardown,
  handleBeforeQuit,
  handleWillQuit,
  __resetTeardown,
  type BeforeQuitDeps,
  type TeardownStep,
} from '../appTeardown';

beforeEach(() => {
  __resetTeardown();
  jest.clearAllMocks();
});

describe('createTeardown', () => {
  it('runs every step exactly once, even across two run() calls', () => {
    const calls: string[] = [];
    const steps: TeardownStep[] = [
      ['a', () => calls.push('a')],
      ['b', () => calls.push('b')],
    ];
    const teardown = createTeardown(steps);

    teardown.run();
    teardown.run();

    expect(calls).toEqual(['a', 'b']);
  });

  it('logs a throwing step and still runs the ones after it (existing behaviour, pinned)', () => {
    const calls: string[] = [];
    const boom = new Error('socket already closed');
    const steps: TeardownStep[] = [
      ['first', () => calls.push('first')],
      ['broken', () => { throw boom; }],
      ['last', () => calls.push('last')],
    ];

    createTeardown(steps).run();

    expect(calls).toEqual(['first', 'last']);
    expect(log.error).toHaveBeenCalledWith('[APP] Cleanup step "broken" failed:', boom);
  });
});

describe('handleBeforeQuit / handleWillQuit', () => {
  /** A fresh set of injected deps, with an independent `quitConfirmed` cell. */
  function makeDeps(dialogChoice: number, runningNames: string[] = ['toolA']) {
    let quitConfirmed = false;
    const cancelAll = jest.fn();
    const quit = jest.fn();
    const showQuitDialog = jest.fn(() => dialogChoice);
    const deps: BeforeQuitDeps = {
      isQuitConfirmed: () => quitConfirmed,
      setQuitConfirmed: (value) => { quitConfirmed = value; },
      isSmokeTest: () => false,
      allWindowsDestroyed: () => false,
      activeJobs: () => runningNames.map((dirName) => ({ dirName })),
      cancelAll,
      showQuitDialog,
      quit,
    };
    return { deps, cancelAll, quit, showQuitDialog };
  }

  it('Cancel (button 2) stays open and never reaches quit — so teardown never runs', () => {
    const { deps, quit } = makeDeps(2);
    const event = { preventDefault: jest.fn() };

    handleBeforeQuit(event, deps);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // `quit` is the only path by which the real app could ever reach
    // `will-quit`; if it was never called, teardown could not have run.
    expect(quit).not.toHaveBeenCalled();
  });

  it('Cancel never reaches will-quit, so teardown and mcpHost.shutdown() never run', () => {
    const { deps, quit } = makeDeps(2); // Cancel
    const stepFn = jest.fn();
    const teardown = createTeardown([['step', stepFn]]);
    const shutdownMcpHost = jest.fn();

    handleBeforeQuit({ preventDefault: jest.fn() }, deps);

    // Electron only ever emits `will-quit` downstream of a real `app.quit()`
    // call — never directly from `before-quit`. Since `quit` was never
    // invoked, `handleWillQuit` (and therefore `shutdownMcpHost`) had no path
    // to run; this is not inferred, `teardown`/`shutdownMcpHost` are never
    // even wired to anything else in this test.
    expect(quit).not.toHaveBeenCalled();
    expect(stepFn).not.toHaveBeenCalled();
    expect(shutdownMcpHost).not.toHaveBeenCalled();
  });

  it('"Stop them and quit" (button 1) cancels running work before quitting', () => {
    const { deps, cancelAll, quit } = makeDeps(1);

    handleBeforeQuit({ preventDefault: jest.fn() }, deps);

    expect(cancelAll).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('accepting the dialog runs teardown exactly once, through the nested before-quit re-emission', async () => {
    const steps: TeardownStep[] = [['close', jest.fn()]];
    const stepFn = steps[0][1] as jest.Mock;
    const teardown = createTeardown(steps);
    const { deps, cancelAll, quit, showQuitDialog } = makeDeps(0); // "Quit"

    const exit = jest.fn();
    const shutdownMcpHost = jest.fn().mockResolvedValue(undefined);
    const willQuitDeps = { teardown, shutdownMcpHost, exit };
    let willQuitPromise: Promise<void> | undefined;

    // `quit` is stubbed to model exactly what the real `app.quit()` does here:
    // a nested `before-quit` emission — `quitConfirmed` is already true by
    // then, so it returns immediately without touching the dialog again —
    // followed by the `will-quit` emission the now-unprevented nested quit
    // attempt reaches.
    quit.mockImplementation(() => {
      const nestedEvent = { preventDefault: jest.fn() };
      handleBeforeQuit(nestedEvent, deps);
      expect(nestedEvent.preventDefault).not.toHaveBeenCalled();
      expect(showQuitDialog).toHaveBeenCalledTimes(1); // dialog not shown again
      willQuitPromise = handleWillQuit({ preventDefault: jest.fn() }, willQuitDeps);
    });

    const outerEvent = { preventDefault: jest.fn() };
    handleBeforeQuit(outerEvent, deps);

    expect(outerEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(cancelAll).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
    // `deps.teardown.run()` happens synchronously, before `handleWillQuit`'s
    // first `await` — so this holds even though nobody has awaited
    // `willQuitPromise` yet.
    expect(stepFn).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    await willQuitPromise;
    expect(shutdownMcpHost).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    // A second, independent `will-quit` — tray quit, the Debug hard reset's
    // `app.relaunch()` + `app.quit()`, whatever else reaches it — must still
    // be a no-op. This is the idempotency guarantee itself, distinct from the
    // re-emission avoided above.
    await handleWillQuit({ preventDefault: jest.fn() }, willQuitDeps);
    expect(stepFn).toHaveBeenCalledTimes(1);
    expect(shutdownMcpHost).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('escapes — smoke test, no windows, no running work, an already-confirmed quit — all skip the dialog', () => {
    const { deps: base, showQuitDialog } = makeDeps(2);
    const overrides: Array<Partial<BeforeQuitDeps>> = [
      { isSmokeTest: () => true },
      { allWindowsDestroyed: () => true },
      { activeJobs: () => [] },
      { isQuitConfirmed: () => true },
    ];

    for (const override of overrides) {
      const deps = { ...base, ...override };
      const event = { preventDefault: jest.fn() };
      handleBeforeQuit(event, deps);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(showQuitDialog).not.toHaveBeenCalled();
  });
});

describe('handleWillQuit — R14 (async, watchdog-bounded, idempotent)', () => {
  it('awaits mcpHost.shutdown() before calling app.exit(0) — ordering, not just that both happened', async () => {
    const teardown = createTeardown([['step', jest.fn()]]);
    const exit = jest.fn();
    let releaseShutdown: () => void = () => {};
    const shutdownMcpHost = jest.fn(() => new Promise<void>((resolve) => { releaseShutdown = resolve; }));

    const donePromise = handleWillQuit({ preventDefault: jest.fn() }, { teardown, shutdownMcpHost, exit });

    // Drain the microtask queue without ever resolving shutdownMcpHost —
    // exit must not have fired yet, however many ticks pass.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdownMcpHost).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    releaseShutdown();
    await donePromise;

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a watchdog forces app.exit(0) if mcpHost.shutdown() never settles', async () => {
    const teardown = createTeardown([['step', jest.fn()]]);
    const exit = jest.fn();
    // Never resolves or rejects — models a wedged stdio child's client.close().
    const shutdownMcpHost = jest.fn(() => new Promise<void>(() => {}));

    // A real, but tiny, timer — NOT the 5s production `WILL_QUIT_WATCHDOG_MS`.
    // `handleWillQuit`'s own promise is left deliberately un-awaited: it can
    // never settle (shutdownMcpHost never does), exactly mirroring the real
    // app, where `app.exit(0)` would have already terminated the process by
    // the time anything downstream could care.
    void handleWillQuit({ preventDefault: jest.fn() }, {
      teardown,
      shutdownMcpHost,
      exit,
      watchdogMs: 15,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a second will-quit (tray quit / ⌘Q / the Debug hard reset) is a no-op — teardown runs once, exit fires once', async () => {
    const stepFn = jest.fn();
    const teardown = createTeardown([['step', stepFn]]);
    const exit = jest.fn();
    const shutdownMcpHost = jest.fn().mockResolvedValue(undefined);
    const deps = { teardown, shutdownMcpHost, exit };

    await handleWillQuit({ preventDefault: jest.fn() }, deps);
    await handleWillQuit({ preventDefault: jest.fn() }, deps);

    expect(stepFn).toHaveBeenCalledTimes(1);
    expect(shutdownMcpHost).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
