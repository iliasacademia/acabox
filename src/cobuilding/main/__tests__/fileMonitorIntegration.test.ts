/**
 * @jest-environment node
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import JSZip from 'jszip';

// --- Mocks (hoisted by Jest before imports) ---

jest.mock('electron', () => ({
  app: {
    getVersion: jest.fn(() => '1.0.0-test'),
    isPackaged: false,
    getAppPath: jest.fn(() => '/tmp'),
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
import { initFileMonitor, handleEvent, type FileMonitorEvent } from '../fileMonitor/fileMonitorService';
import { initSessionFiles, getSessionFiles } from '../db/sessionFilesRepository';
import { findFileSession } from '../fileMonitor/repository';

// --- Helpers ---

let tmpDir: string;
let workspaceDir: string;
let sourceDir: string;

async function createMockDocx(filePath: string, text: string): Promise<void> {
  const zip = new JSZip();

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`);

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(filePath, buffer);
}

function makeEvent(
  eventType: FileMonitorEvent['event'],
  documentUrl: string | null,
  timestamp: string,
): FileMonitorEvent {
  return {
    event: eventType,
    timestamp,
    platform: 'macos',
    app: {
      name: 'Microsoft Word',
      bundleId: 'com.microsoft.Word',
      pid: 12345,
    },
    window: {
      id: 1,
      title: 'Test Document.docx',
      documentUrl,
    },
  };
}

// --- Tests ---

describe('File monitor integration', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobuilding-test-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    sourceDir = path.join(tmpDir, 'source');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });

    initObservationsDatabase(tmpDir);
    initFileMonitor(() => workspaceDir);
    initSessionFiles(() => workspaceDir);
  });

  afterAll(() => {
    closeObservationsDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates file session, snapshot, and extracted text for a docx file', async () => {
    const docxPath = path.join(sourceDir, 'TestDocument.docx');
    const docxUrl = `file://${docxPath}`;
    const docText = 'Hello from the test document';
    await createMockDocx(docxPath, docText);

    const t0 = '2026-04-07T10:00:00.000Z';
    const t1 = '2026-04-07T10:00:10.000Z';
    const t2 = '2026-04-07T10:00:20.000Z';
    const t3 = '2026-04-07T10:00:30.000Z';

    // Simulate: APP_FOCUSED → two FILE_MONITOR_POLL → APP_UNFOCUSED
    await handleEvent(makeEvent('APP_FOCUSED', docxUrl, t0));
    await handleEvent(makeEvent('FILE_MONITOR_POLL', docxUrl, t1));
    await handleEvent(makeEvent('FILE_MONITOR_POLL', docxUrl, t2));
    await handleEvent(makeEvent('APP_UNFOCUSED', docxUrl, t3));

    // --- Verify file_sessions table ---
    const db = getObservationsDatabase();
    const rows = db.prepare('SELECT * FROM file_sessions').all() as any[];
    expect(rows).toHaveLength(1);

    const session = rows[0];
    expect(session.document_url).toBe(docxUrl);
    expect(session.app_name).toBe('Microsoft Word');
    expect(session.app_bundle_id).toBe('com.microsoft.Word');
    expect(session.window_title).toBe('Test Document.docx');
    expect(session.poll_count).toBe(4); // initial + 2 polls + unfocus
    expect(session.total_dwell).toBe(30); // 10s + 10s + 10s (capped at 30s each)
    expect(session.snapshot_ulid).toBeTruthy();
    expect(session.app_version).toBe('1.0.0-test');

    // --- Verify snapshot file exists on disk ---
    const snapshotDir = path.join(workspaceDir, '.academia', 'temp_files');
    const snapshotPath = path.join(snapshotDir, `${session.snapshot_ulid}.docx`);
    expect(fs.existsSync(snapshotPath)).toBe(true);

    // Verify snapshot is a valid copy of the original
    const originalSize = fs.statSync(docxPath).size;
    const snapshotSize = fs.statSync(snapshotPath).size;
    expect(snapshotSize).toBe(originalSize);

    // --- Verify session_files table and text file on disk ---
    const sessionFiles = db.prepare(
      'SELECT * FROM session_files WHERE session_type = ? AND session_id = ?',
    ).all('file', session.id) as any[];
    expect(sessionFiles).toHaveLength(1);

    const sessionFile = sessionFiles[0];
    expect(sessionFile.file_type).toBe('full_text');
    expect(sessionFile.file_ext).toBe('.txt');
    expect(sessionFile.ulid).toBeTruthy();

    const textFilePath = path.join(workspaceDir, '.academia', 'temp_files', `${sessionFile.ulid}.txt`);
    expect(fs.existsSync(textFilePath)).toBe(true);

    const extractedText = fs.readFileSync(textFilePath, 'utf-8');
    expect(extractedText).toContain(docText);

    // --- Verify via repository helpers ---
    const files = getSessionFiles('file', session.id);
    expect(files).toHaveLength(1);
    expect(files[0].file_path).toBe(textFilePath);
    expect(files[0].file_type).toBe('full_text');
  });
});
