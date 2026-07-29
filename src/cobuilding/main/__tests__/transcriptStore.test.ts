/**
 * Reclaiming SDK transcripts. Exercised against REAL files in a temp config
 * dir — the module's whole job is deciding what to unlink, and a mocked `fs`
 * would only prove the mock agrees with itself.
 *
 * The invariant being protected: a transcript is reachable if and only if some
 * chat's `sdk_session_id` names it, because that column is the only thing
 * `resumeSessionId` is ever set from. Everything else on disk is dead weight.
 * The danger is the other direction — sweeping a file a live chat still needs
 * would silently amputate that conversation's memory — so most of these cases
 * are about what must SURVIVE.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-transcripts-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { deleteTranscript, sweepOrphanTranscripts } from '../transcriptStore';

const PROJECTS = path.join(tmpDir, 'claude-config', 'projects');
/** Matches the real key shape: the workspace cwd with separators flattened. */
const KEY = '-Users-someone-Library-Application-Support-acabox-production-workspace-data';

function write(id: string, bytes = 64, key = KEY): string {
  const dir = path.join(PROJECTS, key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, 'x'.repeat(bytes));
  return file;
}

const exists = (id: string, key = KEY) =>
  fs.existsSync(path.join(PROJECTS, key, `${id}.jsonl`));

beforeEach(() => {
  fs.rmSync(PROJECTS, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('deleteTranscript', () => {
  it('removes the named transcript and leaves every other one alone', () => {
    write('keep-me');
    write('delete-me');

    expect(deleteTranscript('delete-me')).toBe(true);
    expect(exists('delete-me')).toBe(false);
    expect(exists('keep-me')).toBe(true);
  });

  /** A chat that never completed a turn has no sdk_session_id. Deleting it must
   *  not throw — and must not be mistaken for "delete everything". */
  it('is a no-op for a chat that never got a transcript', () => {
    write('untouched');
    expect(deleteTranscript(null)).toBe(false);
    expect(deleteTranscript(undefined)).toBe(false);
    expect(deleteTranscript('')).toBe(false);
    expect(exists('untouched')).toBe(true);
  });

  it('reports false rather than throwing when the file is already gone', () => {
    fs.mkdirSync(path.join(PROJECTS, KEY), { recursive: true });
    expect(deleteTranscript('never-existed')).toBe(false);
  });

  it('does not throw when no config dir exists yet', () => {
    expect(deleteTranscript('anything')).toBe(false);
  });

  /** The SDK keys projects off the query cwd, so a workspace that has moved
   *  leaves a second project dir behind with live transcripts in it. */
  it('finds a transcript under a non-default project key', () => {
    write('moved-workspace', 64, '-Users-someone-OldPath-workspace-data');
    expect(deleteTranscript('moved-workspace')).toBe(true);
    expect(exists('moved-workspace', '-Users-someone-OldPath-workspace-data')).toBe(false);
  });
});

describe('sweepOrphanTranscripts', () => {
  it('removes only what no chat points at', () => {
    write('live-a', 100);
    write('live-b', 200);
    write('orphan-a', 300);
    write('orphan-b', 400);

    const { removed, bytes } = sweepOrphanTranscripts(['live-a', 'live-b']);

    expect(removed).toBe(2);
    expect(bytes).toBe(700);
    expect(exists('live-a')).toBe(true);
    expect(exists('live-b')).toBe(true);
    expect(exists('orphan-a')).toBe(false);
    expect(exists('orphan-b')).toBe(false);
  });

  it('sweeps across every project key, not just the current one', () => {
    write('live', 64, '-current');
    write('stale', 64, '-old');
    sweepOrphanTranscripts(['live']);
    expect(exists('live', '-current')).toBe(true);
    expect(exists('stale', '-old')).toBe(false);
  });

  /** How the Debug hard reset uses it: every chat is gone, so nothing is live. */
  it('clears everything when the live set is empty', () => {
    write('a'); write('b'); write('c');
    expect(sweepOrphanTranscripts([]).removed).toBe(3);
    expect(fs.readdirSync(path.join(PROJECTS, KEY))).toEqual([]);
  });

  /** A dangling pointer is normal — the poisoned transcript that started all
   *  this was deleted while its chat row still referenced it. Naming a file
   *  that isn't there must not disturb the ones that are. */
  it('tolerates live ids with no file on disk', () => {
    write('real');
    const { removed } = sweepOrphanTranscripts(['real', 'pointer-to-nothing']);
    expect(removed).toBe(0);
    expect(exists('real')).toBe(true);
  });

  it('touches only .jsonl files at the top of a project dir', () => {
    const dir = path.join(PROJECTS, KEY);
    fs.mkdirSync(path.join(dir, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
    fs.writeFileSync(path.join(dir, 'subdir', 'nested.jsonl'), 'keep');
    write('orphan');

    expect(sweepOrphanTranscripts([]).removed).toBe(1);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'subdir', 'nested.jsonl'))).toBe(true);
  });

  it('does not throw when no config dir exists yet', () => {
    expect(sweepOrphanTranscripts([])).toEqual({ removed: 0, bytes: 0 });
  });
});
