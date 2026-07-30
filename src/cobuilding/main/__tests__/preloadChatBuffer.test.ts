/**
 * preload's chat event buffer, exercised through the REAL preload module.
 *
 * Two of these guard a regression that the stuck-THINKING fix itself creates.
 * `chat:done` had never once fired in production — the main-side forwarding
 * listener was always torn down before it could — so the buffer's handling of
 * it was dead code. Keeping the pipe alive past a renderer detach makes it fire
 * routinely, at which point a buffered terminator becomes poison: the NEXT
 * stream iterator for that thread drains it, is born `done`, and the next
 * message the user sends renders nothing at all. That would be a worse bug than
 * the one being fixed, so the policy is pinned down here.
 *
 * The overlay case the buffer actually exists for — events arriving before the
 * renderer has subscribed — must keep working, hence the second test.
 */

const listeners = new Map<string, Array<(...args: any[]) => void>>();
const exposed: Record<string, any> = {};

jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, obj: any) => { exposed[name] = obj; },
  },
  ipcRenderer: {
    on: (channel: string, handler: (...args: any[]) => void) => {
      const arr = listeners.get(channel) ?? [];
      arr.push(handler);
      listeners.set(channel, arr);
    },
    removeListener: (channel: string, handler: (...args: any[]) => void) => {
      const arr = listeners.get(channel) ?? [];
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    },
    send: jest.fn(),
    invoke: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
  },
  webUtils: { getPathForFile: jest.fn() },
}));

require('../preload');

/** Deliver an IPC message to every handler preload registered for `channel`. */
function fire(channel: string, ...args: any[]) {
  for (const h of [...(listeners.get(channel) ?? [])]) h(null, ...args);
}

/** Resolves to SENTINEL if the promise hasn't settled by the next macrotask. */
const SENTINEL = Symbol('pending');
function settledOrPending<T>(p: Promise<T>): Promise<T | typeof SENTINEL> {
  return Promise.race([p, new Promise<typeof SENTINEL>((r) => setTimeout(() => r(SENTINEL), 0))]);
}

const chatAPI = () => exposed.chatAPI;

afterEach(() => {
  jest.clearAllMocks();
});

describe('preload chat buffer', () => {
  it('drops a lone chat:done so the NEXT turn is not born already finished', async () => {
    const threadId = 'thread-lone-done';

    // Turn 1 finished and its iterator was released; the terminator arrives
    // with nothing buffered and no active stream.
    fire('chat:done', threadId);

    const sub = chatAPI().subscribe(threadId);
    // NB: hold the SAME promise rather than calling next() again. preload's
    // iterator has one `resolve` slot, so a second next() while the first is
    // pending strands the first and swallows the event that wakes it — the
    // exact hazard chatAdapter's watchdog is written around.
    const first = sub.stream.next();
    expect(await settledOrPending(first)).toBe(SENTINEL); // waiting, not done

    // And it still works normally once real events show up.
    fire('chat:event', threadId, { type: 'text', text: 'hi' });
    expect(await first).toEqual({ value: { type: 'text', text: 'hi' }, done: false });
    sub.unsubscribe();
  });

  it('still buffers a terminator that belongs to a turn nobody has picked up yet', async () => {
    const threadId = 'thread-overlay';

    // The overlay case: main forwards a whole turn before this renderer has
    // subscribed. Events first, so a buffer exists, then the terminator.
    fire('chat:event', threadId, { type: 'text', text: 'from overlay' });
    fire('chat:done', threadId);

    const sub = chatAPI().subscribe(threadId);
    expect(await sub.stream.next()).toEqual({ value: { type: 'text', text: 'from overlay' }, done: false });
    expect(await sub.stream.next()).toEqual({ value: null, done: true });
  });

  it('sendMessage discards buffered leftovers from a previous turn', async () => {
    const threadId = 'thread-stale-events';

    // Leftovers from an earlier turn nobody drained.
    fire('chat:event', threadId, { type: 'text', text: 'STALE' });
    fire('chat:event', threadId, { type: 'turn-complete' });

    const { stream, release } = chatAPI().sendMessage(threadId, 'new question');
    // The new turn must not replay the old turn's tail — and must certainly
    // not inherit its turn-complete, which would end the run instantly.
    const first = stream.next();
    expect(await settledOrPending(first)).toBe(SENTINEL);

    fire('chat:event', threadId, { type: 'text', text: 'FRESH' });
    expect(await first).toEqual({ value: { type: 'text', text: 'FRESH' }, done: false });
    release();
  });

  it('subscribe (unlike sendMessage) still drains a buffer it did not create', async () => {
    const threadId = 'thread-subscribe-drain';
    fire('chat:event', threadId, { type: 'text', text: 'buffered' });

    const sub = chatAPI().subscribe(threadId);
    expect(await sub.stream.next()).toEqual({ value: { type: 'text', text: 'buffered' }, done: false });
    sub.unsubscribe();
  });

  it('exposes getTurnStatus for the stall watchdog', async () => {
    expect(typeof chatAPI().getTurnStatus).toBe('function');
    await chatAPI().getTurnStatus('t');
    const { ipcRenderer } = require('electron');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('chat:turnStatus', 't');
  });
});
