/**
 * chatAdapter's stall watchdog.
 *
 * Before this existed, the run generator's `for await` on the event stream had
 * no timeout of any kind. If the stream ever went silent — which happened
 * whenever a mid-turn detach killed the main→renderer pipe, since that hop has
 * no replay — the generator parked forever, assistant-ui never moved the
 * message off `status: 'running'`, and the thread showed THINKING… until the
 * whole app was reloaded.
 *
 * The watchdog makes silence a decidable condition: main heartbeats every 15s
 * for the life of a session regardless of what the model is doing, so 45s of
 * nothing means the pipe is broken rather than the agent being slow.
 *
 * The subtle part these tests exist for is the single-outstanding-`next()`
 * invariant. preload's iterator holds ONE `resolve` slot, so calling `next()`
 * a second time while one is pending overwrites it and drops the wakeup — a
 * naive `Promise.race` that re-issues `next()` each loop would convert a
 * recoverable stall into a permanent one.
 */
import type { ChatStreamMessage } from '../../shared/types';

// `@assistant-ui/react` transitively loads `assistant-stream`, which is ESM and
// needs web streams (TransformStream) that jsdom does not provide. The adapter
// only imports one VALUE from it (`useAui`) — everything else is `import type`
// and erased — and these tests construct the adapter directly rather than
// through the hook, so stubbing the module keeps the blast radius here instead
// of in the shared jest config.
jest.mock('@assistant-ui/react', () => ({ useAui: () => ({}) }));
jest.mock('../coscientistAnalytics', () => ({ track: jest.fn() }));
jest.mock('../components/ModelSelector', () => ({
  getSelectedModel: () => 'claude-opus-5',
  getSelectedEffort: () => 'high',
}));

import { createElectronChatAdapter } from '../chatAdapter';
import { RECONNECTING_LABEL } from '../progressStore';

const STALL_MS = 45_000;

/**
 * A stream whose `next()` never resolves on its own — the test pushes values
 * in. Records how many times `next()` was called so the single-outstanding
 * invariant can be asserted directly.
 */
function makeControllableStream() {
  let pendingResolve: ((v: { value: ChatStreamMessage | null; done: boolean }) => void) | null = null;
  const queued: { value: ChatStreamMessage | null; done: boolean }[] = [];
  let nextCalls = 0;

  const stream = {
    next: () => {
      nextCalls++;
      const ready = queued.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<{ value: ChatStreamMessage | null; done: boolean }>((r) => {
        pendingResolve = r;
      });
    },
  };

  const push = (msg: ChatStreamMessage) => {
    const item = { value: msg, done: false };
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(item);
    } else {
      queued.push(item);
    }
  };

  return { stream, push, nextCalls: () => nextCalls };
}

function installChatApi(overrides: Partial<Record<string, any>> = {}) {
  const release = jest.fn();
  const api: any = {
    sendMessage: jest.fn(),
    stopResponding: jest.fn(),
    isTurnInProgress: jest.fn().mockResolvedValue(false),
    getTurnStatus: jest.fn().mockResolvedValue({ turnInProgress: false, sessionAlive: false }),
    ...overrides,
  };
  (window as any).chatAPI = api;
  (window as any).toolAnalyticsAPI = { setThreadCreationPrompt: jest.fn().mockResolvedValue(undefined) };
  (window as any).debugAPI = { log: jest.fn() };
  return { api, release };
}

function makeAdapter(threadId = 'thread-1') {
  const aui = { threadListItem: () => ({ initialize: async () => ({ remoteId: threadId }) }) };
  return createElectronChatAdapter(aui, { current: undefined } as any);
}

const userMessages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];

/** Drives the adapter's async generator to completion in the background. */
function drive(adapter: any, signal: AbortSignal) {
  const yields: any[] = [];
  const done = (async () => {
    for await (const chunk of adapter.run({ messages: userMessages, abortSignal: signal, context: {} })) {
      yields.push(chunk);
    }
  })();
  return { yields, done };
}

beforeEach(() => {
  jest.useFakeTimers();
  if (!(globalThis.crypto as any)?.randomUUID) {
    (globalThis as any).crypto = { ...(globalThis.crypto ?? {}), randomUUID: () => 'uuid-test' };
  }
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('stall watchdog', () => {
  it('ends the run when the stream is silent and main says the turn is already over', async () => {
    const { stream, push } = makeControllableStream();
    const release = jest.fn();
    const { api } = installChatApi({
      sendMessage: jest.fn(() => ({ stream, release })),
      getTurnStatus: jest.fn().mockResolvedValue({ turnInProgress: false, sessionAlive: false }),
    });

    const stalledEvents: string[] = [];
    window.addEventListener('chat:stream-stalled', (e) => {
      stalledEvents.push(((e as CustomEvent).detail as any).threadId);
    });

    const ac = new AbortController();
    const { done } = drive(makeAdapter(), ac.signal);

    // Let the generator reach its first await.
    await jest.advanceTimersByTimeAsync(0);
    push({ type: 'text', text: 'partial' } as ChatStreamMessage);
    await jest.advanceTimersByTimeAsync(0);

    // Now go silent past the threshold.
    await jest.advanceTimersByTimeAsync(STALL_MS + 10);
    await done;

    expect(api.getTurnStatus).toHaveBeenCalledWith('thread-1');
    expect(release).toHaveBeenCalled();

    // The reconcile signal is deferred by a macrotask so assistant-ui has
    // marked the message complete before any history reload runs.
    await jest.advanceTimersByTimeAsync(1);
    expect(stalledEvents).toEqual(['thread-1']);
  });

  it('keeps waiting — and only ever has ONE next() outstanding — while main says the turn is running', async () => {
    const { stream, push, nextCalls } = makeControllableStream();
    const { api } = installChatApi({
      sendMessage: jest.fn(() => ({ stream, release: jest.fn() })),
      getTurnStatus: jest.fn().mockResolvedValue({ turnInProgress: true, sessionAlive: true }),
    });

    const ac = new AbortController();
    const { done } = drive(makeAdapter(), ac.signal);
    await jest.advanceTimersByTimeAsync(0);

    const callsAfterFirstNext = nextCalls();
    expect(callsAfterFirstNext).toBe(1);

    // Three consecutive stall windows with the host reporting work in flight.
    await jest.advanceTimersByTimeAsync(STALL_MS + 10);
    await jest.advanceTimersByTimeAsync(STALL_MS + 10);
    await jest.advanceTimersByTimeAsync(STALL_MS + 10);

    expect(api.getTurnStatus).toHaveBeenCalledTimes(3);
    // The critical assertion: re-issuing next() here would clobber preload's
    // single resolve slot and lose the wakeup forever.
    expect(nextCalls()).toBe(1);

    // The pipe recovers; the run must still terminate normally.
    push({ type: 'turn-complete' } as ChatStreamMessage);
    await jest.advanceTimersByTimeAsync(0);
    await done;
  });

  it('surfaces RECONNECTING while stalled, then clears it when events resume', async () => {
    const { stream, push } = makeControllableStream();
    installChatApi({
      sendMessage: jest.fn(() => ({ stream, release: jest.fn() })),
      getTurnStatus: jest.fn().mockResolvedValue({ turnInProgress: true, sessionAlive: true }),
    });
    const progress = require('../progressStore');
    const setLabel = jest.spyOn(progress, 'setProcessingLabel');

    const ac = new AbortController();
    const { done } = drive(makeAdapter(), ac.signal);
    await jest.advanceTimersByTimeAsync(0);

    await jest.advanceTimersByTimeAsync(STALL_MS + 10);
    expect(setLabel).toHaveBeenCalledWith(RECONNECTING_LABEL);

    setLabel.mockClear();
    push({ type: 'text', text: 'back' } as ChatStreamMessage);
    await jest.advanceTimersByTimeAsync(0);
    expect(setLabel).toHaveBeenCalledWith(null);

    push({ type: 'turn-complete' } as ChatStreamMessage);
    await jest.advanceTimersByTimeAsync(0);
    await done;
    setLabel.mockRestore();
  });

  it('a normal turn is untouched: no status probe, no stall event', async () => {
    const { stream, push } = makeControllableStream();
    const { api } = installChatApi({
      sendMessage: jest.fn(() => ({ stream, release: jest.fn() })),
    });
    const stalledEvents: string[] = [];
    window.addEventListener('chat:stream-stalled', (e) => {
      stalledEvents.push(((e as CustomEvent).detail as any).threadId);
    });

    const ac = new AbortController();
    const { yields, done } = drive(makeAdapter('thread-normal'), ac.signal);
    await jest.advanceTimersByTimeAsync(0);

    push({ type: 'text', text: 'answer' } as ChatStreamMessage);
    await jest.advanceTimersByTimeAsync(0);
    push({ type: 'turn-complete' } as ChatStreamMessage);
    await jest.advanceTimersByTimeAsync(0);
    await done;

    expect(api.getTurnStatus).not.toHaveBeenCalled();
    expect(stalledEvents).toEqual([]);
    expect(yields.length).toBeGreaterThan(0);
  });

  it('a stream that closes (done) ends the run without claiming a stall', async () => {
    let resolveNext: ((v: any) => void) | null = null;
    const stream = {
      next: () => new Promise<any>((r) => { resolveNext = r; }),
    };
    const { api } = installChatApi({ sendMessage: jest.fn(() => ({ stream, release: jest.fn() })) });
    const stalledEvents: string[] = [];
    window.addEventListener('chat:stream-stalled', (e) => {
      stalledEvents.push(((e as CustomEvent).detail as any).threadId);
    });

    const ac = new AbortController();
    const { done } = drive(makeAdapter('thread-closed'), ac.signal);
    await jest.advanceTimersByTimeAsync(0);

    resolveNext!({ value: null, done: true });
    await jest.advanceTimersByTimeAsync(0);
    await done;

    expect(api.getTurnStatus).not.toHaveBeenCalled();
    expect(stalledEvents).toEqual([]);
  });
});
