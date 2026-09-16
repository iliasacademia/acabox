import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SharingSettings } from '../SharingSettings';

/**
 * Settings → Sharing (`docs/design/sharing-tickets.md`, ticket U2). The
 * token itself never crosses IPC — `getSettings()` only ever returns
 * `hasToken` — so these tests never assert on a token VALUE, only on
 * whether the field is empty and on what `saveSettings` was called with.
 */

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

function findField(labelText: string): HTMLInputElement {
  const fields = Array.from(container.querySelectorAll('.connectorField'));
  const field = fields.find((f) => f.querySelector('.connectorField__label')?.textContent === labelText);
  if (!field) throw new Error(`No field labelled "${labelText}"`);
  return field.querySelector('input') as HTMLInputElement;
}

const SAVED_SITE_URL = 'https://acabox-share.acct.workers.dev';
const SAVED_API_URL = 'https://acabox-share-api.acct.workers.dev';

let getSettingsMock: jest.Mock;
let saveSettingsMock: jest.Mock;
let testMock: jest.Mock;

function installShareAPI(overrides: { hasToken?: boolean } = {}): void {
  getSettingsMock = jest.fn(async () => ({
    siteUrl: SAVED_SITE_URL,
    apiUrl: SAVED_API_URL,
    hasToken: overrides.hasToken ?? true,
  }));
  saveSettingsMock = jest.fn(async () => ({ ok: true }));
  testMock = jest.fn(async () => ({ ok: true, status: 200, error: null }));
  (window as any).shareAPI = {
    getSettings: getSettingsMock,
    saveSettings: saveSettingsMock,
    test: testMock,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  installShareAPI();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  delete (window as any).shareAPI;
  jest.clearAllMocks();
});

async function render(): Promise<void> {
  await act(async () => { root.render(<SharingSettings />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('SharingSettings', () => {
  it('renders the saved Site URL and API URL from getSettings, with a blank token field', async () => {
    await render();
    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    expect(findField('Site URL').value).toBe(SAVED_SITE_URL);
    expect(findField('API URL').value).toBe(SAVED_API_URL);
    expect(findField('Publish token').value).toBe('');
  });

  it('disables Save until something changes', async () => {
    await render();
    expect(findButton('Save').disabled).toBe(true);

    act(() => { typeInto(findField('Site URL'), 'https://new-site.workers.dev'); });
    expect(findButton('Save').disabled).toBe(false);
  });

  it('Save omits publishToken when the field is blank', async () => {
    await render();
    act(() => { typeInto(findField('API URL'), 'https://new-api.workers.dev'); });

    act(() => { findButton('Save').click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    const [patch] = saveSettingsMock.mock.calls[0];
    expect(patch).toEqual({ siteUrl: SAVED_SITE_URL, apiUrl: 'https://new-api.workers.dev' });
    expect('publishToken' in patch).toBe(false);
  });

  it('Save includes publishToken when the field is typed', async () => {
    await render();
    act(() => { typeInto(findField('Publish token'), 'a-fresh-token'); });

    act(() => { findButton('Save').click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    const [patch] = saveSettingsMock.mock.calls[0];
    expect(patch.publishToken).toBe('a-fresh-token');
  });

  it('Clear token sends clearToken: true', async () => {
    await render();
    act(() => { findButton('Clear token').click(); });
    expect(findButton('Save').disabled).toBe(false);

    act(() => { findButton('Save').click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    const [patch] = saveSettingsMock.mock.calls[0];
    expect(patch.clearToken).toBe(true);
    expect('publishToken' in patch).toBe(false);
  });

  it('the token input never has a non-empty value after a save', async () => {
    await render();
    act(() => { typeInto(findField('Publish token'), 'a-fresh-token'); });
    expect(findField('Publish token').value).toBe('a-fresh-token');

    act(() => { findButton('Save').click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(findField('Publish token').value).toBe('');
  });

  it('Test renders the returned error text', async () => {
    testMock.mockResolvedValueOnce({ ok: false, status: 503, error: 'Service unavailable' });
    await render();

    act(() => { findButton('Test').click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(testMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('HTTP 503: Service unavailable');
  });

  it('Test renders "Connected" on success', async () => {
    await render();
    act(() => { findButton('Test').click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.textContent).toContain('Connected');
  });

  it('disables Test until a token is stored', async () => {
    installShareAPI({ hasToken: false });
    await render();
    expect(findButton('Test').disabled).toBe(true);
    // No "Clear token" affordance either — there is nothing stored to clear.
    expect(() => findButton('Clear token')).toThrow();
  });

  it('never renders the token value itself, only a placeholder standing in for it', async () => {
    await render();
    const field = findField('Publish token');
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('••••••••');
  });
});
