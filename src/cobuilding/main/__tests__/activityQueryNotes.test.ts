/**
 * @jest-environment node
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Mocks (hoisted by Jest before imports) ---

jest.mock('electron', () => ({
  app: {
    getVersion: jest.fn(() => '1.0.0-test'),
  },
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock browser and file repositories so we don't need the database
jest.mock('../browserMonitor/repository', () => ({
  getBrowserSessionsByTimeRange: jest.fn(() => []),
}));

jest.mock('../fileMonitor/repository', () => ({
  getFileSessionsByTimeRange: jest.fn(() => []),
}));

jest.mock('../db/sessionFilesRepository', () => ({
  getSessionFilesBySessionIds: jest.fn(() => new Map()),
}));

// --- Imports (resolved AFTER mocks) ---

import { DateTime } from 'luxon';
import { initActivityQuery, queryActivity } from '../activityQuery';
import type { ActivityQueryResult } from '../activityQuery';

// --- Helpers ---

let tmpDir: string;
let workspaceDir: string;
let notesDir: string;

function writeNotesFile(date: string, content: string): void {
  fs.writeFileSync(path.join(notesDir, `${date}.md`), content, 'utf-8');
}

// Convert a local date+time to a UTC ISO string, so that queryActivity's
// internal UTC→local conversion recovers the original local time.
function localToUtc(dateStr: string, time: string): string {
  return DateTime.fromISO(`${dateStr}T${time}`, { zone: 'local' }).toUTC().toISO()!;
}

// --- Tests ---

describe('Activity query — notes source', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobuilding-notes-query-test-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    notesDir = path.join(workspaceDir, '.notes');
    fs.mkdirSync(notesDir, { recursive: true });

    initActivityQuery(() => workspaceDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean notes directory between tests
    for (const file of fs.readdirSync(notesDir)) {
      fs.unlinkSync(path.join(notesDir, file));
    }
  });

  it('returns notes_sessions when source is "notes"', () => {
    writeNotesFile('2026-04-16', [
      '# Notes - April 16, 2026',
      '',
      '## 09:00',
      'Observed cell growth in sample A.',
      '',
      '## 09:10',
      'Temperature reading is stable at 37 degrees.',
    ].join('\n'));

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
      source: 'notes',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toBeDefined();
    expect(r.notes_sessions).toHaveLength(1);
    expect(r.notes_sessions![0].file_path).toBe('.notes/2026-04-16.md');
    expect(r.notes_sessions![0].date).toBe('2026-04-16');
    expect(r.notes_sessions![0].time_blocks).toEqual(['09:00', '09:10']);

    // Browser and file sessions should NOT be present
    expect(r.browser_sessions).toBeUndefined();
    expect(r.file_sessions).toBeUndefined();
  });

  it('includes notes_sessions when source is "all"', () => {
    writeNotesFile('2026-04-16', [
      '# Notes',
      '',
      '## 10:00',
      'Running PCR analysis.',
    ].join('\n'));

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
      source: 'all',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toBeDefined();
    expect(r.notes_sessions).toHaveLength(1);
    // Browser and file sessions should also be present (from mocks, empty)
    expect(r.browser_sessions).toBeDefined();
    expect(r.file_sessions).toBeDefined();
  });

  it('includes notes_sessions when source is omitted (defaults to all)', () => {
    writeNotesFile('2026-04-16', [
      '# Notes',
      '',
      '## 14:00',
      'Reviewing lab results.',
    ].join('\n'));

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toBeDefined();
    expect(r.notes_sessions).toHaveLength(1);
  });

  it('handles comma-separated sources correctly', () => {
    writeNotesFile('2026-04-16', [
      '# Notes',
      '',
      '## 09:00',
      'Lab work.',
    ].join('\n'));

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
      source: 'browser,notes',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toBeDefined();
    expect(r.notes_sessions).toHaveLength(1);
    expect(r.browser_sessions).toBeDefined();
    // File sessions should NOT be included
    expect(r.file_sessions).toBeUndefined();
  });

  it('filters time blocks by since/until range', () => {
    writeNotesFile('2026-04-16', [
      '# Notes',
      '',
      '## 09:00',
      'Morning notes.',
      '',
      '## 10:00',
      'Mid-morning notes.',
      '',
      '## 14:00',
      'Afternoon notes.',
    ].join('\n'));

    const result = queryActivity({
      since: localToUtc('2026-04-16', '10:00'),
      until: localToUtc('2026-04-16', '12:00'),
      source: 'notes',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toBeDefined();
    expect(r.notes_sessions).toHaveLength(1);
    // Only the 10:00 block should be in range
    expect(r.notes_sessions![0].time_blocks).toEqual(['10:00']);
  });

  it('returns empty notes_sessions when .notes directory does not exist', () => {
    // Point to a workspace without a .notes dir
    const emptyWorkspace = path.join(tmpDir, 'empty-workspace');
    fs.mkdirSync(emptyWorkspace, { recursive: true });
    initActivityQuery(() => emptyWorkspace);

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
      source: 'notes',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toBeDefined();
    expect(r.notes_sessions).toEqual([]);

    // Restore original workspace path
    initActivityQuery(() => workspaceDir);
  });

  it('returns empty when notes file has no time block headings', () => {
    writeNotesFile('2026-04-16', [
      '# Notes - April 16, 2026',
      '',
      'Some content without time headings.',
    ].join('\n'));

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
      source: 'notes',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toBeDefined();
    expect(r.notes_sessions).toEqual([]);
  });

  it('backward compatibility: source="browser" excludes notes', () => {
    writeNotesFile('2026-04-16', [
      '# Notes',
      '',
      '## 09:00',
      'Notes content.',
    ].join('\n'));

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
      source: 'browser',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toBeUndefined();
    expect(r.browser_sessions).toBeDefined();
    expect(r.file_sessions).toBeUndefined();
  });

  it('backward compatibility: source="file" excludes notes', () => {
    writeNotesFile('2026-04-16', [
      '# Notes',
      '',
      '## 09:00',
      'Notes content.',
    ].join('\n'));

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
      source: 'file',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toBeUndefined();
    expect(r.file_sessions).toBeDefined();
    expect(r.browser_sessions).toBeUndefined();
  });

  it('skips non-date markdown files in .notes', () => {
    writeNotesFile('2026-04-16', [
      '# Notes',
      '',
      '## 09:00',
      'Valid notes.',
    ].join('\n'));
    // Write a non-date file
    fs.writeFileSync(path.join(notesDir, 'README.md'), '# Readme', 'utf-8');

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
      source: 'notes',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toHaveLength(1);
    expect(r.notes_sessions![0].date).toBe('2026-04-16');
  });

  it('filters notes files by date range', () => {
    writeNotesFile('2026-04-15', [
      '# Notes',
      '',
      '## 09:00',
      'Yesterday notes.',
    ].join('\n'));
    writeNotesFile('2026-04-16', [
      '# Notes',
      '',
      '## 09:00',
      'Today notes.',
    ].join('\n'));
    writeNotesFile('2026-04-17', [
      '# Notes',
      '',
      '## 09:00',
      'Tomorrow notes.',
    ].join('\n'));

    const result = queryActivity({
      since: localToUtc('2026-04-16', '00:00'),
      until: localToUtc('2026-04-16', '23:59'),
      source: 'notes',
    });

    expect('error' in result).toBe(false);
    const r = result as ActivityQueryResult;
    expect(r.notes_sessions).toHaveLength(1);
    expect(r.notes_sessions![0].date).toBe('2026-04-16');
  });
});
