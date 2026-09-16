import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InstallServerPanel, deriveId } from '../servers/InstallServerPanel';

/**
 * Increment 6 (`docs/design/mcp-hosting.md`) — the install panel.
 *
 * The assertions that matter here are the ones about DISCLOSURE and about
 * what survives a failure, because this is the first path in Acabox that
 * installs a stranger's code. An agent-authored server is something the user
 * watched Claude write; this is not, and the panel has to say so before the
 * button is reachable, not after.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let installMock: jest.Mock;
let logSubscriber: ((evt: { id: string; line: string }) => void) | null = null;

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
function typeInto(el: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function findButton(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}". Have: ${Array.from(container.querySelectorAll('button')).map((b) => b.textContent).join(' | ')}`);
  return btn as HTMLButtonElement;
}
const field = (id: string) => container.querySelector(`#${id}`) as HTMLInputElement;

const onInstalled = jest.fn();
const onCancel = jest.fn();
const onAskClaude = jest.fn();

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  installMock = jest.fn();
  logSubscriber = null;
  onInstalled.mockClear(); onCancel.mockClear(); onAskClaude.mockClear();

  (window as unknown as { mcpServersAPI: unknown }).mcpServersAPI = {
    install: installMock,
    onInstallLog: (cb: (evt: { id: string; line: string }) => void) => {
      logSubscriber = cb;
      return () => { logSubscriber = null; };
    },
  };

  await act(async () => {
    root.render(
      <InstallServerPanel
        existingIds={['taken']}
        onInstalled={onInstalled}
        onCancel={onCancel}
        onAskClaude={onAskClaude}
      />,
    );
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete (window as unknown as { mcpServersAPI?: unknown }).mcpServersAPI;
});

describe('deriveId', () => {
  it('takes the SHORT name of a scoped package, not the scope', () => {
    // Taking the scope would give every package a vendor publishes the same
    // id, and the id is what the model types as `mcp__<id>__<tool>`.
    expect(deriveId('@modelcontextprotocol/server-filesystem')).toBe('server-filesystem');
  });

  it('handles a bare package, a repo URL and a .git suffix', () => {
    expect(deriveId('some-server')).toBe('some-server');
    expect(deriveId('https://github.com/owner/my-repo')).toBe('my-repo');
    expect(deriveId('https://github.com/owner/my-repo.git')).toBe('my-repo');
    expect(deriveId('https://github.com/owner/my-repo/')).toBe('my-repo');
  });

  it('produces only characters an id may contain', () => {
    for (const raw of ['Weird Name!!', 'UPPER_CASE', '@a/b c d', '---x---']) {
      expect(deriveId(raw)).toMatch(/^[a-z0-9-]*$/);
      expect(deriveId(raw)).not.toMatch(/^-|-$/);
    }
  });
});

describe('before anything is installed', () => {
  it('shows the disclosure, and it names whose code this is', () => {
    const text = container.textContent ?? '';
    expect(text).toMatch(/someone else’s program/i);
    expect(text).toMatch(/without asking you first/i);
    // The honest sentence, kept verbatim from the design doc.
    expect(text).toMatch(/does not make it safe/i);
    expect(text).toMatch(/stays off until you turn it on/i);
  });

  it('cannot install with no package name', () => {
    expect(findButton('Install').disabled).toBe(true);
  });

  it('enables Install once a package is named, and suggests an id', async () => {
    await act(async () => { typeInto(field('inst-pkg'), '@scope/server-x'); });
    expect(field('inst-id').value).toBe('server-x');
    expect(findButton('Install').disabled).toBe(false);
  });

  it('refuses an id that is already taken, before any network call', async () => {
    await act(async () => { typeInto(field('inst-pkg'), 'whatever'); });
    await act(async () => { typeInto(field('inst-id'), 'taken'); });
    expect(findButton('Install').disabled).toBe(true);
    expect(container.textContent).toMatch(/already exists/i);
    expect(installMock).not.toHaveBeenCalled();
  });

  it('offers no Copy log / Ask Claude until something has actually failed', () => {
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).not.toContain('Copy log');
    expect(labels).not.toContain('Ask Claude to fix this');
  });
});

describe('a failed install', () => {
  it('keeps the log, and hands its tail to Claude', async () => {
    installMock.mockImplementation(async () => {
      logSubscriber?.({ id: 'server-x', line: 'npm ERR! code E404' });
      logSubscriber?.({ id: 'server-x', line: 'npm ERR! 404 Not Found' });
      return { ok: false, error: 'npm has no package by that name.' };
    });

    await act(async () => { typeInto(field('inst-pkg'), 'server-x'); });
    await act(async () => { findButton('Install').click(); });

    expect(container.textContent).toMatch(/no package by that name/);
    // The log is the only evidence there is — losing it on failure is what
    // makes "it didn't work" unactionable.
    expect(container.querySelector('.serversInstall__log')?.textContent).toMatch(/E404/);

    await act(async () => { findButton('Ask Claude to fix this').click(); });
    const prompt = onAskClaude.mock.calls[0][0] as string;
    expect(prompt).toMatch(/E404/);
    expect(prompt).toMatch(/npm has no package by that name/);
  });

  it('does not report success to the page', async () => {
    installMock.mockResolvedValue({ ok: false, error: 'nope' });
    await act(async () => { typeInto(field('inst-pkg'), 'server-x'); });
    await act(async () => { findButton('Install').click(); });
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('surfaces a thrown IPC error rather than hanging on "Installing…"', async () => {
    installMock.mockRejectedValue(new Error('IPC exploded'));
    await act(async () => { typeInto(field('inst-pkg'), 'server-x'); });
    await act(async () => { findButton('Install').click(); });
    expect(container.textContent).toMatch(/IPC exploded/);
    expect(findButton('Install').disabled).toBe(false);
  });
});

describe('a successful install', () => {
  it('says it is off, and does not pretend it is running', async () => {
    installMock.mockResolvedValue({ ok: true, id: 'server-x', toolCount: 3, toolNames: ['a', 'b', 'c'] });
    await act(async () => { typeInto(field('inst-pkg'), 'server-x'); });
    await act(async () => { findButton('Install').click(); });

    expect(onInstalled).toHaveBeenCalledWith('server-x', 3);
    expect(container.textContent).toMatch(/offers 3 tools/i);
    expect(container.textContent).toMatch(/Turn it on/i);
    // Nothing on this panel may claim the server is available.
    expect(container.textContent).not.toMatch(/\bAvailable\b/);
  });

  it('passes the version through only when one was typed', async () => {
    installMock.mockResolvedValue({ ok: true, id: 'server-x', toolCount: 1, toolNames: ['a'] });
    await act(async () => { typeInto(field('inst-pkg'), 'server-x'); });
    await act(async () => { findButton('Install').click(); });
    expect(installMock.mock.calls[0][0].source).toEqual({ kind: 'npm', pkg: 'server-x', version: undefined });
  });
});
