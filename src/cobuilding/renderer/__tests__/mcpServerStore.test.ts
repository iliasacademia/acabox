/**
 * The merged MCP-server row store (design: `docs/design/mcp-hosting.md`,
 * Increment 3 — "Live status — pattern A, mandatory"). Exercises the real
 * store module, not a reimplementation, so a regression in the diff guard or
 * the demotion rule shows up here rather than passing while the app still
 * repaints on every push.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  applyConnectorConfigs,
  applyConnectorStatus,
  applyHostedServers,
  applyMiniAppServers,
  getServerSnapshot,
  useServerRows,
  useServerCounts,
  __resetMcpServerStore,
} from '../mcpServerStore';
import { builtinServers } from '../../shared/mcpServers';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  __resetMcpServerStore();
});

function rowsOfKind(kind: string) {
  return getServerSnapshot().filter((r) => r.kind === kind);
}

describe('builtin rows', () => {
  it('are always present, one per relay in BASE_AGENT_ALLOWED_TOOLS', () => {
    expect(rowsOfKind('builtin').length).toBe(builtinServers().length);
    expect(rowsOfKind('builtin').every((r) => r.state === 'available')).toBe(true);
  });
});

describe('the diff guard', () => {
  it('pushing an identical connector status twice causes exactly one re-render', async () => {
    applyConnectorConfigs([{ id: 'hex', label: 'Hex', enabled: true }]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let renderCount = 0;

    function Probe() {
      useServerRows();
      renderCount += 1;
      return null;
    }

    await act(async () => { root.render(React.createElement(Probe)); });
    const afterMount = renderCount;

    await act(async () => {
      applyConnectorStatus({ reports: [{ name: 'hex', status: 'connected' }], observedAt: 1000, live: true });
    });
    const afterFirstStatus = renderCount;
    expect(afterFirstStatus).toBeGreaterThan(afterMount);

    // Same content, new object — must NOT cause a second re-render.
    await act(async () => {
      applyConnectorStatus({ reports: [{ name: 'hex', status: 'connected' }], observedAt: 1000, live: true });
    });
    expect(renderCount).toBe(afterFirstStatus);

    // A genuine change (live flips false) must still re-render.
    await act(async () => {
      applyConnectorStatus({ reports: [{ name: 'hex', status: 'connected' }], observedAt: 1000, live: false });
    });
    expect(renderCount).toBeGreaterThan(afterFirstStatus);

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('also holds at the snapshot-identity level: unchanged input keeps the same array reference', () => {
    applyConnectorConfigs([{ id: 'hex', label: 'Hex', enabled: true }]);
    applyConnectorStatus({ reports: [{ name: 'hex', status: 'connected' }], observedAt: 1000, live: true });
    const first = getServerSnapshot();

    applyConnectorStatus({ reports: [{ name: 'hex', status: 'connected' }], observedAt: 1000, live: true });
    expect(getServerSnapshot()).toBe(first);

    applyConnectorStatus({ reports: [{ name: 'hex', status: 'connected' }], observedAt: 1000, live: false });
    expect(getServerSnapshot()).not.toBe(first);
  });
});

describe('precedence ordering, applied through the store', () => {
  it('a hosted server that is off stays Off even while its last-observed run state was failed', () => {
    applyHostedServers([{
      id: 'files', label: 'Files', enabled: false, autostart: false,
      install: { kind: 'custom' }, command: '/usr/bin/node', args: ['server.js'],
      state: 'failed', error: 'boom',
    }]);
    const row = rowsOfKind('hosted').find((r) => r.id === 'files');
    expect(row?.state).toBe('off');
    // Off suppresses the error line too — it must not read "Off · boom".
    expect(row?.error).toBeUndefined();
  });

  it('a disabled connector stays Off even with a needs-auth report cached', () => {
    applyConnectorConfigs([{ id: 'hex', label: 'Hex', enabled: false }]);
    applyConnectorStatus({ reports: [{ name: 'hex', status: 'needs-auth' }], observedAt: 500, live: true });
    const row = rowsOfKind('remote').find((r) => r.id === 'hex');
    expect(row?.state).toBe('off');
  });

  it('a connector reported failed is NOT demoted to notChecked even when live is false', () => {
    applyConnectorConfigs([{ id: 'hex', label: 'Hex', enabled: true }]);
    applyConnectorStatus({ reports: [{ name: 'hex', status: 'failed', error: 'handshake timeout' }], observedAt: 500, live: false });
    const row = rowsOfKind('remote').find((r) => r.id === 'hex');
    expect(row?.state).toBe('failed');
    expect(row?.error).toBe('handshake timeout');
  });
});

describe('live:false demotion', () => {
  it('demotes a previously-available remote row to Not checked and preserves observedAt', () => {
    applyConnectorConfigs([{ id: 'hex', label: 'Hex', enabled: true }]);
    applyConnectorStatus({ reports: [{ name: 'hex', status: 'connected', toolCount: 4 }], observedAt: 424242, live: true });

    let row = rowsOfKind('remote').find((r) => r.id === 'hex');
    expect(row?.state).toBe('available');

    applyConnectorStatus({ reports: [{ name: 'hex', status: 'connected', toolCount: 4 }], observedAt: 424242, live: false });

    row = rowsOfKind('remote').find((r) => r.id === 'hex');
    expect(row?.state).toBe('notChecked');
    expect(row?.meta.kind).toBe('remote');
    if (row?.meta.kind === 'remote') {
      expect(row.meta.observedAt).toBe(424242);
      expect(row.meta.live).toBe(false);
    }
  });
});

describe('mini-app rows', () => {
  it('a server dropping out of the list removes its row with no ghost left behind', () => {
    applyMiniAppServers([{ serverName: 'myTool', dirName: 'myToolDir', tools: [{ name: 't', description: 'd', input_schema: {} }] }]);
    expect(rowsOfKind('miniapp').some((r) => r.id === 'myTool')).toBe(true);

    applyMiniAppServers([]);
    expect(rowsOfKind('miniapp').length).toBe(0);
  });
});

describe('malformed input is dropped, never thrown on', () => {
  it('applyHostedServers tolerates junk entries and keeps only well-formed ones', () => {
    expect(() => applyHostedServers([
      null,
      42,
      'garbage',
      { label: 'no id at all' },
      { id: 'good', enabled: true, state: 'ready', command: 'node', args: [] },
    ] as unknown[])).not.toThrow();

    const hosted = rowsOfKind('hosted');
    expect(hosted.length).toBe(1);
    expect(hosted[0].id).toBe('good');
    expect(hosted[0].state).toBe('available');
  });

  it('coerces an unrecognised run-state string rather than throwing', () => {
    expect(() => applyHostedServers([
      { id: 'weird', enabled: true, state: 'not-a-real-state', command: 'node', args: [] },
    ])).not.toThrow();
    const row = rowsOfKind('hosted').find((r) => r.id === 'weird');
    expect(row?.state).toBe('stopped');
  });

  it('applyConnectorConfigs drops entries with no id', () => {
    expect(() => applyConnectorConfigs([{ label: 'no id' }, { id: 'hex', label: 'Hex', enabled: true }] as unknown[])).not.toThrow();
    expect(rowsOfKind('remote').map((r) => r.id)).toEqual(['hex']);
  });

  it('applyConnectorStatus drops report entries with no name and coerces an unknown status word', () => {
    applyConnectorConfigs([{ id: 'hex', label: 'Hex', enabled: true }]);
    expect(() => applyConnectorStatus({
      reports: [{ status: 'connected' }, { name: 'hex', status: 'not-a-real-status' }],
      observedAt: 1,
      live: true,
    })).not.toThrow();
    const row = rowsOfKind('remote').find((r) => r.id === 'hex');
    expect(row?.state).toBe('notChecked'); // unrecognised status coerces to 'unknown' -> notChecked
  });

  it('applyMiniAppServers drops entries missing serverName or dirName', () => {
    expect(() => applyMiniAppServers([
      { serverName: 'noDir' },
      { dirName: 'noServerName' },
      { serverName: 'ok', dirName: 'okDir', tools: [] },
    ] as unknown[])).not.toThrow();
    expect(rowsOfKind('miniapp').map((r) => r.id)).toEqual(['ok']);
  });

  it('a wholly garbage top-level input never throws', () => {
    expect(() => applyConnectorStatus(null)).not.toThrow();
    expect(() => applyConnectorStatus('nonsense')).not.toThrow();
    expect(() => applyHostedServers([{}, { id: 123 }] as unknown[])).not.toThrow();
  });
});

/**
 * `useServerCounts` (design: `docs/design/mcp-hosting.md`, Increment 4 / R6
 * — the StatusBar's `N SERVERS STARTING` segment). Rendered through React
 * via `useSyncExternalStore`, not called as a plain function, since that IS
 * the hook this file's `StatusBar.tsx` consumer actually uses.
 */
describe('useServerCounts', () => {
  function renderCounts() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest: ReturnType<typeof useServerCounts> | null = null;
    function Probe() {
      latest = useServerCounts();
      return null;
    }
    return {
      mount: () => act(() => { root.render(React.createElement(Probe)); }),
      read: () => latest!,
      cleanup: () => { act(() => { root.unmount(); }); container.remove(); },
    };
  }

  it('counts a hosted `starting` row separately from `down`, and a connector `pending` status counts the same way', () => {
    const probe = renderCounts();
    probe.mount();

    act(() => {
      applyHostedServers([
        { id: 'files', label: 'Files', enabled: true, state: 'starting', command: 'node', args: [] },
        { id: 'broken', label: 'Broken', enabled: true, state: 'failed', error: 'boom', command: 'node', args: [] },
      ]);
      applyConnectorConfigs([{ id: 'hex', label: 'Hex', enabled: true }]);
      applyConnectorStatus({ reports: [{ name: 'hex', status: 'pending' }], observedAt: 1, live: true });
    });

    const counts = probe.read();
    expect(counts.starting).toBe(2); // hosted `files` (starting) + connector `hex` (pending -> starting)
    expect(counts.down).toBe(1); // hosted `broken` (failed) only

    probe.cleanup();
  });

  it('is 0 when nothing is starting, including when the store is freshly reset', () => {
    __resetMcpServerStore();
    const probe = renderCounts();
    probe.mount();
    expect(probe.read().starting).toBe(0);
    probe.cleanup();
  });

  it('a hosted server that finishes starting (ready or failed) drops out of the starting count', () => {
    const probe = renderCounts();
    probe.mount();

    act(() => {
      applyHostedServers([{ id: 'files', label: 'Files', enabled: true, state: 'starting', command: 'node', args: [] }]);
    });
    expect(probe.read().starting).toBe(1);

    act(() => {
      applyHostedServers([{ id: 'files', label: 'Files', enabled: true, state: 'ready', command: 'node', args: [] }]);
    });
    expect(probe.read().starting).toBe(0);

    probe.cleanup();
  });
});

describe('__resetMcpServerStore', () => {
  it('clears every hosted/connector/mini-app row, leaving only the always-present built-ins', () => {
    applyHostedServers([{ id: 'files', enabled: true, state: 'ready', command: 'node', args: [] }]);
    applyConnectorConfigs([{ id: 'hex', label: 'Hex', enabled: true }]);
    applyMiniAppServers([{ serverName: 'myTool', dirName: 'myToolDir', tools: [] }]);
    expect(rowsOfKind('hosted').length + rowsOfKind('remote').length + rowsOfKind('miniapp').length).toBeGreaterThan(0);

    __resetMcpServerStore();
    expect(rowsOfKind('hosted')).toEqual([]);
    expect(rowsOfKind('remote')).toEqual([]);
    expect(rowsOfKind('miniapp')).toEqual([]);
    expect(rowsOfKind('builtin').length).toBe(builtinServers().length);

    // And the underlying maps were really cleared, not just the cached array —
    // pushing an unrelated update must not resurrect the old rows.
    applyConnectorConfigs([{ id: 'sentry', label: 'Sentry', enabled: true }]);
    const ids = getServerSnapshot().map((r) => r.id);
    expect(ids).not.toContain('files');
    expect(ids).not.toContain('myTool');
    expect(ids).toContain('sentry');
  });
});
