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

jest.mock('../../../windowMonitorService', () => ({
  windowMonitorService: {
    getFocusedWindowId: () => null,
    getDocumentPathForWindow: () => null,
    getActiveWorkspaceDirectories: () => [],
    suppressSelectionEvents: () => undefined,
  },
}));

const ALL_HOST_APP_TOOLS = [
  'mcp__ms-word__get_file_path',
  'mcp__ms-word__get_text',
  'mcp__ms-word__get_selection',
  'mcp__ms-word__save_document',
  'mcp__ms-word__open_document',
  'mcp__ms-word__find_and_replace',
  'mcp__google-docs__get_active_doc',
  'mcp__google-docs__get_text',
  'mcp__google-docs__find_and_replace',
  'mcp__apple-notes__get_active_note',
  'mcp__apple-notes__get_text',
  'mcp__apple-notes__list_notes',
  'mcp__apple-notes__search_notes',
  'mcp__apple-notes__save_note',
  'mcp__apple-notes__open_note',
  'mcp__apple-notes__find_and_replace',
  'mcp__obsidian__get_active_note',
  'mcp__obsidian__get_text',
  'mcp__obsidian__list_notes',
  'mcp__obsidian__open_note',
  'mcp__obsidian__find_and_replace',
];

describe('AgentInfrastructureController: base allowedTools', () => {
  /**
   * Read the allowedTools array from the source. The config is built inline
   * in `start()` so we parse the source to extract the list rather than
   * running the full method (which needs a container, filesystem, etc.).
   */
  it('does not include any host-app tools in the base allowedTools', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const source: string = fs.readFileSync(
      require.resolve('../controllers/AgentInfrastructureController'),
      'utf-8',
    );

    for (const tool of ALL_HOST_APP_TOOLS) {
      expect(source).not.toContain(`'${tool}'`);
    }
  });

  it('still includes core tools and non-host-app MCP tools', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const source: string = fs.readFileSync(
      require.resolve('../controllers/AgentInfrastructureController'),
      'utf-8',
    );

    const coreMustHave = [
      'Bash', 'Read', 'Write', 'Edit',
      'mcp__activity__query_activity',
      'mcp__citeright__find_references',
      'mcp__zotero__status',
      'mcp__workspace__get_scanned_files',
      'mcp__workspace__get_research_profile',
    ];

    for (const tool of coreMustHave) {
      expect(source).toContain(`'${tool}'`);
    }
  });
});

describe('mergeSessionConfig', () => {
  // Import pure functions from the sessionConfig module
  // (extracted to avoid loading the full agent-server with its side effects).
  let mergeSessionConfig: typeof import('../../agent-server/sessionConfig').mergeSessionConfig;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ mergeSessionConfig } = require('../../agent-server/sessionConfig'));
  });

  const baseConfig = {
    port: 8080,
    claudeBinaryPath: '/data/.academia/claude',
    mcpServers: {},
    anthropicApiKey: 'test-key',
    model: 'claude-opus-4-7',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['Bash', 'Read', 'Write', 'mcp__activity__query_activity'],
    settingSources: ['project'],
  };

  it('returns base config unchanged when no overrides', () => {
    const result = mergeSessionConfig(baseConfig);
    expect(result.allowedTools).toEqual(baseConfig.allowedTools);
    expect(result.soulMd).toBeUndefined();
    expect(result.docxGuidance).toBeUndefined();
  });

  it('returns base config unchanged when overrides are empty', () => {
    const result = mergeSessionConfig(baseConfig, {});
    expect(result.allowedTools).toEqual(baseConfig.allowedTools);
  });

  it('appends additionalAllowedTools to base allowedTools', () => {
    const wordTools = [
      'mcp__ms-word__get_text',
      'mcp__ms-word__open_document',
    ];
    const result = mergeSessionConfig(baseConfig, {
      additionalAllowedTools: wordTools,
    });
    expect(result.allowedTools).toEqual([
      ...baseConfig.allowedTools,
      ...wordTools,
    ]);
  });

  it('does not modify the base config allowedTools array', () => {
    const originalTools = [...baseConfig.allowedTools];
    mergeSessionConfig(baseConfig, {
      additionalAllowedTools: ['mcp__ms-word__get_text'],
    });
    expect(baseConfig.allowedTools).toEqual(originalTools);
  });

  it('does not add tools when additionalAllowedTools is empty array', () => {
    const result = mergeSessionConfig(baseConfig, {
      additionalAllowedTools: [],
    });
    expect(result.allowedTools).toEqual(baseConfig.allowedTools);
  });

  it('sets soulMd from overrides', () => {
    const result = mergeSessionConfig(baseConfig, {
      soulMd: 'You are a helpful researcher.',
    });
    expect(result.soulMd).toBe('You are a helpful researcher.');
  });

  it('sets docxGuidance from hostGuidance override', () => {
    const result = mergeSessionConfig(baseConfig, {
      hostGuidance: 'Use ms-word MCP tools for editing.',
    });
    expect(result.docxGuidance).toBe('Use ms-word MCP tools for editing.');
  });

  it('overrides preserve base config soulMd when not provided', () => {
    const configWithSoulMd = { ...baseConfig, soulMd: 'existing' };
    const result = mergeSessionConfig(configWithSoulMd, {
      additionalAllowedTools: ['mcp__ms-word__get_text'],
    });
    expect(result.soulMd).toBe('existing');
  });

  it('overrides soulMd takes precedence over base config soulMd', () => {
    const configWithSoulMd = { ...baseConfig, soulMd: 'old soul' };
    const result = mergeSessionConfig(configWithSoulMd, {
      soulMd: 'new soul',
    });
    expect(result.soulMd).toBe('new soul');
  });

  it('preserves all other config properties unchanged', () => {
    const result = mergeSessionConfig(baseConfig, {
      additionalAllowedTools: ['mcp__ms-word__get_text'],
      soulMd: 'test',
      hostGuidance: 'guidance',
    });
    expect(result.port).toBe(baseConfig.port);
    expect(result.claudeBinaryPath).toBe(baseConfig.claudeBinaryPath);
    expect(result.anthropicApiKey).toBe(baseConfig.anthropicApiKey);
    expect(result.model).toBe(baseConfig.model);
    expect(result.settingSources).toEqual(baseConfig.settingSources);
  });
});

describe('filterMcpServers', () => {
  let filterMcpServers: typeof import('../../agent-server/sessionConfig').filterMcpServers;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ filterMcpServers } = require('../../agent-server/sessionConfig'));
  });

  const allServers: Record<string, unknown> = {
    activity: { name: 'activity' },
    'ms-word': { name: 'ms-word' },
    'google-docs': { name: 'google-docs' },
    'apple-notes': { name: 'apple-notes' },
    obsidian: { name: 'obsidian' },
    citeright: { name: 'citeright' },
    workspace: { name: 'workspace' },
  };

  it('keeps only servers whose tools appear in allowedTools', () => {
    const allowed = ['mcp__activity__query_activity', 'mcp__citeright__find_references'];
    const result = filterMcpServers(allServers, allowed);
    expect(Object.keys(result).sort()).toEqual(['activity', 'citeright']);
  });

  it('excludes ms-word server when no ms-word tools in allowedTools', () => {
    const allowed = ['Bash', 'Read', 'mcp__activity__query_activity'];
    const result = filterMcpServers(allServers, allowed);
    expect(result).not.toHaveProperty('ms-word');
  });

  it('includes ms-word server when ms-word tools are in allowedTools', () => {
    const allowed = ['mcp__ms-word__get_text', 'mcp__activity__query_activity'];
    const result = filterMcpServers(allServers, allowed);
    expect(result).toHaveProperty('ms-word');
    expect(result).toHaveProperty('activity');
  });

  it('returns empty object when no MCP tools in allowedTools', () => {
    const allowed = ['Bash', 'Read', 'Write'];
    const result = filterMcpServers(allServers, allowed);
    expect(Object.keys(result)).toEqual([]);
  });

  it('returns all servers when all have matching tools', () => {
    const allowed = [
      'mcp__activity__query_activity',
      'mcp__ms-word__get_text',
      'mcp__google-docs__get_text',
      'mcp__apple-notes__get_text',
      'mcp__obsidian__get_text',
      'mcp__citeright__find_references',
      'mcp__workspace__get_scanned_files',
    ];
    const result = filterMcpServers(allServers, allowed);
    expect(Object.keys(result).sort()).toEqual(Object.keys(allServers).sort());
  });

  it('does not modify the original servers object', () => {
    const original = { ...allServers };
    filterMcpServers(allServers, ['mcp__activity__query_activity']);
    expect(allServers).toEqual(original);
  });
});

describe('Per-session host-app tool isolation (end-to-end wiring)', () => {
  it('each host app defines its own allowedTools that match its MCP tool prefix', () => {
    jest.resetModules();
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
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRegisteredHostApps } = require('../hostApps');
    const hosts = getRegisteredHostApps();

    const expectedPrefixes: Record<string, string> = {
      word: 'mcp__ms-word__',
      obsidian: 'mcp__obsidian__',
      'apple-notes': 'mcp__apple-notes__',
      'google-docs': 'mcp__google-docs__',
    };

    for (const host of hosts) {
      const prefix = expectedPrefixes[host.id];
      expect(prefix).toBeDefined();
      expect(host.allowedTools.length).toBeGreaterThan(0);
      for (const tool of host.allowedTools) {
        expect(tool).toMatch(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      }
    }
  });

  it('host-app tool prefixes do not appear in tools of other host apps', () => {
    jest.resetModules();
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
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRegisteredHostApps } = require('../hostApps');
    const hosts = getRegisteredHostApps();

    for (const host of hosts) {
      const otherTools = hosts
        .filter((h: any) => h.id !== host.id)
        .flatMap((h: any) => h.allowedTools);
      for (const tool of host.allowedTools) {
        expect(otherTools).not.toContain(tool);
      }
    }
  });
});
