import {
  buildMcpServers,
  connectorAllowedTools,
  connectorTarget,
  CONNECTOR_CATALOG,
  CONNECTOR_ID_PATTERN,
  RESERVED_CONNECTOR_IDS,
  toMcpServerConfig,
  validateConnector,
  type ConnectorConfig,
} from '../connectors';

const http = (over: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
  id: 'hex',
  label: 'Hex',
  transport: 'http',
  url: 'https://app.hex.tech/mcp',
  enabled: true,
  ...over,
});

describe('validateConnector', () => {
  it('accepts a well-formed https connector', () => {
    expect(validateConnector(http())).toEqual({ ok: true });
  });

  it('requires a name and rejects names that break tool naming', () => {
    // Tools are addressed as mcp__<id>__<tool>, so `__` makes the split
    // ambiguous and spaces/dots break the allow-list patterns.
    expect(validateConnector(http({ id: '' })).ok).toBe(false);
    expect(validateConnector(http({ id: 'my__hex' })).ok).toBe(false);
    expect(validateConnector(http({ id: 'my hex' })).ok).toBe(false);
    expect(validateConnector(http({ id: 'my.hex' })).ok).toBe(false);
    expect(validateConnector(http({ id: '-hex' })).ok).toBe(false);
    expect(validateConnector(http({ id: 'hex-2' })).ok).toBe(true);
  });

  it('refuses ids that would shadow an Acabox relay server', () => {
    for (const reserved of RESERVED_CONNECTOR_IDS) {
      const result = validateConnector(http({ id: reserved }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('reserved');
    }
    // The relay set is what the agent uses for mini-apps and the workspace
    // index; shadowing one would silently break those tools.
    expect(RESERVED_CONNECTOR_IDS).toContain('mini-apps');
    expect(RESERVED_CONNECTOR_IDS).toContain('workspace');
  });

  it('rejects a duplicate id', () => {
    expect(validateConnector(http(), ['hex']).ok).toBe(false);
    expect(validateConnector(http(), ['other']).ok).toBe(true);
  });

  it('refuses plaintext http for remote hosts but allows loopback', () => {
    expect(validateConnector(http({ url: 'http://evil.example.com/mcp' })).ok).toBe(false);
    expect(validateConnector(http({ url: 'http://localhost:8080/mcp' })).ok).toBe(true);
    expect(validateConnector(http({ url: 'http://127.0.0.1:8080/mcp' })).ok).toBe(true);
    expect(validateConnector(http({ url: 'http://[::1]:8080/mcp' })).ok).toBe(true);
  });

  it('is not fooled by a remote host that merely contains a loopback name', () => {
    expect(validateConnector(http({ url: 'http://localhost.evil.com/mcp' })).ok).toBe(false);
    expect(validateConnector(http({ url: 'http://127.0.0.1.evil.com/mcp' })).ok).toBe(false);
  });

  it('rejects malformed and non-http URLs', () => {
    expect(validateConnector(http({ url: 'not a url' })).ok).toBe(false);
    expect(validateConnector(http({ url: 'ftp://example.com/mcp' })).ok).toBe(false);
    expect(validateConnector(http({ url: '' })).ok).toBe(false);
  });

  it('validates stdio on command, not url', () => {
    expect(validateConnector({ id: 'fs', transport: 'stdio', command: 'npx', enabled: true }).ok).toBe(true);
    expect(validateConnector({ id: 'fs', transport: 'stdio', command: '  ', enabled: true }).ok).toBe(false);
  });

  it('requires a known transport', () => {
    expect(validateConnector({ id: 'x', transport: 'carrier-pigeon' as any, enabled: true }).ok).toBe(false);
  });
});

describe('toMcpServerConfig', () => {
  it('emits the SDK http shape', () => {
    expect(toMcpServerConfig(http())).toEqual({ type: 'http', url: 'https://app.hex.tech/mcp' });
  });

  it('emits sse and stdio shapes', () => {
    expect(toMcpServerConfig(http({ transport: 'sse' })))
      .toEqual({ type: 'sse', url: 'https://app.hex.tech/mcp' });
    expect(toMcpServerConfig({
      id: 'fs', label: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], enabled: true,
    })).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
  });

  it('includes headers and alwaysLoad only when set', () => {
    expect(toMcpServerConfig(http({ headers: { Authorization: 'Bearer t' } })))
      .toEqual({ type: 'http', url: 'https://app.hex.tech/mcp', headers: { Authorization: 'Bearer t' } });
    expect(toMcpServerConfig(http({ alwaysLoad: true })).alwaysLoad).toBe(true);
    expect('alwaysLoad' in toMcpServerConfig(http())).toBe(false);
  });

  it('drops blank header rows the UI leaves behind', () => {
    // The form always renders one empty key/value row; it must not reach the SDK.
    const cfg = toMcpServerConfig(http({ headers: { '': 'x', '  ': 'y', Authorization: 'Bearer t' } }));
    expect(cfg.headers).toEqual({ Authorization: 'Bearer t' });
  });

  it('omits an entirely empty headers object', () => {
    expect('headers' in toMcpServerConfig(http({ headers: {} }))).toBe(false);
  });
});

describe('buildMcpServers', () => {
  it('includes only enabled connectors', () => {
    const servers = buildMcpServers([
      http(),
      http({ id: 'sentry', url: 'https://mcp.sentry.dev/mcp', enabled: false }),
    ]);
    expect(Object.keys(servers)).toEqual(['hex']);
  });

  it('skips invalid rows instead of throwing', () => {
    // A row saved by an older build must not take the whole agent down.
    const servers = buildMcpServers([
      http({ id: 'bad name' }),
      http({ id: 'no-url', url: '' }),
      http({ id: 'good' }),
    ]);
    expect(Object.keys(servers)).toEqual(['good']);
  });

  it('drops a duplicate id rather than letting it shadow the first', () => {
    const servers = buildMcpServers([http({ url: 'https://a.example.com/mcp' }), http({ url: 'https://b.example.com/mcp' })]);
    expect(Object.keys(servers)).toEqual(['hex']);
    expect((servers.hex as any).url).toBe('https://a.example.com/mcp');
  });

  it('returns an empty record for no connectors', () => {
    expect(buildMcpServers([])).toEqual({});
  });
});

describe('connectorAllowedTools', () => {
  it('emits a whole-server pattern per enabled connector', () => {
    expect(connectorAllowedTools([http(), http({ id: 'off', enabled: false })]))
      .toEqual(['mcp__hex']);
  });
});

describe('connectorTarget', () => {
  it('shows the url for remote and the command line for stdio', () => {
    expect(connectorTarget(http())).toBe('https://app.hex.tech/mcp');
    expect(connectorTarget({
      id: 'fs', label: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], enabled: true,
    })).toBe('npx -y pkg');
  });
});

describe('CONNECTOR_CATALOG', () => {
  it('every entry is itself a valid connector', () => {
    // A catalog entry the user cannot save would be a dead button.
    for (const entry of CONNECTOR_CATALOG) {
      const result = validateConnector({
        id: entry.id,
        label: entry.label,
        transport: entry.transport,
        url: entry.url,
        command: entry.command,
        enabled: true,
      });
      expect([entry.catalogId, result.ok]).toEqual([entry.catalogId, true]);
    }
  });

  it('has unique catalogIds and default ids', () => {
    const catalogIds = CONNECTOR_CATALOG.map((e) => e.catalogId);
    const ids = CONNECTOR_CATALOG.map((e) => e.id);
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names every catalog id in a form the tool namespace accepts', () => {
    for (const entry of CONNECTOR_CATALOG) {
      expect([entry.id, CONNECTOR_ID_PATTERN.test(entry.id)]).toEqual([entry.id, true]);
    }
  });

  it('declares a header name whenever auth is header-based', () => {
    for (const entry of CONNECTOR_CATALOG) {
      if (entry.auth === 'header') expect(entry.headerName).toBeTruthy();
    }
  });
});
