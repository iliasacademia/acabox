/**
 * @jest-environment node
 *
 * The user's Stop (docs/design/review-increment-1-tickets.md, T02). Before
 * this, Stop destroyed the session without a result row, and the next message's
 * orphan sweep DELETED every assistant/tool row after the last result
 * (production lost 237 rows on one Stop). Now Stop interrupts, the turn's own
 * result is kept, and a host-authored `stopped` row closes whatever did not
 * get one.
 *
 * Driven against the REAL `createAgentSession`, the REAL SQLite chat store and
 * the REAL SSE reader, with only the agent server replaced by a loopback HTTP
 * server that speaks its routes (/health, /sessions, /events, /messages,
 * /interrupt, /stop). `electron`/`electron-log`/`containerService` are the only
 * mocks.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { randomUUID } from 'crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-stopturn-'));
const mockAgent = { port: 0 };

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, isPackaged: false },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../containerService', () => ({
  containerService: {
    isRunning: () => true,
    getAgentPort: () => mockAgent.port,
  },
}));

import { initDatabase, closeDatabase, getDatabase } from '../db/database';
import { getMessages } from '../db/chatRepository';
import { createAgentSession, runStop, stoppedTurnRows, INTERRUPT_WAIT_MS } from '../agentSession';
import { registerSession, stopSession, hasSession } from '../sessionRegistry';
import type { ChatStreamMessage } from '../../shared/types';

// ─── A stand-in agent server ──────────────────────────────────────

interface FakeAgent {
  server: http.Server;
  calls: string[];
  sse: http.ServerResponse | null;
  /** What /interrupt does after replying: optionally emit a result. */
  onInterrupt: () => void;
  interruptStatus: number;
  push(message: unknown): void;
}

function startFakeAgent(): Promise<FakeAgent> {
  let seq = 0;
  const fake: FakeAgent = {
    server: null as unknown as http.Server,
    calls: [],
    sse: null,
    onInterrupt: () => {},
    interruptStatus: 200,
    push(message) {
      fake.sse?.write(`id: ${++seq}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
    },
  };
  fake.server = http.createServer((req, res) => {
    const url = req.url ?? '';
    fake.calls.push(`${req.method} ${url}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url === '/health') return json(200, { status: 'ok' });
    if (req.method === 'POST' && url === '/sessions') { req.resume(); return json(201, { sessionId: 'agent-1' }); }
    if (req.method === 'GET' && url.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(':ok\n\n');
      fake.sse = res;
      return;
    }
    if (req.method === 'POST' && url.endsWith('/interrupt')) {
      req.resume();
      json(fake.interruptStatus, { ok: fake.interruptStatus === 200 });
      if (fake.interruptStatus === 200) setTimeout(() => fake.onInterrupt(), 10);
      return;
    }
    req.resume();
    json(200, { ok: true });
  });
  return new Promise((resolve) => fake.server.listen(0, '127.0.0.1', () => {
    mockAgent.port = (fake.server.address() as { port: number }).port;
    resolve(fake);
  }));
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ─── Fixture ──────────────────────────────────────────────────────

let workspaceId: string;
const workspace = () => ({
  id: workspaceId, name: 'T', directory_path: tmpDir, api_key: 'k',
  created_at: '', updated_at: '', last_accessed_at: null,
});

beforeAll(() => {
  initDatabase(tmpDir);
  workspaceId = randomUUID();
  getDatabase()
    .prepare('INSERT INTO workspaces (id, name, directory_path, api_key) VALUES (?, ?, ?, ?)')
    .run(workspaceId, 'Test Workspace', tmpDir, 'test-key');
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let fake: FakeAgent;
beforeEach(async () => { fake = await startFakeAgent(); });
afterEach(() => { fake.sse?.end(); fake.server.close(); });

const TOOL_USE = {
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 100' } }] },
};

/** A session with a turn in flight and one assistant row already stored. */
async function startTurn() {
  const sessionId = randomUUID();
  const events: ChatStreamMessage[] = [];
  const session = createAgentSession(sessionId, { onEvent: (m: ChatStreamMessage) => events.push(m) } as any, workspace() as any);
  session.sendMessage('do the long thing', undefined, 'm1');
  await until(() => fake.sse !== null && fake.calls.some((c) => c.endsWith('/messages')));
  fake.push(TOOL_USE);
  await until(() => getMessages(sessionId).some((r) => r.type === 'assistant'));
  return { sessionId, session, events };
}

const rows = (sessionId: string) => getMessages(sessionId).map((r) => ({ type: r.type, content: JSON.parse(r.content) }));
const resultRows = (sessionId: string) => rows(sessionId).filter((r) => r.type === 'result').map((r) => r.content);
const turnCompletes = (events: ChatStreamMessage[]) => events.filter((e) => e.type === 'turn-complete');

// ─── Tests ────────────────────────────────────────────────────────

describe('stop -> interrupt -> the CLI answers', () => {
  it('keeps the CLI\'s own result, tags it, and writes no host row', async () => {
    const { sessionId, session, events } = await startTurn();
    fake.onInterrupt = () => fake.push({ type: 'result', subtype: 'error_during_execution', is_error: true });

    await session.stop('user');
    // The hard /stop is fire-and-forget, so give it a moment to land.
    await until(() => fake.calls.includes('POST /sessions/agent-1/stop'));

    expect(fake.calls).toContain('POST /sessions/agent-1/interrupt');
    expect(fake.calls).toContain('POST /sessions/agent-1/stop');
    // interrupt strictly before the hard stop
    expect(fake.calls.indexOf('POST /sessions/agent-1/interrupt')).toBeLessThan(fake.calls.indexOf('POST /sessions/agent-1/stop'));
    const results = resultRows(sessionId);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subtype: 'error_during_execution', stopped_by: 'user' });
    // No host-authored line: the model's own turn is the record.
    expect(JSON.stringify(rows(sessionId))).not.toContain('Stopped by you');
    expect(turnCompletes(events)).toHaveLength(1);
    expect(session.isTurnInProgress).toBe(false);
  });
});

describe('stop -> no answer in time', () => {
  it('writes the stopped rows itself, and nothing the CLI says afterwards', async () => {
    const { sessionId, session, events } = await startTurn();
    // /interrupt is acknowledged but the CLI never produces a result.
    const started = Date.now();
    await session.stop('user');
    expect(Date.now() - started).toBeGreaterThanOrEqual(INTERRUPT_WAIT_MS - 100);

    const tail = rows(sessionId).slice(-2);
    expect(tail[0]).toEqual({ type: 'assistant', content: [{ type: 'text', text: 'Stopped by you.' }] });
    expect(tail[1].type).toBe('result');
    expect(tail[1].content).toEqual({ subtype: 'stopped', result: '', is_error: false, stopped_by: 'user' });
    expect(turnCompletes(events)).toHaveLength(1);

    // The reply blaming "the sandbox" that arrives after the stop: not kept.
    const before = getMessages(sessionId).length;
    fake.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'The sandbox killed my command.' }] } });
    fake.push({ type: 'result', subtype: 'success', result: 'x', is_error: false });
    await new Promise((r) => setTimeout(r, 150));
    expect(getMessages(sessionId)).toHaveLength(before);
    expect(turnCompletes(events)).toHaveLength(1);
  }, 15_000);

  it('does not wait when the interrupt could not be delivered', async () => {
    const { sessionId, session } = await startTurn();
    fake.interruptStatus = 409;
    const started = Date.now();
    await session.stop('user');
    expect(Date.now() - started).toBeLessThan(INTERRUPT_WAIT_MS - 1000);
    expect(resultRows(sessionId)).toEqual([{ subtype: 'stopped', result: '', is_error: false, stopped_by: 'user' }]);
  });
});

describe('destroy', () => {
  it('writes the teardown wording when a turn is open and no reason says otherwise', async () => {
    const { sessionId, session } = await startTurn();
    session.destroy();
    expect(JSON.stringify(rows(sessionId))).toContain('Acabox closed this chat before the reply finished');
    expect(resultRows(sessionId)).toEqual([{ subtype: 'stopped', result: '', is_error: false, stopped_by: 'teardown' }]);
  });

  it('writes nothing when no turn is open', () => {
    const sessionId = randomUUID();
    const session = createAgentSession(sessionId, {} as any, workspace() as any);
    session.destroy();
    expect(getMessages(sessionId)).toHaveLength(0);
  });

  it('is idempotent: a second destroy adds no rows and posts no second /stop', async () => {
    const { sessionId, session } = await startTurn();
    session.destroy('user');
    const count = getMessages(sessionId).length;
    session.destroy('user');
    session.destroy();
    await session.stop('user');
    expect(getMessages(sessionId)).toHaveLength(count);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls.filter((c) => c.endsWith('/stop'))).toHaveLength(1);
  });
});

describe('the registry\'s stopSession', () => {
  it('stops, then unregisters; the deferred-destroy race writes no second row', async () => {
    const { sessionId, session } = await startTurn();
    registerSession(sessionId, session);
    fake.onInterrupt = () => fake.push({ type: 'result', subtype: 'error_during_execution', is_error: true });
    await stopSession(sessionId, 'user');
    expect(hasSession(sessionId)).toBe(false);
    expect(resultRows(sessionId)).toHaveLength(1);
  });
});

describe('runStop ordering', () => {
  const mk = (over: Partial<Parameters<typeof runStop>[0]> = {}) => {
    const order: string[] = [];
    const deps = {
      turnInProgress: true,
      interrupt: async () => { order.push('interrupt'); return true; },
      waitForResult: async () => { order.push('wait'); return true; },
      destroy: () => { order.push('destroy'); },
      ...over,
    };
    return { deps, order };
  };

  it('idle: just destroys', async () => {
    const { deps, order } = mk({ turnInProgress: false });
    expect(await runStop(deps)).toBe('idle');
    expect(order).toEqual(['destroy']);
  });
  it('interrupt, wait, destroy', async () => {
    const { deps, order } = mk();
    expect(await runStop(deps)).toBe('result');
    expect(order).toEqual(['interrupt', 'wait', 'destroy']);
  });
  it('timeout still destroys', async () => {
    const { deps, order } = mk({ waitForResult: async () => false });
    expect(await runStop(deps)).toBe('timeout');
    expect(order[order.length - 1]).toBe('destroy');
  });
  it('a throwing interrupt still destroys', async () => {
    const { deps, order } = mk({ interrupt: async () => { throw new Error('boom'); } });
    await expect(runStop(deps)).rejects.toThrow('boom');
    expect(order).toEqual(['destroy']);
  });
});

describe('stoppedTurnRows', () => {
  it('words a user stop and a teardown differently, and tags the row', () => {
    expect(stoppedTurnRows('user').text).toBe('Stopped by you.');
    expect(stoppedTurnRows('teardown').text).toMatch(/^Stopped — Acabox closed this chat/);
    expect(stoppedTurnRows('crash').text).toBeNull();
    expect(stoppedTurnRows('user').result).toEqual({ subtype: 'stopped', result: '', is_error: false, stopped_by: 'user' });
  });
});
