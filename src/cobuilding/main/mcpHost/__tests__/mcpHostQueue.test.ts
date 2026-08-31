/** @jest-environment node */
/**
 * `ServerCallQueue` is a pure concurrency primitive — it has no I/O of its
 * own (`supervisor.ts` supplies the actual `client.callTool(...)` call as a
 * `run` function), so there is nothing here to fake by mocking a real
 * subsystem. Real timers (`setTimeout`-backed "slow" calls) exercise the
 * queue's actual scheduling logic exactly the way a real, slow MCP call
 * would from the queue's point of view — the queue cannot tell the
 * difference, which is the point of the abstraction.
 */
import { ServerCallQueue, CALL_QUEUE_DEPTH_CAP } from '../callQueue';

jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** A call that "runs" for `ms`, recording its [start, end] window. */
function slowCall(ms: number, windows: Array<[number, number]>) {
  return async (): Promise<void> => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, ms));
    windows.push([start, Date.now()]);
  };
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

describe('ServerCallQueue — concurrency', () => {
  it('at concurrency 1, five slow(300) calls never overlap', async () => {
    const queue = new ServerCallQueue('srv', { concurrency: 1 });
    const windows: Array<[number, number]> = [];
    await Promise.all(Array.from({ length: 5 }, () => queue.enqueue(slowCall(60, windows))));

    expect(windows).toHaveLength(5);
    windows.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < windows.length; i++) {
      expect(overlaps(windows[i - 1], windows[i])).toBe(false);
    }
  }, 10000);

  it('at concurrency 3, overlap appears', async () => {
    const queue = new ServerCallQueue('srv', { concurrency: 3 });
    const windows: Array<[number, number]> = [];
    await Promise.all(Array.from({ length: 5 }, () => queue.enqueue(slowCall(80, windows))));

    expect(windows).toHaveLength(5);
    const anyOverlap = windows.some((a, i) => windows.some((b, j) => i !== j && overlaps(a, b)));
    expect(anyOverlap).toBe(true);
  }, 10000);

  it('setConcurrency widens the gate for calls already queued', async () => {
    const queue = new ServerCallQueue('srv', { concurrency: 1 });
    const windows: Array<[number, number]> = [];
    const calls = Array.from({ length: 4 }, () => queue.enqueue(slowCall(60, windows)));
    queue.setConcurrency(4);
    await Promise.all(calls);

    const anyOverlap = windows.some((a, i) => windows.some((b, j) => i !== j && overlaps(a, b)));
    expect(anyOverlap).toBe(true);
  }, 10000);
});

describe('ServerCallQueue — depth cap', () => {
  it(`rejects the ${CALL_QUEUE_DEPTH_CAP + 1}th call immediately, naming the server and the depth`, async () => {
    const queue = new ServerCallQueue('files', { concurrency: 1 });
    // Fill the cap with calls that never resolve on their own — depth is
    // queued+running, so these never need to finish for this assertion.
    const stuck = () => new Promise<void>(() => {});
    for (let i = 0; i < CALL_QUEUE_DEPTH_CAP; i++) {
      void queue.enqueue(stuck).catch(() => {});
    }
    expect(queue.depth).toBe(CALL_QUEUE_DEPTH_CAP);

    const start = Date.now();
    await expect(queue.enqueue(stuck)).rejects.toThrow(/files/);
    const elapsed = Date.now() - start;
    // The whole point of rejecting synchronously rather than queueing-then-
    // failing: regressing into "accept it, then time it out" would still
    // pass a loose assertion but fail this latency one.
    expect(elapsed).toBeLessThan(50);

    try {
      await queue.enqueue(stuck);
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as Error).message).toMatch(new RegExp(String(CALL_QUEUE_DEPTH_CAP)));
    }
  });
});

describe('ServerCallQueue — per-call timeout', () => {
  it('a call still waiting for a turn times out and says so', async () => {
    const queue = new ServerCallQueue('srv', { concurrency: 1, timeoutMs: 40 });
    const blocker = queue.enqueue(() => new Promise<void>(() => {})); // never resolves, holds the only slot
    // Attached synchronously, in the same tick blocker is created — blocker
    // will itself time out (as "executing") a few ms before `waiter` does,
    // and an unhandled rejection sitting uncaught across the `await` below
    // would otherwise be reported as a spurious failure of THIS test, not of
    // the assertion it's actually making.
    void blocker.catch(() => {});
    const waiter = queue.enqueue(async () => {});

    await expect(waiter).rejects.toThrow(/queued, waiting for a turn/);
  });

  it('a call already executing times out and says so, distinctly from "queued"', async () => {
    const queue = new ServerCallQueue('srv', { concurrency: 1, timeoutMs: 40 });
    const hang = queue.enqueue(() => new Promise<void>(() => {})); // starts immediately (nothing ahead of it)

    await expect(hang).rejects.toThrow(/executing/);
  });

  it('a call that finishes before its deadline resolves normally', async () => {
    const queue = new ServerCallQueue('srv', { concurrency: 1, timeoutMs: 5000 });
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('ServerCallQueue — drain', () => {
  it('rejects only the waiting portion immediately; an already-executing call is left to settle on its own', async () => {
    const queue = new ServerCallQueue('srv', { concurrency: 1 });
    let releaseRunning: (() => void) | undefined;
    const running = queue.enqueue(() => new Promise<void>((resolve) => { releaseRunning = resolve; }));
    const waiting1 = queue.enqueue(async () => 'never runs');
    const waiting2 = queue.enqueue(async () => 'never runs either');

    // Give the first call a tick to actually start executing.
    await new Promise((r) => setTimeout(r, 10));

    queue.drain('Server "srv" is stopped: refusing to run queued calls.');

    await expect(waiting1).rejects.toThrow(/stopped/);
    await expect(waiting2).rejects.toThrow(/stopped/);

    // The running call is untouched by drain — it settles on its own.
    releaseRunning?.();
    await expect(running).resolves.toBeUndefined();
  });

  it('draining an empty queue is a harmless no-op', () => {
    const queue = new ServerCallQueue('srv');
    expect(() => queue.drain('nothing to drain')).not.toThrow();
  });
});
