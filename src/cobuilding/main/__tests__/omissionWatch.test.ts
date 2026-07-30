/**
 * The inverted omission rule and its review store.
 *
 * The classifier is where the value is: it must be silent on the healthy path
 * (a session that consulted the ledger, or never touched a connector) and must
 * not mistake Acabox's own relay servers for a trip to the warehouse.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-omission-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  classifyTurn,
  connectorIdOfTool,
  isFindingsRead,
  noteTurn,
  addKnowledgeReview,
  listKnowledgeReviews,
  dismissKnowledgeReview,
  subscribeKnowledgeReviews,
  __resetKnowledgeReviews,
} from '../knowledge/omissionWatch';

const storeFile = path.join(tmpDir, 'knowledge-review.json');

const LEDGER_READ =
  '/Users/x/Library/Application Support/acabox/development/skills/coscientist-analytics/references/findings/messages.md';

beforeEach(() => {
  __resetKnowledgeReviews();
  fs.rmSync(storeFile, { force: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('connectorIdOfTool', () => {
  it('reads the server id out of an mcp tool name', () => {
    expect(connectorIdOfTool('mcp__hex__create_thread')).toBe('hex');
    expect(connectorIdOfTool('mcp__sentry__search_issues')).toBe('sentry');
    expect(connectorIdOfTool('mcp__my_server__do')).toBe('my_server');
  });

  it('does not count Acabox talking to itself as a connector', () => {
    // These are relay servers. Treating them as connectors would raise a review
    // row on every mini-app turn, which is the failure mode this rule exists to
    // avoid on the other side.
    expect(connectorIdOfTool('mcp__workspace__get_scanned_files')).toBeNull();
    expect(connectorIdOfTool('mcp__mini-apps__open_mini_application')).toBeNull();
    expect(connectorIdOfTool('mcp__activity__query_activity')).toBeNull();
    expect(connectorIdOfTool('mcp__notification__show_notification')).toBeNull();
    expect(connectorIdOfTool('mcp__reaction__x')).toBeNull();
    expect(connectorIdOfTool('mcp__knowledge__record_finding')).toBeNull();
  });

  it('is null for ordinary tools', () => {
    expect(connectorIdOfTool('Bash')).toBeNull();
    expect(connectorIdOfTool('Read')).toBeNull();
    expect(connectorIdOfTool('Skill')).toBeNull();
    expect(connectorIdOfTool('')).toBeNull();
  });
});

describe('isFindingsRead', () => {
  it('recognises the ledger through either spelling of the path', () => {
    expect(isFindingsRead(LEDGER_READ)).toBe(true);
    expect(isFindingsRead('.claude/skills/coscientist-analytics/references/findings/index.md')).toBe(true);
    expect(isFindingsRead('.claude/skills/coscientist-analytics/references/tables.md')).toBe(false);
    expect(isFindingsRead('MyResearch/data.csv')).toBe(false);
  });
});

describe('classifyTurn', () => {
  it('fires only when a connector ran and no findings file was read', () => {
    expect(classifyTurn({ toolNames: ['mcp__hex__create_thread'], readPaths: [] })).toBe('omitted-ledger');
  });

  it('is silent when the ledger was consulted', () => {
    expect(
      classifyTurn({ toolNames: ['mcp__hex__create_thread'], readPaths: [LEDGER_READ] }),
    ).toBe('consulted-ledger');
  });

  /**
   * The naive rule — "a skill was used and nothing was recorded" — fires here,
   * on a perfectly healthy turn. That is why it is not the rule.
   */
  it('is silent on a turn that touched no connector at all', () => {
    expect(
      classifyTurn({ toolNames: ['Bash', 'Read', 'Skill', 'mcp__workspace__get_scanned_files'], readPaths: [] }),
    ).toBe('no-connector');
  });
});

describe('the review store', () => {
  it('raises one row and persists it in the userData JSON', () => {
    const row = noteTurn({
      sessionId: 'chat-1',
      chatTitle: 'Weekly active users',
      toolNames: ['Bash', 'mcp__hex__create_thread', 'mcp__hex__get_thread'],
      readPaths: ['MyResearch/notes.md'],
      at: 1000,
    });

    expect(row).not.toBeNull();
    expect(row!.kind).toBe('connector-without-ledger');
    expect(row!.connectors).toEqual(['hex']);
    expect(row!.chatTitle).toBe('Weekly active users');

    expect(listKnowledgeReviews()).toHaveLength(1);
    const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].sessionId).toBe('chat-1');
  });

  it('keeps one row per chat rather than one per turn', () => {
    noteTurn({ sessionId: 'chat-1', toolNames: ['mcp__hex__create_thread'], readPaths: [], at: 1000 });
    noteTurn({ sessionId: 'chat-1', toolNames: ['mcp__sentry__x'], readPaths: [], at: 2000 });

    const rows = listKnowledgeReviews();
    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBe(2000);
    expect(rows[0].connectors).toEqual(['hex', 'sentry']);
  });

  it('clears the row when a later turn in the same chat consults the ledger', () => {
    noteTurn({ sessionId: 'chat-1', toolNames: ['mcp__hex__create_thread'], readPaths: [], at: 1000 });
    expect(listKnowledgeReviews()).toHaveLength(1);

    const result = noteTurn({
      sessionId: 'chat-1',
      toolNames: ['mcp__hex__continue_thread'],
      readPaths: [LEDGER_READ],
      at: 2000,
    });

    expect(result).toBeNull();
    expect(listKnowledgeReviews()).toHaveLength(0);
  });

  it('keeps chats apart', () => {
    noteTurn({ sessionId: 'chat-1', toolNames: ['mcp__hex__x'], readPaths: [], at: 1000 });
    noteTurn({ sessionId: 'chat-2', toolNames: ['mcp__hex__x'], readPaths: [], at: 2000 });
    expect(listKnowledgeReviews().map((r) => r.sessionId)).toEqual(['chat-2', 'chat-1']);
  });

  it('returns nothing and writes nothing on a healthy turn', () => {
    expect(noteTurn({ sessionId: 'chat-1', toolNames: ['Bash'], readPaths: [], at: 1 })).toBeNull();
    expect(listKnowledgeReviews()).toHaveLength(0);
    expect(fs.existsSync(storeFile)).toBe(false);
  });

  it('carries the relation-triage row kind too', () => {
    addKnowledgeReview({
      kind: 'possible-supersession',
      skill: 'coscientist-analytics',
      findingIds: ['F-061', 'F-014'],
    });
    const rows = listKnowledgeReviews();
    expect(rows[0].kind).toBe('possible-supersession');
    expect(rows[0].findingIds).toEqual(['F-061', 'F-014']);
  });

  it('removes a dismissed row rather than flagging it', () => {
    const row = noteTurn({ sessionId: 'chat-1', toolNames: ['mcp__hex__x'], readPaths: [], at: 1 })!;
    expect(dismissKnowledgeReview(row.id)).toBe(true);
    expect(listKnowledgeReviews()).toHaveLength(0);
    expect(dismissKnowledgeReview(row.id)).toBe(false);
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf-8'))).toEqual([]);
  });

  it('notifies subscribers', () => {
    const seen: number[] = [];
    const off = subscribeKnowledgeReviews((all) => seen.push(all.length));
    const row = noteTurn({ sessionId: 'chat-1', toolNames: ['mcp__hex__x'], readPaths: [], at: 1 })!;
    dismissKnowledgeReview(row.id);
    off();
    noteTurn({ sessionId: 'chat-2', toolNames: ['mcp__hex__x'], readPaths: [], at: 2 });
    expect(seen).toEqual([1, 0]);
  });

  it('reloads what a previous app run wrote', async () => {
    noteTurn({ sessionId: 'chat-1', chatTitle: 'Weekly active users', toolNames: ['mcp__hex__x'], readPaths: [], at: 1 });

    // A fresh module instance is the only honest stand-in for a restart —
    // `__resetKnowledgeReviews` marks the store loaded, so it would skip the
    // very read this test is about.
    jest.resetModules();
    const fresh = await import('../knowledge/omissionWatch');
    const rows = fresh.listKnowledgeReviews();
    expect(rows).toHaveLength(1);
    expect(rows[0].chatTitle).toBe('Weekly active users');
  });
});
