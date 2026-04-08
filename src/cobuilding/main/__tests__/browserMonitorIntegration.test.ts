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

// --- Imports (resolved AFTER mocks) ---

import {
  initObservationsDatabase,
  closeObservationsDatabase,
  getObservationsDatabase,
} from '../db/observationsDatabase';
import { initSessionFiles, getSessionFiles } from '../db/sessionFilesRepository';
import { SessionAccumulator } from '../browserMonitor/sessionAccumulator';
import type { SnapshotPayload } from '../browserMonitor/types';

// --- Helpers ---

let tmpDir: string;
let workspaceDir: string;

function makeSnapshot(overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    url: 'https://example.com/article',
    title: 'Test Article',
    referrer: 'https://google.com',
    meta_tags: { 'og:title': 'Test Article' },
    full_text: 'This is the full text content of the article.',
    text_hash: 'abc123',
    dwell_seconds: 45,
    scroll: { depth: 0.6 },
    timestamp: '2026-04-07T10:00:00.000Z',
    ...overrides,
  };
}

// --- Tests ---

describe('Browser monitor integration', () => {
  let accumulator: SessionAccumulator;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobuilding-browser-test-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });

    initObservationsDatabase(tmpDir);
    initSessionFiles(() => workspaceDir);
    accumulator = new SessionAccumulator();
  });

  afterAll(() => {
    closeObservationsDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates browser session and session file for a new snapshot', () => {
    const fullText = 'This is the full text content of the article.';
    accumulator.ingestSnapshot(makeSnapshot({ full_text: fullText }));

    // --- Verify browser_sessions table ---
    const db = getObservationsDatabase();
    const rows = db.prepare('SELECT * FROM browser_sessions').all() as any[];
    expect(rows).toHaveLength(1);

    const session = rows[0];
    expect(session.url).toBe('https://example.com/article');
    expect(session.title).toBe('Test Article');
    expect(session.referrer).toBe('https://google.com');
    expect(JSON.parse(session.meta_tags)).toEqual({ 'og:title': 'Test Article' });
    expect(session.full_text).toBeNull(); // full_text not stored in DB
    expect(session.text_hash).toBe('abc123');
    expect(session.total_dwell).toBe(45);
    expect(session.max_scroll_depth).toBe(0.6);
    expect(session.snapshot_count).toBe(1);
    expect(session.session_date).toBe('2026-04-07');
    expect(session.app_version).toBe('1.0.0-test');

    // --- Verify session_files table ---
    const sessionFiles = db.prepare(
      'SELECT * FROM session_files WHERE session_type = ? AND session_id = ?',
    ).all('browser', session.id) as any[];
    expect(sessionFiles).toHaveLength(1);

    const sessionFile = sessionFiles[0];
    expect(sessionFile.file_type).toBe('full_text');
    expect(sessionFile.file_ext).toBe('.txt');

    // --- Verify text file on disk ---
    const textFilePath = path.join(workspaceDir, 'session-files', `${sessionFile.ulid}.txt`);
    expect(fs.existsSync(textFilePath)).toBe(true);

    const storedText = fs.readFileSync(textFilePath, 'utf-8');
    expect(storedText).toBe(fullText);

    // --- Verify via repository helper ---
    const files = getSessionFiles('browser', session.id);
    expect(files).toHaveLength(1);
    expect(files[0].file_path).toBe(textFilePath);
  });

  it('updates session and creates new session file on subsequent snapshots', () => {
    const updatedText = 'Updated article content with more details.';
    accumulator.ingestSnapshot(makeSnapshot({
      full_text: updatedText,
      text_hash: 'def456',
      dwell_seconds: 120,
      scroll: { depth: 0.9 },
      timestamp: '2026-04-07T10:05:00.000Z',
    }));

    const db = getObservationsDatabase();
    const rows = db.prepare('SELECT * FROM browser_sessions').all() as any[];
    expect(rows).toHaveLength(1); // same session, not a new one

    const session = rows[0];
    expect(session.total_dwell).toBe(120);
    expect(session.max_scroll_depth).toBe(0.9);
    expect(session.snapshot_count).toBe(2);
    expect(session.full_text).toBeNull(); // still not in DB

    // --- Should now have 2 session files (one per snapshot with full_text) ---
    const sessionFiles = db.prepare(
      'SELECT * FROM session_files WHERE session_type = ? AND session_id = ?',
    ).all('browser', session.id) as any[];
    expect(sessionFiles).toHaveLength(2);

    // Latest file should contain the updated text
    const latestFile = sessionFiles[1];
    const textFilePath = path.join(workspaceDir, 'session-files', `${latestFile.ulid}.txt`);
    const storedText = fs.readFileSync(textFilePath, 'utf-8');
    expect(storedText).toBe(updatedText);
  });

  it('does not create session file when full_text is null', () => {
    accumulator.ingestSnapshot(makeSnapshot({
      url: 'https://example.com/no-text',
      title: 'Page Without Text',
      full_text: null,
      text_hash: '',
      timestamp: '2026-04-07T11:00:00.000Z',
    }));

    const db = getObservationsDatabase();

    // Should have 2 browser sessions now
    const sessions = db.prepare('SELECT * FROM browser_sessions ORDER BY id').all() as any[];
    expect(sessions).toHaveLength(2);

    const noTextSession = sessions[1];
    expect(noTextSession.url).toBe('https://example.com/no-text');

    // No session file for this session
    const sessionFiles = db.prepare(
      'SELECT * FROM session_files WHERE session_type = ? AND session_id = ?',
    ).all('browser', noTextSession.id) as any[];
    expect(sessionFiles).toHaveLength(0);
  });

  it('creates separate sessions for different dates', () => {
    accumulator.ingestSnapshot(makeSnapshot({
      url: 'https://example.com/article', // same URL as first test
      full_text: 'Next day content',
      text_hash: 'ghi789',
      timestamp: '2026-04-08T09:00:00.000Z', // different date
    }));

    const db = getObservationsDatabase();

    // Should have 3 browser sessions (original article, no-text page, next-day article)
    const sessions = db.prepare('SELECT * FROM browser_sessions ORDER BY id').all() as any[];
    expect(sessions).toHaveLength(3);

    const nextDaySession = sessions[2];
    expect(nextDaySession.url).toBe('https://example.com/article');
    expect(nextDaySession.session_date).toBe('2026-04-08');
    expect(nextDaySession.snapshot_count).toBe(1);

    // Should have its own session file
    const sessionFiles = db.prepare(
      'SELECT * FROM session_files WHERE session_type = ? AND session_id = ?',
    ).all('browser', nextDaySession.id) as any[];
    expect(sessionFiles).toHaveLength(1);

    const textFilePath = path.join(workspaceDir, 'session-files', `${sessionFiles[0].ulid}.txt`);
    expect(fs.readFileSync(textFilePath, 'utf-8')).toBe('Next day content');
  });
});
