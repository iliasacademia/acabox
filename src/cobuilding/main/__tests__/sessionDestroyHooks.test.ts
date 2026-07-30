/**
 * Session destroy hooks, and the invariant they exist to protect.
 *
 * The bug: `chat:unsubscribe` used to tear down the main→renderer event pipe
 * as well as the visibility refcount. Those are unrelated. A renderer that
 * merely navigated to another thread killed the delivery path for a turn that
 * was still running — and because there is no replay on that hop, every
 * remaining event of that turn, INCLUDING `turn-complete`, was emitted into an
 * empty listener set and lost. The renderer's run generator then awaited a
 * message that would never arrive, so the thread showed THINKING… forever and
 * only a full app reload recovered it. Measured in a real production log
 * before the fix: 31 turns emitted a terminator, only 24 were forwarded.
 *
 * The fix keeps the pipe attached until the SESSION dies rather than until the
 * renderer looks away, which requires a way to learn that a session died —
 * `onSessionDestroyed`. Without it the stale entry in `ensureForwarding` would
 * match a destroyed session forever and the thread would go permanently deaf,
 * which is strictly worse than the bug being fixed. Hence these tests.
 */
import type { ChatStreamMessage } from '../../shared/types';
import type { AgentSession, ChatCallbacks } from '../agentSession';

jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../shared/telemetry', () => ({ captureError: jest.fn() }));

import {
  registerSession,
  unregisterSession,
  destroyAllSessions,
  addSubscriber,
  removeSubscriber,
  onSessionDestroyed,
} from '../sessionRegistry';

function makeSession() {
  const listeners = new Set<Partial<ChatCallbacks>>();
  const state = { destroyed: false, turnInProgress: false };
  const session: AgentSession = {
    sendMessage: () => {},
    destroy: () => { state.destroyed = true; },
    addListener: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    get isRunning() { return !state.destroyed; },
    get isTurnInProgress() { return state.turnInProgress; },
  };
  const emit = (msg: ChatStreamMessage) => {
    for (const l of [...listeners]) l.onEvent?.(msg);
  };
  return { session, state, emit };
}

const TURN_COMPLETE = { type: 'turn-complete' } as ChatStreamMessage;
const TEXT = { type: 'text', text: 'hello' } as ChatStreamMessage;

/**
 * Stand-in for `ensureForwarding`'s pipe: a listener on the session whose
 * teardown is registered as a destroy hook, exactly as main/index.ts wires it.
 * `delivered` is what the renderer would actually have received.
 */
function attachPipe(id: string, session: AgentSession) {
  const delivered: string[] = [];
  const detach = session.addListener({ onEvent: (m) => { delivered.push(m.type); } });
  let live = true;
  const off = onSessionDestroyed(id, () => { live = false; detach(); });
  return { delivered, off, isLive: () => live };
}

afterEach(() => {
  destroyAllSessions();
  jest.clearAllMocks();
});

describe('onSessionDestroyed', () => {
  it('fires when the session is unregistered', () => {
    const { session } = makeSession();
    registerSession('s1', session);
    const hook = jest.fn();
    onSessionDestroyed('s1', hook);

    expect(hook).not.toHaveBeenCalled();
    unregisterSession('s1');
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('fires when a session is REPLACED, so a pipe bound to the old instance is dropped', () => {
    const first = makeSession();
    registerSession('s1', first.session);
    const hook = jest.fn();
    onSessionDestroyed('s1', hook);

    // A crash-restart, or a second createAgentSession for the same thread.
    const second = makeSession();
    registerSession('s1', second.session);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(first.state.destroyed).toBe(true);
    expect(second.state.destroyed).toBe(false);
  });

  it('does not fire twice, and a later session does not inherit the old hook', () => {
    const { session } = makeSession();
    registerSession('s1', session);
    const hook = jest.fn();
    onSessionDestroyed('s1', hook);

    unregisterSession('s1');
    unregisterSession('s1');
    expect(hook).toHaveBeenCalledTimes(1);

    const next = makeSession();
    registerSession('s1', next.session);
    unregisterSession('s1');
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('the returned unregister prevents the hook from firing', () => {
    const { session } = makeSession();
    registerSession('s1', session);
    const hook = jest.fn();
    const off = onSessionDestroyed('s1', hook);
    off();

    unregisterSession('s1');
    expect(hook).not.toHaveBeenCalled();
  });

  it('a hook that throws stops neither the other hooks nor the destroy', () => {
    const { session, state } = makeSession();
    registerSession('s1', session);
    const good = jest.fn();
    onSessionDestroyed('s1', () => { throw new Error('boom'); });
    onSessionDestroyed('s1', good);

    expect(() => unregisterSession('s1')).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(state.destroyed).toBe(true);
  });
});

describe('the pipe survives a mid-turn detach (the actual regression)', () => {
  it('keeps delivering, including turn-complete, after the renderer navigates away', () => {
    const { session, state, emit } = makeSession();
    registerSession('s1', session);
    addSubscriber('s1', 'ipc:1');
    const pipe = attachPipe('s1', session);

    state.turnInProgress = true;
    // The user switches threads two seconds into the turn. Under the old code
    // this ran cleanup() and the pipe died right here.
    removeSubscriber('s1', 'ipc:1');

    expect(pipe.isLive()).toBe(true);
    expect(state.destroyed).toBe(false);

    emit(TEXT);
    state.turnInProgress = false;
    emit(TURN_COMPLETE);

    expect(pipe.delivered).toEqual(['text', 'turn-complete']);
  });

  it('tears the pipe down once the deferred destroy fires — but only after the terminator', () => {
    const { session, state, emit } = makeSession();
    registerSession('s1', session);
    addSubscriber('s1', 'ipc:1');
    const pipe = attachPipe('s1', session);

    state.turnInProgress = true;
    removeSubscriber('s1', 'ipc:1');
    expect(pipe.isLive()).toBe(true);

    state.turnInProgress = false;
    emit(TURN_COMPLETE);

    expect(pipe.delivered).toContain('turn-complete');
    expect(state.destroyed).toBe(true);
    expect(pipe.isLive()).toBe(false);
  });

  it('a returning subscriber cancels the deferred destroy and keeps one live pipe', () => {
    const { session, state, emit } = makeSession();
    registerSession('s1', session);
    addSubscriber('s1', 'ipc:1');
    const pipe = attachPipe('s1', session);

    state.turnInProgress = true;
    removeSubscriber('s1', 'ipc:1');
    addSubscriber('s1', 'ipc:1'); // user comes back mid-turn

    state.turnInProgress = false;
    emit(TURN_COMPLETE);

    expect(pipe.delivered).toEqual(['turn-complete']);
    expect(state.destroyed).toBe(false);
    expect(pipe.isLive()).toBe(true);
  });

  it('detaching while idle still destroys immediately — no behaviour change there', () => {
    const { session, state } = makeSession();
    registerSession('s1', session);
    addSubscriber('s1', 'ipc:1');
    const pipe = attachPipe('s1', session);

    state.turnInProgress = false;
    removeSubscriber('s1', 'ipc:1');

    expect(state.destroyed).toBe(true);
    expect(pipe.isLive()).toBe(false);
  });
});
