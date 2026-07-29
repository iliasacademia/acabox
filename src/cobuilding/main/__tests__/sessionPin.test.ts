/**
 * Connector OAuth session pinning.
 *
 * The bug being guarded: `mcp__<id>__authenticate` leaves a pending OAuth
 * handshake — callback listener, PKCE verifier, state nonce — inside the CLI
 * subprocess owned by one agent session, and handing the authorization URL to
 * the user is what ENDS the turn. The renderer then unsubscribes, the last
 * subscriber count hits zero, and the registry destroyed the session on the
 * spot. The listener died seconds after the link was printed, so the browser
 * redirect got ERR_CONNECTION_REFUSED and any later `complete_authentication`
 * hit a fresh subprocess that answered "No OAuth flow is in progress".
 *
 * These tests drive the real registry through that exact sequence. The first
 * case deliberately asserts the OLD behaviour on a non-auth tool, so the suite
 * fails loudly if the pin ever starts applying to everything (which would leak
 * subprocesses) as well as if it stops applying to auth (the original bug).
 */
import { OAUTH_FLOW_WINDOW_MS, MCP_AUTHENTICATE_TOOL, MCP_COMPLETE_AUTH_TOOL } from '../../shared/oauthWindow';
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
  hasSession,
  addSubscriber,
  removeSubscriber,
  pinSession,
  unpinSession,
  getSessionPinReason,
  destroyAllSessions,
} from '../sessionRegistry';

/** Minimal stand-in for a live agent session; records whether it was killed. */
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
  const emitDone = () => {
    for (const l of [...listeners]) l.onDone?.();
  };
  return { session, state, emit, emitDone, listenerCount: () => listeners.size };
}

const toolCall = (toolName: string, toolCallId = 'tc-1'): ChatStreamMessage =>
  ({ type: 'tool-call', toolCallId, toolName, args: {}, argsText: '{}' });
const toolResult = (toolCallId: string, isError = false): ChatStreamMessage =>
  ({ type: 'tool-result', toolCallId, result: 'ok', isError });
const turnComplete = (): ChatStreamMessage => ({ type: 'turn-complete' } as ChatStreamMessage);

/** The real end-of-turn sequence: the tool runs, the turn ends, the renderer detaches. */
function runAuthTurn(h: ReturnType<typeof makeSession>, id: string, tool = 'mcp__hex__authenticate') {
  h.state.turnInProgress = true;
  h.emit(toolCall(tool));
  h.state.turnInProgress = false;
  h.emit(turnComplete());
  removeSubscriber(id, 'ipc:1');
}

beforeEach(() => {
  jest.useFakeTimers();
  destroyAllSessions();
});
afterEach(() => {
  destroyAllSessions();
  jest.useRealTimers();
});

describe('the bug: an unpinned session dies at the turn boundary', () => {
  it('destroys an idle session when the last subscriber detaches', () => {
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);

    runAuthTurn(h, 's1', 'Bash');

    expect(h.state.destroyed).toBe(true);
    expect(hasSession('s1')).toBe(false);
  });
});

describe('pinning across the OAuth window', () => {
  it('survives the detach that follows an mcp__<id>__authenticate turn', () => {
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);

    runAuthTurn(h, 's1');

    expect(h.state.destroyed).toBe(false);
    expect(hasSession('s1')).toBe(true);
    expect(getSessionPinReason('s1')).toContain('mcp__hex__authenticate');
  });

  it('suppresses the deferred destroy when the detach lands mid-turn', () => {
    // Renderer navigates away while the tool is still running: removeSubscriber
    // sets pendingDestroy, and turn-complete would normally fire it.
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);

    h.state.turnInProgress = true;
    h.emit(toolCall('mcp__hex__authenticate'));
    removeSubscriber('s1', 'ipc:1');
    expect(h.state.destroyed).toBe(false);

    h.state.turnInProgress = false;
    h.emit(turnComplete());

    expect(h.state.destroyed).toBe(false);
    expect(hasSession('s1')).toBe(true);
  });

  it('holds for the full window and not a millisecond longer', () => {
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);
    runAuthTurn(h, 's1');

    jest.advanceTimersByTime(OAUTH_FLOW_WINDOW_MS - 1);
    expect(h.state.destroyed).toBe(false);

    jest.advanceTimersByTime(1);
    expect(h.state.destroyed).toBe(true);
    expect(hasSession('s1')).toBe(false);
  });

  it('keeps the session when a subscriber reattached before the window closed', () => {
    // The user came back to the chat. Expiry must apply the normal policy, not
    // blindly destroy what it was protecting.
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);
    runAuthTurn(h, 's1');

    addSubscriber('s1', 'ipc:2');
    jest.advanceTimersByTime(OAUTH_FLOW_WINDOW_MS + 1);

    expect(h.state.destroyed).toBe(false);
    expect(hasSession('s1')).toBe(true);
    expect(getSessionPinReason('s1')).toBeNull();
  });

  it('does not destroy on expiry while a turn is in flight', () => {
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);
    runAuthTurn(h, 's1');

    h.state.turnInProgress = true;
    jest.advanceTimersByTime(OAUTH_FLOW_WINDOW_MS + 1);

    expect(h.state.destroyed).toBe(false);
  });
});

describe('releasing the pin', () => {
  it('releases early once the manual-paste fallback returns', () => {
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);

    h.state.turnInProgress = true;
    h.emit(toolCall('mcp__hex__authenticate', 'tc-auth'));
    h.emit(toolCall('mcp__hex__complete_authentication', 'tc-done'));
    h.emit(toolResult('tc-done'));

    expect(getSessionPinReason('s1')).toBeNull();
  });

  it('releases early even when the manual completion errored', () => {
    // Redeemed or rejected, the wait is over — holding a subprocess for the
    // remainder of the window buys nothing.
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);

    h.emit(toolCall('mcp__hex__authenticate', 'tc-auth'));
    h.emit(toolCall('mcp__hex__complete_authentication', 'tc-done'));
    h.emit(toolResult('tc-done', true));

    expect(getSessionPinReason('s1')).toBeNull();
  });

  it('ignores a tool-result that does not belong to a completion call', () => {
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);

    h.emit(toolCall('mcp__hex__authenticate', 'tc-auth'));
    h.emit(toolResult('tc-auth'));
    h.emit(toolResult('some-other-call'));

    expect(getSessionPinReason('s1')).toContain('mcp__hex__authenticate');
  });

  it('restarts the clock on re-pin instead of stacking timers', () => {
    // A second authenticate aborts the CLI's first flow and starts a fresh
    // one, so the new window is the correct one — and the old timer must not
    // fire mid-way through it.
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);
    runAuthTurn(h, 's1');

    jest.advanceTimersByTime(OAUTH_FLOW_WINDOW_MS - 1000);
    h.emit(toolCall('mcp__hex__authenticate', 'tc-2'));

    jest.advanceTimersByTime(2000);
    expect(h.state.destroyed).toBe(false);

    jest.advanceTimersByTime(OAUTH_FLOW_WINDOW_MS);
    expect(h.state.destroyed).toBe(true);
  });

  it('drops the pin and evicts when the session loop ends under it', () => {
    // Server-side idle eviction, /stop, or a crash: the subprocess is gone, so
    // the pin protects nothing and must not keep a dead entry (or its timer)
    // alive for the rest of the window.
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);
    h.emit(toolCall('mcp__hex__authenticate'));
    removeSubscriber('s1', 'ipc:1');
    expect(getSessionPinReason('s1')).not.toBeNull();

    h.emitDone();

    expect(getSessionPinReason('s1')).toBeNull();
    expect(hasSession('s1')).toBe(false);
  });

  it('never blocks an explicit unregister', () => {
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);
    h.emit(toolCall('mcp__hex__authenticate'));

    unregisterSession('s1');

    expect(h.state.destroyed).toBe(true);
    expect(hasSession('s1')).toBe(false);
  });

  it('does not resurrect a destroyed session when its orphaned timer fires', () => {
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);
    h.emit(toolCall('mcp__hex__authenticate'));
    unregisterSession('s1');

    const replacement = makeSession();
    addSubscriber('s1', 'ipc:9');
    registerSession('s1', replacement.session);

    jest.advanceTimersByTime(OAUTH_FLOW_WINDOW_MS * 2);

    // The first session's timer must not reach the id's new occupant.
    expect(replacement.state.destroyed).toBe(false);
    expect(hasSession('s1')).toBe(true);
  });

  it('drops the old pin when a session is replaced in place', () => {
    const h = makeSession();
    addSubscriber('s1', 'ipc:1');
    registerSession('s1', h.session);
    h.emit(toolCall('mcp__hex__authenticate'));

    const replacement = makeSession();
    registerSession('s1', replacement.session);

    expect(getSessionPinReason('s1')).toBeNull();
    jest.advanceTimersByTime(OAUTH_FLOW_WINDOW_MS * 2);
    expect(replacement.state.destroyed).toBe(false);
  });

  it('is a no-op to pin or unpin an unknown session', () => {
    expect(() => pinSession('nope', 'test')).not.toThrow();
    expect(() => unpinSession('nope', 'test')).not.toThrow();
    expect(getSessionPinReason('nope')).toBeNull();
  });
});

describe('which tools arm the pin', () => {
  it.each([
    'mcp__hex__authenticate',
    'mcp__sentry__authenticate',
    'mcp__linear-app__authenticate',
  ])('%s arms it', (name) => {
    expect(MCP_AUTHENTICATE_TOOL.test(name)).toBe(true);
  });

  it.each([
    // A pin holds an API-key-bearing subprocess alive; only the real auth
    // tools may do that.
    'authenticate',
    'Bash',
    'mcp__hex__authenticate_user',
    'x_mcp__hex__authenticate',
    'mcp__hex__complete_authentication',
    'mcp__mini-apps__call_published_tool',
    'mcp__HEX__authenticate',
  ])('%s does not', (name) => {
    expect(MCP_AUTHENTICATE_TOOL.test(name)).toBe(false);
  });

  it('matches the completion tool separately', () => {
    expect(MCP_COMPLETE_AUTH_TOOL.test('mcp__hex__complete_authentication')).toBe(true);
    expect(MCP_COMPLETE_AUTH_TOOL.test('mcp__hex__authenticate')).toBe(false);
  });

  it('pins for exactly the CLI flow ceiling', () => {
    // The CLI arms setTimeout(...,300000) on a pending flow with no knob.
    // Shorter throws away a live flow; longer holds a process that can no
    // longer accomplish anything.
    expect(OAUTH_FLOW_WINDOW_MS).toBe(300_000);
  });
});
