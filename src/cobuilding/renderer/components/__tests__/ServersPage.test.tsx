import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ServersPage } from '../servers/ServersPage';
import { applyHostedServers, applyMiniAppServers, __resetMcpServerStore } from '../../mcpServerStore';
import { builtinServers } from '../../../shared/mcpServers';
import { BASE_AGENT_ALLOWED_TOOLS } from '../../../shared/agentAllowedTools';

/**
 * The Servers page's whole claim is the same as Knowledge's: everything on
 * it is real, and the vocabulary cannot drift (`docs/design/mcp-hosting.md`,
 * Increment 3 — "the status line carries only the shared word"). So most of
 * these assertions are NEGATIVE: `pid` must never land in the status line,
 * "Never read" must say so rather than a fabricated tool count, and the
 * empty state must point at the real (chat) acquisition path rather than at
 * the Advanced form.
 */

const mockSetText = jest.fn();
const mockSend = jest.fn();

jest.mock('@assistant-ui/react', () => ({
  useComposerRuntime: () => ({ setText: mockSetText, send: mockSend }),
}));

// React 19 warns on every state update outside act() without this.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;

/** Set a controlled `<input>`'s value the way a real keystroke would, so
 *  React's `onChange` actually fires (a plain `el.value = x` does not). */
function typeInto(el: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button with text "${text}"`);
  return btn as HTMLButtonElement;
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const el = container.querySelector(`input[placeholder="${placeholder}"]`);
  if (!el) throw new Error(`No input with placeholder "${placeholder}"`);
  return el as HTMLInputElement;
}

let saveSpy: jest.Mock;
let testSpy: jest.Mock;

beforeAll(() => {
  saveSpy = jest.fn(async () => ({ ok: true }));
  testSpy = jest.fn(async () => ({ ok: true, resolvedCommand: '/usr/bin/node', pathResolved: true, toolNames: ['echo'], stderrTail: '' }));
  (window as any).mcpServersAPI = {
    list: jest.fn(async () => []),
    onChanged: jest.fn(() => () => {}),
    start: jest.fn(async () => ({ ok: true })),
    stop: jest.fn(async () => ({ ok: true })),
    restart: jest.fn(async () => ({ ok: true })),
    remove: jest.fn(async () => ({ ok: true })),
    save: saveSpy,
    test: testSpy,
    inventory: jest.fn(async () => undefined),
    stderrTail: jest.fn(async () => ''),
    // Increment 5 (docs/design/mcp-hosting.md) — agent-authored servers.
    // `ServersPage` fetches this on mount (`refreshAuthoredInfo`), so every
    // test here needs it even when it isn't the one under test.
    listAuthored: jest.fn(async () => ({ servers: [], rejected: [] })),
    rescanAuthored: jest.fn(async () => ({ adopted: [], rejected: [] })),
    approveAuthored: jest.fn(async () => ({ ok: true })),
  };
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  jest.clearAllMocks();
  __resetMcpServerStore();
});

afterAll(() => {
  delete (window as any).mcpServersAPI;
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <ServersPage active onSwitchToChat={jest.fn()} onOpenSettings={jest.fn()} onOpenSchedule={jest.fn()} />,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('ServersPage', () => {
  it('never puts a pid in the status line — only in the mono target line', async () => {
    applyHostedServers([{
      id: 'files', label: 'Files', enabled: true, autostart: false,
      install: { kind: 'custom' }, command: '/usr/bin/node', args: ['server.js'],
      state: 'ready', pid: 41823, toolCount: 3,
    }]);
    await render();

    const statusEls = container.querySelectorAll('.connectorRow__status');
    const targetEls = container.querySelectorAll('.connectorRow__target');
    expect(statusEls.length).toBeGreaterThan(0);
    expect(Array.from(statusEls).some((el) => /pid \d+/.test(el.textContent ?? ''))).toBe(false);
    expect(Array.from(targetEls).some((el) => /pid 41823/.test(el.textContent ?? ''))).toBe(true);
  });

  it('a hosted server that has never started shows no tool count, and its detail says "Never read"', async () => {
    applyHostedServers([{
      id: 'never-started', label: 'Never Started', enabled: true, autostart: false,
      install: { kind: 'custom' }, command: 'node', args: ['s.js'], state: 'stopped',
      // No toolCount at all — "never ready this session".
    }]);
    await render();

    const target = container.querySelector('.connectorRow__target');
    expect(target?.textContent ?? '').not.toMatch(/\d+ tools?/);

    act(() => { findButton('Open').click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(container.textContent).toContain('Never read — the server has not started.');
  });

  it('lists exactly builtinServers(), computed from BASE_AGENT_ALLOWED_TOOLS', async () => {
    await render();
    const expected = builtinServers();
    expect(expected.length).toBeGreaterThan(0); // sanity: the relay list is non-empty

    act(() => { findButton(`Show built into Acabox (${expected.length})`).click(); });

    const rows = container.querySelectorAll('.serversBuiltin .connectorRow');
    expect(rows.length).toBe(expected.length);

    // Every id derivable from BASE_AGENT_ALLOWED_TOOLS' own mcp__<server>__<tool>
    // shape must have produced a row — pins "adding a relay fails here".
    const idsFromAllowlist = new Set(
      BASE_AGENT_ALLOWED_TOOLS
        .map((t) => /^mcp__([a-zA-Z0-9-]+)__/.exec(t)?.[1])
        .filter((x): x is string => !!x),
    );
    expect(new Set(expected.map((e) => e.id))).toEqual(idsFromAllowlist);
  });

  it('omits the mini-app section entirely when the registry is empty', async () => {
    await render();
    expect(container.textContent).not.toContain('Published by your tools');
  });

  it('shows the mini-app section only once a server is published', async () => {
    applyMiniAppServers([{ serverName: 'myTool', dirName: 'myToolDir', tools: [{ name: 't', description: 'd', input_schema: {} }] }]);
    await render();
    expect(container.textContent).toContain('Published by your tools');
    expect(container.textContent).toContain('myToolDir');
  });

  it('the empty state names the real acquisition path — ask Claude, not the form', async () => {
    await render();
    expect(container.textContent).toContain('No servers yet.');
    expect(container.textContent).toContain('Ask Claude to build one for you');
    // The Advanced form is present, but as the SECONDARY link, not the headline.
    expect(container.textContent).toContain('Advanced: add a server yourself');
  });

  it('the disclosure is present before the Save button is enabled', async () => {
    await render();
    act(() => { findButton('Advanced: add a server yourself').click(); });

    expect(container.textContent).toContain('It does not make it safe.');
    const saveBtn = findButton('Add server');
    expect(saveBtn.disabled).toBe(true); // no name/command typed yet
  });

  it('the args editor round-trips a path containing a space — no split(/\\s+/) regression', async () => {
    await render();
    act(() => { findButton('Advanced: add a server yourself').click(); });

    act(() => { typeInto(inputByPlaceholder('filesystem'), 'roundtrip'); });
    act(() => { typeInto(inputByPlaceholder('npx'), '/usr/bin/node'); });

    // First arg row.
    act(() => { typeInto(inputByPlaceholder('-y'), '--root'); });
    // Add a second row and fill it with a path containing a space.
    act(() => { findButton('+ Add argument').click(); });
    const argRows = () => Array.from(container.querySelectorAll('.serversArgRow input')) as HTMLInputElement[];
    act(() => { typeInto(argRows()[1]!, '/Users/i/Dev Folders/X'); });

    const saveBtn = findButton('Add server');
    expect(saveBtn.disabled).toBe(false);
    await act(async () => { saveBtn.click(); await new Promise((r) => setTimeout(r, 0)); });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const draft = saveSpy.mock.calls[0][0];
    expect(draft.args).toEqual(['--root', '/Users/i/Dev Folders/X']);
  });
});

/**
 * Regression for the Increment 5 funnel failure of 2026-09-01. Claude wrote a
 * server, the page said "No servers yet", and the only control that could have
 * found it — "Check for new servers" — was rendered INSIDE the "Authored by
 * Claude" section, which only appears once a server has already been found.
 * A control that requires its own outcome to already have happened is not a
 * control. Both halves of the fix are pinned here.
 */
describe('finding a server Claude just wrote', () => {
  it('scans on arriving at the page — every tab stays mounted, so mount fires only at boot', async () => {
    await render();
    expect((window as any).mcpServersAPI.rescanAuthored).toHaveBeenCalled();
  });

  it('does not scan while the tab is not the visible one', async () => {
    await act(async () => {
      root.render(
        <ServersPage active={false} onSwitchToChat={jest.fn()} onOpenSettings={jest.fn()} onOpenSchedule={jest.fn()} />,
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect((window as any).mcpServersAPI.rescanAuthored).not.toHaveBeenCalled();
  });

  it('offers a manual check from the EMPTY state, where there is no authored section to hide it in', async () => {
    await render();
    const empty = document.querySelector('.serversEmpty');
    expect(empty).toBeTruthy();
    const labels = [...empty!.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels.some((l) => /check now/i.test(l))).toBe(true);
  });

  it('that button really triggers a scan and then re-reads the authored list', async () => {
    await render();
    (window as any).mcpServersAPI.rescanAuthored.mockClear();
    (window as any).mcpServersAPI.listAuthored.mockClear();

    const btn = [...document.querySelectorAll('.serversEmpty button')]
      .find((b) => /check now/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect((window as any).mcpServersAPI.rescanAuthored).toHaveBeenCalled();
    // Re-reading is what makes the row appear without a reload.
    expect((window as any).mcpServersAPI.listAuthored).toHaveBeenCalled();
  });
});
