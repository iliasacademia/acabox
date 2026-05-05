/**
 * @jest-environment node
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mocks must be declared before importing the modules under test.
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => os.tmpdir()), isPackaged: false, getAppPath: () => '/tmp' },
  shell: { openExternal: jest.fn(async () => true) },
}));

// The Anthropic SDK ships as ESM-only; Jest can't transform it. Stub it.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: jest.fn(() => ({})),
  tool: jest.fn((..._args: unknown[]) => ({})),
}));

// Avoid loading the native word_accessibility binary in tests.
jest.mock('../../../native/wordAccessibility', () => ({
  wordAccessibility: {
    checkPermission: () => false,
    requestPermission: () => false,
    openAccessibilitySettings: () => undefined,
    getAppInfo: () => ({ bundleId: 'test', executablePath: '', teamId: '' }),
  },
}));
jest.mock('../../../windowMonitorService', () => ({
  windowMonitorService: {
    getFocusedWindowId: () => null,
    getDocumentPathForWindow: () => null,
    getActiveWorkspaceDirectory: () => null,
    suppressSelectionEvents: () => undefined,
  },
}));
jest.mock('../../../utils/logger', () => ({
  defaultLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
jest.mock('../../../windowMonitorDb', () => ({
  logToWindowMonitorDb: () => {},
}));

import {
  resolveObsidianDocumentPath,
  isObsidianVault,
  readActiveNoteFromWorkspaceJson,
} from '../hostApps/obsidianHostApp';

/**
 * Build a minimal Obsidian workspace.json under <vault>/.obsidian/ that has a
 * single active markdown leaf pointing at `relFile`.
 */
function writeWorkspaceJson(vaultDir: string, relFile: string | null, leafType: string = 'markdown') {
  fs.mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });
  const activeId = 'leaf-1';
  const leaf: any = {
    id: activeId,
    type: 'leaf',
    state: {
      type: leafType,
      state: relFile ? { file: relFile, mode: 'source', source: false } : {},
      icon: 'lucide-file',
      title: 'X',
    },
  };
  const workspace = {
    main: {
      id: 'root',
      type: 'split',
      children: [{ id: 'tabs-1', type: 'tabs', children: [leaf] }],
      direction: 'vertical',
    },
    active: activeId,
  };
  fs.writeFileSync(path.join(vaultDir, '.obsidian', 'workspace.json'), JSON.stringify(workspace, null, 2));
}

describe('readActiveNoteFromWorkspaceJson', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-ws-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  it('returns the relative path of the active markdown leaf', () => {
    writeWorkspaceJson(tmpVault, 'Sample.md');
    expect(readActiveNoteFromWorkspaceJson(tmpVault)).toBe('Sample.md');
  });

  it('returns the relative path for a nested note', () => {
    writeWorkspaceJson(tmpVault, 'subdir/Note.md');
    expect(readActiveNoteFromWorkspaceJson(tmpVault)).toBe('subdir/Note.md');
  });

  it('returns null when the active leaf is not markdown (e.g. canvas)', () => {
    writeWorkspaceJson(tmpVault, 'Board.canvas', 'canvas');
    expect(readActiveNoteFromWorkspaceJson(tmpVault)).toBeNull();
  });

  it('returns null when the active leaf is a non-file pane (file-explorer/search)', () => {
    writeWorkspaceJson(tmpVault, null, 'file-explorer');
    expect(readActiveNoteFromWorkspaceJson(tmpVault)).toBeNull();
  });

  it('returns null when workspace.json is missing', () => {
    expect(readActiveNoteFromWorkspaceJson(tmpVault)).toBeNull();
  });

  it('returns null when workspace.json is malformed', () => {
    fs.mkdirSync(path.join(tmpVault, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, '.obsidian', 'workspace.json'), 'not json');
    expect(readActiveNoteFromWorkspaceJson(tmpVault)).toBeNull();
  });

  it('returns null when vaultDir is null', () => {
    expect(readActiveNoteFromWorkspaceJson(null)).toBeNull();
  });
});

describe('resolveObsidianDocumentPath', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  it('returns the absolute path when active .md exists on disk', () => {
    fs.writeFileSync(path.join(tmpVault, 'Sample.md'), '# hi\n');
    writeWorkspaceJson(tmpVault, 'Sample.md');
    expect(resolveObsidianDocumentPath(tmpVault)).toBe(path.join(tmpVault, 'Sample.md'));
  });

  it('returns null when the active .md does not exist on disk (vault mismatch)', () => {
    writeWorkspaceJson(tmpVault, 'Phantom.md');
    expect(resolveObsidianDocumentPath(tmpVault)).toBeNull();
  });

  it('returns null when active leaf is not markdown', () => {
    fs.writeFileSync(path.join(tmpVault, 'Board.canvas'), '{}');
    writeWorkspaceJson(tmpVault, 'Board.canvas', 'canvas');
    expect(resolveObsidianDocumentPath(tmpVault)).toBeNull();
  });

  it('returns null when workspaceDir is null', () => {
    expect(resolveObsidianDocumentPath(null)).toBeNull();
  });

  it('returns null when there is no active leaf at all', () => {
    fs.mkdirSync(path.join(tmpVault, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, '.obsidian', 'workspace.json'), JSON.stringify({ main: { type: 'split', children: [] } }));
    expect(resolveObsidianDocumentPath(tmpVault)).toBeNull();
  });
});

describe('obsidianHostApp.applyEdit workspace boundary', () => {
  let tmpVault: string;
  let outside: string;
  let outsideFile: string;
  let insideFile: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-bound-vault-'));
    fs.mkdirSync(path.join(tmpVault, '.obsidian'), { recursive: true });
    insideFile = path.join(tmpVault, 'Inside.md');
    fs.writeFileSync(insideFile, 'foo bar baz\n');

    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-bound-outside-'));
    outsideFile = path.join(outside, 'Secret.md');
    fs.writeFileSync(outsideFile, 'secret content\n');
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  /**
   * Set up a fresh module cache with the mocked workspace directory and return
   * the obsidianHostApp instance loaded against that mock. We must call applyEdit
   * before the next test resets modules — otherwise the lazy `require` inside
   * `getActiveWorkspaceDir` will pick up the wrong mock.
   */
  function loadHostAppWithWorkspace(workspaceDir: string | null) {
    jest.resetModules();
    jest.doMock('../../../windowMonitorService', () => ({
      windowMonitorService: {
        getFocusedWindowId: () => null,
        getDocumentPathForWindow: () => null,
        getActiveWorkspaceDirectory: () => workspaceDir,
        suppressSelectionEvents: () => undefined,
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../hostApps/obsidianHostApp').obsidianHostApp;
  }

  it('rejects writes to a path outside the active workspace', async () => {
    const app = loadHostAppWithWorkspace(tmpVault);
    const result = await app.applyEdit({
      document_path: outsideFile,
      search_text: 'secret',
      replacement_text: 'sanitized',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the active workspace/);
    // File on disk should be unchanged.
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('secret content\n');
  });

  it('rejects when there is no active workspace', async () => {
    const app = loadHostAppWithWorkspace(null);
    const result = await app.applyEdit({
      document_path: insideFile,
      search_text: 'foo',
      replacement_text: 'qux',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No active workspace/);
  });

  it('allows writes within the active workspace', async () => {
    const app = loadHostAppWithWorkspace(tmpVault);
    const result = await app.applyEdit({
      document_path: insideFile,
      search_text: 'foo',
      replacement_text: 'qux',
    });
    expect(result.success).toBe(true);
    expect(result.replacementsCount).toBe(1);
    expect(fs.readFileSync(insideFile, 'utf-8')).toBe('qux bar baz\n');
  });
});

describe('isObsidianVault', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-vault-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true when .obsidian directory exists', () => {
    fs.mkdirSync(path.join(tmp, '.obsidian'));
    expect(isObsidianVault(tmp)).toBe(true);
  });

  it('returns false when .obsidian directory is missing', () => {
    expect(isObsidianVault(tmp)).toBe(false);
  });

  it('returns false for null input', () => {
    expect(isObsidianVault(null)).toBe(false);
  });
});

describe('findHostAppForDocument', () => {
  it('routes .md to obsidian when registered', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../shared/types', () => ({
        FEATURES: {
          MS_WORD_INTEGRATION_ENABLED: true,
          OBSIDIAN_INTEGRATION_ENABLED: true,
          APPLE_NOTES_INTEGRATION_ENABLED: false,
          MS_WORD_V2_ENABLED: true,
          ONBOARDING_V2_ENABLED: false,
          ONBOARDING_V3_ENABLED: false,
          SESSION_CAPTURE_ENABLED: false,
          SELECTION_REVIEW_V2_ENABLED: false,
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { findHostAppForDocument } = require('../hostApps');
      expect(findHostAppForDocument('/x/y.md')?.id).toBe('obsidian');
      expect(findHostAppForDocument('/x/y.docx')?.id).toBe('word');
      expect(findHostAppForDocument('/x/y.txt')).toBeNull();
      expect(findHostAppForDocument(null)).toBeNull();
      expect(findHostAppForDocument(undefined)).toBeNull();
    });
  });

  it('returns null for .md when obsidian is not registered', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../shared/types', () => ({
        FEATURES: {
          MS_WORD_INTEGRATION_ENABLED: true,
          OBSIDIAN_INTEGRATION_ENABLED: false,
          APPLE_NOTES_INTEGRATION_ENABLED: false,
          MS_WORD_V2_ENABLED: true,
          ONBOARDING_V2_ENABLED: false,
          ONBOARDING_V3_ENABLED: false,
          SESSION_CAPTURE_ENABLED: false,
          SELECTION_REVIEW_V2_ENABLED: false,
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { findHostAppForDocument } = require('../hostApps');
      expect(findHostAppForDocument('/x/y.md')).toBeNull();
      expect(findHostAppForDocument('/x/y.docx')?.id).toBe('word');
    });
  });

  it('routes applenotes:// scheme to apple-notes when registered', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../shared/types', () => ({
        FEATURES: {
          MS_WORD_INTEGRATION_ENABLED: true,
          OBSIDIAN_INTEGRATION_ENABLED: false,
          APPLE_NOTES_INTEGRATION_ENABLED: true,
          GOOGLE_DOCS_INTEGRATION_ENABLED: false,
          MS_WORD_V2_ENABLED: true,
          ONBOARDING_V2_ENABLED: false,
          ONBOARDING_V3_ENABLED: false,
          SESSION_CAPTURE_ENABLED: false,
          SELECTION_REVIEW_V2_ENABLED: false,
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { findHostAppForDocument } = require('../hostApps');
      expect(findHostAppForDocument('applenotes://x-coredata://store-uuid/ICNote/p123')?.id).toBe('apple-notes');
      expect(findHostAppForDocument('applenotes://anything-here')?.id).toBe('apple-notes');
    });
  });

  it('returns null for applenotes:// when apple-notes is not registered', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../shared/types', () => ({
        FEATURES: {
          MS_WORD_INTEGRATION_ENABLED: true,
          OBSIDIAN_INTEGRATION_ENABLED: false,
          APPLE_NOTES_INTEGRATION_ENABLED: false,
          GOOGLE_DOCS_INTEGRATION_ENABLED: false,
          MS_WORD_V2_ENABLED: true,
          ONBOARDING_V2_ENABLED: false,
          ONBOARDING_V3_ENABLED: false,
          SESSION_CAPTURE_ENABLED: false,
          SELECTION_REVIEW_V2_ENABLED: false,
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { findHostAppForDocument } = require('../hostApps');
      expect(findHostAppForDocument('applenotes://x-coredata://store-uuid/ICNote/p123')).toBeNull();
    });
  });

  it('routes gdocs:// scheme to google-docs when registered', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../shared/types', () => ({
        FEATURES: {
          MS_WORD_INTEGRATION_ENABLED: true,
          OBSIDIAN_INTEGRATION_ENABLED: false,
          APPLE_NOTES_INTEGRATION_ENABLED: false,
          GOOGLE_DOCS_INTEGRATION_ENABLED: true,
          MS_WORD_V2_ENABLED: true,
          ONBOARDING_V2_ENABLED: false,
          ONBOARDING_V3_ENABLED: false,
          SESSION_CAPTURE_ENABLED: false,
          SELECTION_REVIEW_V2_ENABLED: false,
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { findHostAppForDocument } = require('../hostApps');
      expect(findHostAppForDocument('gdocs://1A2B3C_dEfGh-iJkLmNoP')?.id).toBe('google-docs');
    });
  });

  it('returns null for gdocs:// when google-docs is not registered', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../shared/types', () => ({
        FEATURES: {
          MS_WORD_INTEGRATION_ENABLED: true,
          OBSIDIAN_INTEGRATION_ENABLED: false,
          APPLE_NOTES_INTEGRATION_ENABLED: false,
          GOOGLE_DOCS_INTEGRATION_ENABLED: false,
          MS_WORD_V2_ENABLED: true,
          ONBOARDING_V2_ENABLED: false,
          ONBOARDING_V3_ENABLED: false,
          SESSION_CAPTURE_ENABLED: false,
          SELECTION_REVIEW_V2_ENABLED: false,
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { findHostAppForDocument } = require('../hostApps');
      expect(findHostAppForDocument('gdocs://1A2B3C')).toBeNull();
    });
  });
});

describe('googleDocsHostApp: URL parsing', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    googleDocsUrlToDocumentPath,
    documentPathToGoogleDocId,
  } = require('../hostApps/googleDocsHostApp');

  it('parses the standard /edit URL into gdocs://<id>', () => {
    expect(googleDocsUrlToDocumentPath('https://docs.google.com/document/d/1A2B3C_dEfGh-iJkLmNoP/edit'))
      .toBe('gdocs://1A2B3C_dEfGh-iJkLmNoP');
  });

  it('handles preview, view, copy, and trailing-query variants the same way', () => {
    const expected = 'gdocs://1A2B3C_dEfGh-iJkLmNoP';
    expect(googleDocsUrlToDocumentPath('https://docs.google.com/document/d/1A2B3C_dEfGh-iJkLmNoP/preview')).toBe(expected);
    expect(googleDocsUrlToDocumentPath('https://docs.google.com/document/d/1A2B3C_dEfGh-iJkLmNoP/view?usp=sharing')).toBe(expected);
    expect(googleDocsUrlToDocumentPath('https://docs.google.com/document/d/1A2B3C_dEfGh-iJkLmNoP/copy')).toBe(expected);
    expect(googleDocsUrlToDocumentPath('https://docs.google.com/document/d/1A2B3C_dEfGh-iJkLmNoP?tab=foo')).toBe(expected);
    expect(googleDocsUrlToDocumentPath('https://docs.google.com/document/d/1A2B3C_dEfGh-iJkLmNoP')).toBe(expected);
  });

  it('round-trips the doc id', () => {
    const id = 'aBcDeF_GhIjK-12345';
    const path = googleDocsUrlToDocumentPath(`https://docs.google.com/document/d/${id}/edit`);
    expect(path).toBe(`gdocs://${id}`);
    expect(documentPathToGoogleDocId(path)).toBe(id);
  });

  it('returns null for non-Docs Google URLs', () => {
    expect(googleDocsUrlToDocumentPath('https://docs.google.com/spreadsheets/d/abc123/edit')).toBeNull();
    expect(googleDocsUrlToDocumentPath('https://docs.google.com/presentation/d/abc123/edit')).toBeNull();
    expect(googleDocsUrlToDocumentPath('https://docs.google.com/forms/d/abc123/edit')).toBeNull();
    expect(googleDocsUrlToDocumentPath('https://drive.google.com/file/d/abc123/view')).toBeNull();
  });

  it('returns null for non-Google URLs and empty input', () => {
    expect(googleDocsUrlToDocumentPath('https://example.com/document/d/abc123/edit')).toBeNull();
    expect(googleDocsUrlToDocumentPath('about:blank')).toBeNull();
    expect(googleDocsUrlToDocumentPath('')).toBeNull();
    expect(googleDocsUrlToDocumentPath(null)).toBeNull();
    expect(googleDocsUrlToDocumentPath(undefined)).toBeNull();
  });

  it('documentPathToGoogleDocId rejects malformed paths', () => {
    expect(documentPathToGoogleDocId('gdocs://has spaces')).toBeNull();
    expect(documentPathToGoogleDocId('gdocs://abc/extra')).toBeNull();
    expect(documentPathToGoogleDocId('applenotes://x')).toBeNull();
    expect(documentPathToGoogleDocId('/local/file.md')).toBeNull();
    expect(documentPathToGoogleDocId(null)).toBeNull();
    expect(documentPathToGoogleDocId(undefined)).toBeNull();
  });
});

describe('googleDocsHostApp.applyEdit', () => {
  it('returns a "connect Google" error when the user has not connected the Docs API', async () => {
    jest.resetModules();
    jest.doMock('../googleDocsService', () => ({
      isConnected: () => false,
      findAndReplace: jest.fn(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { googleDocsHostApp } = require('../hostApps/googleDocsHostApp');
    const result = await googleDocsHostApp.applyEdit({
      document_path: 'gdocs://abc123',
      search_text: 'foo',
      replacement_text: 'bar',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connect your Google account/i);
    expect(result.replacementsCount).toBe(0);
  });

  it('forwards a well-formed apply-edit through the Docs API when connected', async () => {
    jest.resetModules();
    jest.doMock('../googleDocsService', () => ({
      isConnected: () => true,
      findAndReplace: jest.fn(async () => ({ success: true, data: { replacementsCount: 3 } })),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { googleDocsHostApp } = require('../hostApps/googleDocsHostApp');
    const result = await googleDocsHostApp.applyEdit({
      document_path: 'gdocs://abc123',
      search_text: 'foo',
      replacement_text: 'bar',
      match_case: true,
    });
    expect(result.success).toBe(true);
    expect(result.replacementsCount).toBe(3);
  });

  it('rejects when document_path is not a gdocs:// scheme', async () => {
    jest.resetModules();
    jest.doMock('../googleDocsService', () => ({
      isConnected: () => true,
      findAndReplace: jest.fn(async () => ({ success: true, data: { replacementsCount: 1 } })),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { googleDocsHostApp } = require('../hostApps/googleDocsHostApp');
    const result = await googleDocsHostApp.applyEdit({
      document_path: '/Users/x/file.md',
      search_text: 'foo',
      replacement_text: 'bar',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gdocs:/i);
  });
});

describe('appleNotesActions: synthetic path scheme', () => {
  it('round-trips noteId through documentPath', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { noteIdToDocumentPath, documentPathToNoteId } = require('../../../server/appleNotesActions');
    const id = 'x-coredata://0AEF0372-E676-4E46-BCBC-2724318A01F5/ICNote/p334';
    const path = noteIdToDocumentPath(id);
    expect(path).toBe(`applenotes://${id}`);
    expect(documentPathToNoteId(path)).toBe(id);
  });

  it('rejects non-applenotes paths', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { documentPathToNoteId } = require('../../../server/appleNotesActions');
    expect(documentPathToNoteId('/Users/x/file.md')).toBeNull();
    expect(documentPathToNoteId('file:///Users/x/file.docx')).toBeNull();
    expect(documentPathToNoteId(null)).toBeNull();
    expect(documentPathToNoteId(undefined)).toBeNull();
  });

  it('validates note id shape', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isValidNoteId } = require('../../../server/appleNotesActions');
    expect(isValidNoteId('x-coredata://0AEF0372/ICNote/p334')).toBe(true);
    expect(isValidNoteId('x-coredata:///ICNote/p334')).toBe(false);
    expect(isValidNoteId('x-coredata://0AEF/ICOther/p1')).toBe(false);
    expect(isValidNoteId('not a real id')).toBe(false);
    expect(isValidNoteId(null)).toBe(false);
  });
});

describe('appleNotesHostApp.applyEdit boundary', () => {
  // Mock the AppleScript layer so we don't hit osascript in tests.
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../../server/appleNotesActions', () => {
      const actual = jest.requireActual('../../../server/appleNotesActions');
      return {
        ...actual,
        findAndReplaceInNote: jest.fn(async () => ({ success: true, replacementsCount: 1 })),
      };
    });
  });

  it('rejects when document_path is missing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { appleNotesHostApp } = require('../hostApps/appleNotesHostApp');
    const result = await appleNotesHostApp.applyEdit({
      search_text: 'foo',
      replacement_text: 'bar',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/document_path/);
  });

  it('rejects when document_path uses the wrong scheme', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { appleNotesHostApp } = require('../hostApps/appleNotesHostApp');
    const result = await appleNotesHostApp.applyEdit({
      document_path: '/Users/x/file.md',
      search_text: 'foo',
      replacement_text: 'bar',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/applenotes:/);
  });

  it('rejects when the note id is malformed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { appleNotesHostApp } = require('../hostApps/appleNotesHostApp');
    const result = await appleNotesHostApp.applyEdit({
      document_path: 'applenotes://not a real id',
      search_text: 'foo',
      replacement_text: 'bar',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid Apple Notes id/);
  });

  it('forwards a well-formed apply-edit to findAndReplaceInNote', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { appleNotesHostApp } = require('../hostApps/appleNotesHostApp');
    const result = await appleNotesHostApp.applyEdit({
      document_path: 'applenotes://x-coredata://store-uuid/ICNote/p1',
      search_text: 'foo',
      replacement_text: 'bar',
      replace_scope: 'all',
      match_case: false,
    });
    expect(result.success).toBe(true);
    expect(result.replacementsCount).toBe(1);
  });
});
