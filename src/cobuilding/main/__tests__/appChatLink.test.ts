/**
 * @jest-environment node
 *
 * Incident (2026-09-18): a chat scaffolded a tool via
 * `manage_mini_app.mjs --name "Co-Scientist Spend Explorer" ...`. The user
 * opened the tool while the agent was still building it, `sessions:findForApp`
 * found nothing to link, and main created a brand-new empty chat — stranding
 * the user's real conversation under an unrelated auto-title.
 *
 * Two things are covered here, against the real code:
 *  1. `appChatLink.ts`'s pure extraction functions, and their wiring into
 *     `processQueryMessage` (`agentSession.ts`) — the deterministic,
 *     at-the-moment link.
 *  2. `findSessionForApp` / `setSessionAppDirName` (`db/chatRepository.ts`)
 *     against a REAL sqlite database — `better-sqlite3` is built for
 *     Electron's Node ABI, which is exactly what `npm test` runs under (see
 *     `fileMonitorIntegration.test.ts`), so this is not the "jest can't open
 *     the DB" situation `contextOverflow.test.ts` warns about — that warning
 *     predates the `npm test` runner fix.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-appchatlink-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, isPackaged: false },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  isLinkableAppDirName,
  extractScaffoldedDirName,
  extractOpenedDirName,
} from '../appChatLink';
import { processQueryMessage, type MessageProcessingState } from '../agentSession';
import { initDatabase, closeDatabase, getDatabase } from '../db/database';
import { createSession, insertMessage, findSessionForApp, setSessionAppDirName } from '../db/chatRepository';

afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SCAFFOLD_COMMAND =
  'node .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs --name "Co-Scientist Spend Explorer" --description "x" --icon "Coins"';

describe('isLinkableAppDirName', () => {
  it('accepts a plain lowerCamelCase dir name', () => {
    expect(isLinkableAppDirName('coScientistSpendExplorer')).toBe(true);
  });

  it.each([
    ['../x', 'parent traversal'],
    ['a/b', 'a slash'],
    ['.hidden', 'dot-prefixed'],
    ['', 'empty'],
    [42, 'a number'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('rejects %p (%s)', (value: unknown, _description: string) => {
    expect(isLinkableAppDirName(value)).toBe(false);
  });
});

describe('extractScaffoldedDirName', () => {
  it('finds the dir name in the scaffold script\'s JSON result', () => {
    const resultText = JSON.stringify({
      name: 'Co-Scientist Spend Explorer',
      dir_name: 'coScientistSpendExplorer',
      dir: '/Users/x/.applications/coScientistSpendExplorer',
    });
    expect(extractScaffoldedDirName(SCAFFOLD_COMMAND, resultText)).toBe('coScientistSpendExplorer');
  });

  it('finds the JSON line amid npm warnings and trailing ls output', () => {
    const resultText = [
      'npm warn deprecated fooPkg@1.0.0: use bar instead',
      JSON.stringify({
        name: 'Co-Scientist Spend Explorer',
        dir_name: 'coScientistSpendExplorer',
        dir: '/Users/x/.applications/coScientistSpendExplorer',
      }),
      'total 24',
      'drwxr-xr-x  5 user  staff  160 Sep 18 10:00 .',
    ].join('\n');
    expect(extractScaffoldedDirName(SCAFFOLD_COMMAND, resultText)).toBe('coScientistSpendExplorer');
  });

  it('returns null when the command never ran the scaffold script, even if the output looks right', () => {
    const resultText = JSON.stringify({ dir_name: 'coScientistSpendExplorer' });
    expect(extractScaffoldedDirName('cat .applications/coScientistSpendExplorer/manifest.json', resultText)).toBeNull();
  });

  it.each([
    ['../evil'],
    ['a/b'],
    ['.hidden'],
    [''],
    [42],
  ])('rejects an unsafe dir_name %p', (dirName) => {
    const resultText = JSON.stringify({ dir_name: dirName });
    expect(extractScaffoldedDirName(SCAFFOLD_COMMAND, resultText)).toBeNull();
  });

  it('returns null for non-JSON output', () => {
    expect(extractScaffoldedDirName(SCAFFOLD_COMMAND, 'no useful output here\njust text')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(extractScaffoldedDirName(SCAFFOLD_COMMAND, '')).toBeNull();
  });
});

describe('extractOpenedDirName', () => {
  it.each([
    'mcp__mini-apps__build_and_open_mini_application',
    'mcp__mini-apps__open_mini_application',
  ])('extracts dir_name from a %s call', (name) => {
    expect(extractOpenedDirName({ type: 'tool_use', name, input: { dir_name: 'foo' } })).toBe('foo');
  });

  it('returns null for a Bash tool_use block', () => {
    expect(extractOpenedDirName({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } })).toBeNull();
  });

  it('returns null for an unsafe dir_name', () => {
    expect(
      extractOpenedDirName({
        type: 'tool_use',
        name: 'mcp__mini-apps__open_mini_application',
        input: { dir_name: '../evil' },
      }),
    ).toBeNull();
  });

  it('returns null for a non tool_use block', () => {
    expect(
      extractOpenedDirName({
        type: 'text',
        name: 'mcp__mini-apps__open_mini_application',
        input: { dir_name: 'foo' },
      } as any),
    ).toBeNull();
  });
});

describe('processQueryMessage wiring', () => {
  function freshState(onAppLink: jest.Mock): MessageProcessingState {
    return {
      currentToolCallId: null,
      currentBlockIsThinking: false,
      pendingBashCalls: new Map(),
      onAppLink,
    };
  }

  it('links the chat when a Bash tool_result reports the scaffold script\'s JSON', () => {
    const onAppLink = jest.fn();
    const state = freshState(onAppLink);

    const assistantMsg = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: SCAFFOLD_COMMAND } }],
      },
    } as unknown as SDKMessage;
    processQueryMessage(assistantMsg, state, () => {});

    const resultText = JSON.stringify({
      name: 'Co-Scientist Spend Explorer',
      dir_name: 'coScientistSpendExplorer',
      dir: '/Users/x/.applications/coScientistSpendExplorer',
    });
    const userMsg = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: resultText, is_error: false }],
      },
    } as unknown as SDKMessage;
    processQueryMessage(userMsg, state, () => {});

    expect(onAppLink).toHaveBeenCalledTimes(1);
    expect(onAppLink).toHaveBeenCalledWith('coScientistSpendExplorer', 'scaffold');
  });

  it('links the chat when the agent calls build_and_open_mini_application', () => {
    const onAppLink = jest.fn();
    const state = freshState(onAppLink);

    const assistantMsg = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't2',
            name: 'mcp__mini-apps__build_and_open_mini_application',
            input: { dir_name: 'foo' },
          },
        ],
      },
    } as unknown as SDKMessage;
    processQueryMessage(assistantMsg, state, () => {});

    expect(onAppLink).toHaveBeenCalledTimes(1);
    expect(onAppLink).toHaveBeenCalledWith('foo', 'open');
  });

  it('does not call onAppLink for an unrelated Bash command', () => {
    const onAppLink = jest.fn();
    const state = freshState(onAppLink);

    const assistantMsg = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls -la' } }],
      },
    } as unknown as SDKMessage;
    processQueryMessage(assistantMsg, state, () => {});

    const userMsg = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't3', content: 'total 0', is_error: false }],
      },
    } as unknown as SDKMessage;
    processQueryMessage(userMsg, state, () => {});

    expect(onAppLink).not.toHaveBeenCalled();
  });
});

describe('findSessionForApp / setSessionAppDirName against a real database', () => {
  let workspaceId: string;
  let sessionId: string;

  beforeAll(() => {
    initDatabase(tmpDir);
    workspaceId = randomUUID();
    getDatabase()
      .prepare('INSERT INTO workspaces (id, name, directory_path, api_key) VALUES (?, ?, ?, ?)')
      .run(workspaceId, 'Test Workspace', tmpDir, 'test-key');

    sessionId = randomUUID();
    createSession(sessionId, workspaceId, null, null, null);

    // Shaped exactly like the incident: the assistant row carries the
    // scaffold command with only the DISPLAY name, and the dir name appears
    // solely inside the tool_result row's JSON payload.
    insertMessage(
      sessionId,
      'assistant',
      JSON.stringify([
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: SCAFFOLD_COMMAND },
        },
      ]),
    );
    insertMessage(
      sessionId,
      'tool_result',
      JSON.stringify([
        {
          tool_use_id: 't1',
          type: 'tool_result',
          content: '{"name":"Co-Scientist Spend Explorer","dir_name":"coScientistSpendExplorer","dir":"/x"}',
        },
      ]),
    );
  });

  it('finds the session via the tool_result JSON, which the old query missed entirely', () => {
    expect(findSessionForApp(workspaceId, 'coScientistSpendExplorer')).toBe(sessionId);
  });

  it('setSessionAppDirName writes once, reports whether it wrote, and never re-homes a chat', () => {
    expect(setSessionAppDirName(sessionId, 'coScientistSpendExplorer')).toBe(true);
    expect(setSessionAppDirName(sessionId, 'someOtherDir')).toBe(false);

    const row = getDatabase()
      .prepare('SELECT app_dir_name FROM sessions WHERE id = ?')
      .get(sessionId) as { app_dir_name: string };
    expect(row.app_dir_name).toBe('coScientistSpendExplorer');
  });
});
