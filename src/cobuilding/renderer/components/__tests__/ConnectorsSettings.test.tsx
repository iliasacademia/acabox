import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConnectorsSettings } from '../ConnectorsSettings';

/**
 * Regression coverage for the audited `preserveUntouchedSecrets` data-loss
 * path (`docs/design/mcp-hosting.md`, Increment 3 — "Connectors cleanup").
 * The bug needed BOTH halves fixed to actually disappear: `draftToConnector`
 * omitting `headers` entirely when every row was empty, and
 * `connectorsStore.ts` collapsing an empty result back to `undefined`
 * ("keep stored") regardless of whether the caller meant that or meant
 * "clear". This file pins the renderer half — that a fully-cleared header
 * list is sent as a real `{}`, never an omitted key.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let saveSpy: jest.Mock;

function findButton(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button with text "${text}"`);
  return btn as HTMLButtonElement;
}

beforeAll(() => {
  saveSpy = jest.fn(async (connector: unknown) => ({ success: true, connectors: [connector], pushed: false }));
  (window as any).connectorsAPI = {
    list: jest.fn(async () => ({
      connectors: [{
        id: 'hex', label: 'Hex', transport: 'http', url: 'https://app.hex.tech/mcp',
        headers: { Authorization: '' }, enabled: true,
      }],
      catalog: [],
      unmanaged: null,
    })),
    save: saveSpy,
    remove: jest.fn(),
    setEnabled: jest.fn(),
    getStatus: jest.fn(async () => ({ live: false, reports: [], observedAt: null })),
    removeUnmanaged: jest.fn(),
    onStatusChanged: jest.fn(() => () => {}),
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
});

afterAll(() => {
  delete (window as any).connectorsAPI;
});

async function render(): Promise<void> {
  await act(async () => { root.render(<ConnectorsSettings />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('ConnectorsSettings — header clearing', () => {
  it('sends headers: {} (not an omitted key) when every header row is cleared', async () => {
    await render();

    act(() => { findButton('Edit').click(); });

    // The one existing header row's remove ("−") button — its key/value
    // inputs sit in a `.connectorHeaderRow` alongside it.
    const removeBtn = Array.from(container.querySelectorAll('.connectorHeaderRow button'))
      .find((b) => b.textContent === '−') as HTMLButtonElement;
    act(() => { removeBtn.click(); });

    act(() => { findButton('Save changes').click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const [savedConnector] = saveSpy.mock.calls[0];
    expect(savedConnector.headers).toEqual({});
    expect('headers' in savedConnector).toBe(true); // present, not omitted
  });

  it('the stdio transport option is gone — the picker only offers http/sse', async () => {
    await render();
    act(() => { findButton('Edit').click(); });
    const select = container.querySelector('select.connectorField__input') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['http', 'sse']);
    expect(container.textContent).not.toContain('Local command (stdio)');
  });
});
