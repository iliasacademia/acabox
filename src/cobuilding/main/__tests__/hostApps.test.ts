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
});
