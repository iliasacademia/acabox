/**
 * Recovery from a thread whose SDK transcript no longer fits the context
 * window. The failure this covers was observed in the wild: a 5.5 MB CSV was
 * inlined into turn 1, and from then on EVERY turn in that chat came back
 * "Prompt is too long" — including a bare "Hi" — because each one resumed the
 * same oversized transcript. The thread could not heal itself.
 *
 * Two things have to hold for the recovery to work, and both are tested here
 * against the real code rather than a mock:
 *
 *  1. The predicate must fire on a genuine overflow and NOT on an ordinary
 *     failed turn. Dropping the agent's memory of a conversation is far too
 *     destructive to trigger on a tool that happened to throw, and `is_error`
 *     alone does not distinguish the two.
 *  2. Clearing the resume pointer must actually leave `getSession` reporting
 *     null — that column is what `startLoop` reads to decide whether to resume.
 *
 * Only (1) is covered here. `better-sqlite3` is built against Electron's Node
 * ABI, so jest cannot open the database at all ("compiled against a different
 * Node.js version") — do not re-add a DB case to this file expecting it to run.
 * (2) is verified against a copy of a real cobuilding.db by
 * `scripts/verify-clear-resume-pointer.sh`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-overflow-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, isPackaged: false },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { isContextOverflowResult } from '../agentSession';

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('isContextOverflowResult', () => {
  /** The exact shape observed on the wire. Note `subtype` is "success" even
   *  though `is_error` is true — reading subtype instead of the flag would
   *  miss it entirely. */
  it('fires on the real overflow result', () => {
    expect(isContextOverflowResult({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Prompt is too long',
    } as any)).toBe(true);
  });

  it('fires on the other wordings the API uses for the same condition', () => {
    for (const text of [
      'prompt is too long: 1543210 tokens > 1000000 maximum',
      'Context window exceeded',
      'context length exceeded for this model',
      'too many input tokens',
    ]) {
      expect(isContextOverflowResult({
        type: 'result', subtype: 'success', is_error: true, result: text,
      } as any)).toBe(true);
    }
  });

  /** The one that matters most: an ordinary failed turn must not cost the user
   *  the agent's memory of the conversation. */
  it('does NOT fire on an ordinary failed turn', () => {
    for (const text of [
      'Command failed with exit code 1',
      'Error: ENOENT: no such file or directory',
      'Failed to authenticate. API Error: 401',
      'The tool returned an error',
      '',
    ]) {
      expect(isContextOverflowResult({
        type: 'result', subtype: 'error_during_execution', is_error: true, result: text,
      } as any)).toBe(false);
    }
  });

  it('does not fire on a successful turn, even one discussing long prompts', () => {
    expect(isContextOverflowResult({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Your prompt is too long, so I split it into three files.',
    } as any)).toBe(false);
  });

  it('ignores non-result messages and malformed payloads', () => {
    expect(isContextOverflowResult({
      type: 'assistant',
      is_error: true,
      message: { content: [{ type: 'text', text: 'Prompt is too long' }] },
    } as any)).toBe(false);
    expect(isContextOverflowResult({ type: 'result', is_error: true } as any)).toBe(false);
    expect(isContextOverflowResult({ type: 'result', is_error: true, result: { a: 1 } } as any)).toBe(false);
    expect(isContextOverflowResult(undefined as any)).toBe(false);
  });
});

