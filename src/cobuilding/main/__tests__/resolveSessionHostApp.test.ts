/**
 * @jest-environment node
 */

import * as os from 'os';

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => os.tmpdir()), isPackaged: false, getAppPath: () => '/tmp' },
  shell: { openExternal: jest.fn(async () => true) },
}));

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: jest.fn(() => ({})),
  tool: jest.fn((..._args: unknown[]) => ({})),
}));

jest.mock('../../../native/wordAccessibility', () => ({
  wordAccessibility: {
    checkPermission: () => false,
    requestPermission: () => false,
    openAccessibilitySettings: () => undefined,
    getAppInfo: () => ({ bundleId: 'test', executablePath: '', teamId: '' }),
  },
}));

jest.mock('../../../utils/logger', () => ({
  defaultLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

jest.mock('../../../windowMonitorDb', () => ({
  logToWindowMonitorDb: () => {},
}));

const mockGetFocusedWindowId = jest.fn<string | null, []>(() => null);
const mockGetHostAppIdForWindow = jest.fn<string | null, [string]>(() => null);

jest.mock('../../../windowMonitorService', () => ({
  windowMonitorService: {
    getFocusedWindowId: () => mockGetFocusedWindowId(),
    getHostAppIdForWindow: (id: string) => mockGetHostAppIdForWindow(id),
    getDocumentPathForWindow: () => null,
    getActiveWorkspaceDirectories: () => [],
    suppressSelectionEvents: () => undefined,
  },
}));

import type { HostApp } from '../hostApps/types';

describe('resolveSessionHostApp', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetFocusedWindowId.mockReturnValue(null);
    mockGetHostAppIdForWindow.mockReturnValue(null);
  });

  function loadWithFeatures(features: Record<string, boolean>) {
    jest.doMock('../../../shared/types', () => ({
      FEATURES: {
        MS_WORD_INTEGRATION_ENABLED: true,
        OBSIDIAN_INTEGRATION_ENABLED: true,
        APPLE_NOTES_INTEGRATION_ENABLED: true,
        GOOGLE_DOCS_INTEGRATION_ENABLED: true,
        MS_WORD_V2_ENABLED: true,
        ONBOARDING_V2_ENABLED: false,
        ONBOARDING_V3_ENABLED: false,
        SESSION_CAPTURE_ENABLED: false,
        SELECTION_REVIEW_V2_ENABLED: false,
        ...features,
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveSessionHostApp } = require('../agentSession');
    return resolveSessionHostApp as (docPath: string | null | undefined) => { hostApp: HostApp; matched: boolean };
  }

  it('returns matched:true when document path matches a host app by extension', () => {
    const resolve = loadWithFeatures({});
    const result = resolve('/path/to/paper.docx');
    expect(result.matched).toBe(true);
    expect(result.hostApp.id).toBe('word');
  });

  it('returns matched:true for obsidian .md file', () => {
    const resolve = loadWithFeatures({});
    const result = resolve('/vault/notes/note.md');
    expect(result.matched).toBe(true);
    expect(result.hostApp.id).toBe('obsidian');
  });

  it('returns matched:true for apple notes scheme', () => {
    const resolve = loadWithFeatures({});
    const result = resolve('applenotes://x-coredata://store/ICNote/p1');
    expect(result.matched).toBe(true);
    expect(result.hostApp.id).toBe('apple-notes');
  });

  it('returns matched:true for google docs scheme', () => {
    const resolve = loadWithFeatures({});
    const result = resolve('gdocs://1A2B3C_dEfGh');
    expect(result.matched).toBe(true);
    expect(result.hostApp.id).toBe('google-docs');
  });

  it('returns matched:true when focused window matches a host app', () => {
    mockGetFocusedWindowId.mockReturnValue('win-123');
    mockGetHostAppIdForWindow.mockReturnValue('obsidian');
    const resolve = loadWithFeatures({});
    const result = resolve(null);
    expect(result.matched).toBe(true);
    expect(result.hostApp.id).toBe('obsidian');
  });

  it('returns matched:false when no document path and no focused window match', () => {
    const resolve = loadWithFeatures({});
    const result = resolve(null);
    expect(result.matched).toBe(false);
    expect(result.hostApp).toBeDefined();
  });

  it('returns matched:false when document path is undefined', () => {
    const resolve = loadWithFeatures({});
    const result = resolve(undefined);
    expect(result.matched).toBe(false);
  });

  it('returns matched:false when document extension does not match any host app', () => {
    const resolve = loadWithFeatures({});
    const result = resolve('/path/to/file.txt');
    expect(result.matched).toBe(false);
  });

  it('falls back to Word host app when no match (Word registered)', () => {
    const resolve = loadWithFeatures({});
    const result = resolve(null);
    expect(result.matched).toBe(false);
    expect(result.hostApp.id).toBe('word');
  });

  it('hostApp.allowedTools is populated on matched host app', () => {
    const resolve = loadWithFeatures({});
    const result = resolve('/path/to/paper.docx');
    expect(result.matched).toBe(true);
    expect(result.hostApp.allowedTools).toEqual(expect.arrayContaining([
      'mcp__ms-word__get_text',
      'mcp__ms-word__open_document',
    ]));
  });

  it('hostApp.allowedTools is populated on fallback host app', () => {
    const resolve = loadWithFeatures({});
    const result = resolve(null);
    expect(result.matched).toBe(false);
    expect(result.hostApp.allowedTools.length).toBeGreaterThan(0);
  });
});
