/**
 * Renders the real `<DictationButton/>` through React against a fake host.
 *
 * The property that matters most here is the negative one: on a machine where
 * dictation cannot work, the button must be ABSENT rather than present-and-
 * disabled. A permanently dead mic icon in the composer is worse than no icon,
 * and it's only avoidable because the capability probe is prompt-free — so
 * that decision is pinned by a test rather than left to review.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Stand-ins for the assistant-ui primitives. `AuiIf` is given a real
// implementation over a mutable composer state so the idle/live swap is
// actually exercised, not short-circuited to "render everything".
let composerState: { dictation?: unknown } = {};

jest.mock('@assistant-ui/react', () => {
  const React = require('react');
  const button = (label: string) => ({ children, asChild: _a, ...rest }: any) =>
    React.createElement('div', { 'data-primitive': label, ...rest }, children);
  return {
    __esModule: true,
    AuiIf: ({ condition, children }: any) =>
      condition({ composer: composerState })
        ? React.createElement(React.Fragment, null, children)
        : null,
    ComposerPrimitive: {
      Dictate: button('dictate'),
      StopDictation: button('stop-dictation'),
    },
  };
});

jest.mock('../MSymbol', () => ({
  __esModule: true,
  MSymbol: ({ name }: { name: string }) =>
    require('react').createElement('span', { 'data-icon': name }),
}));

import { DictationButton } from '../DictationButton';

type HostEvent = Record<string, unknown>;

function installHost(available: boolean) {
  const listeners = new Set<(e: HostEvent) => void>();
  (window as any).dictationAPI = {
    probe: jest.fn(async () => ({ available, engine: 'transcriber' })),
    start: jest.fn(async () => ({ ok: true })),
    stop: jest.fn(async () => ({ ok: true })),
    onEvent: (cb: (e: HostEvent) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return { emit: (e: HostEvent) => listeners.forEach((l) => l(e)) };
}

describe('<DictationButton/>', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    composerState = {};
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  const mount = async () => {
    await act(async () => { root.render(React.createElement(DictationButton)); });
  };

  it('renders nothing when the host reports dictation unavailable', async () => {
    installHost(false);
    await mount();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing if the probe itself fails', async () => {
    // A broken probe must fail closed. Failing open would show a mic button
    // whose only possible outcome is an error.
    (window as any).dictationAPI = {
      probe: jest.fn(async () => { throw new Error('helper missing'); }),
      onEvent: () => () => {},
    };
    await mount();
    expect(container.innerHTML).toBe('');
  });

  it('renders the mic once the probe reports availability', async () => {
    installHost(true);
    await mount();
    expect(container.querySelector('[data-primitive="dictate"]')).not.toBeNull();
    expect(container.querySelector('[data-primitive="stop-dictation"]')).toBeNull();
    expect(container.querySelector('[data-icon="mic"]')).not.toBeNull();
  });

  it('swaps to the live stop control while dictation is active', async () => {
    installHost(true);
    await mount();

    composerState = { dictation: { status: { type: 'running' } } };
    await act(async () => { root.render(React.createElement(DictationButton)); });

    expect(container.querySelector('[data-primitive="dictate"]')).toBeNull();
    // The primitive is `asChild`, so our own <button> is the styled node —
    // the mock renders the primitive as a wrapper around it.
    const live = container.querySelector('[data-primitive="stop-dictation"] button');
    expect(live).not.toBeNull();
    expect(live!.className).toContain('cdMicBtn--live');
  });

  it('drives the level ring through a CSS variable, not React state on the tree', async () => {
    const host = installHost(true);
    await mount();
    composerState = { dictation: { status: { type: 'running' } } };
    await act(async () => { root.render(React.createElement(DictationButton)); });

    await act(async () => { host.emit({ type: 'level', rms: 0.75 }); });

    const live = container.querySelector('[data-primitive="stop-dictation"] button') as HTMLElement;
    expect(live.style.getPropertyValue('--cdMicLevel')).toBe('0.75');
    expect(live.querySelector('.cdMicBtn__ring')).not.toBeNull();
  });

  it('surfaces a first-run model download as a notice', async () => {
    const host = installHost(true);
    await mount();

    await act(async () => { host.emit({ type: 'installing', locale: 'fr-FR' }); });
    expect(container.textContent).toContain('Downloading the fr-FR speech model');

    // Cleared once recognition actually begins, so the notice can't outlive
    // the condition it describes.
    await act(async () => { host.emit({ type: 'listening' }); });
    expect(container.textContent).not.toContain('Downloading');
  });

  it('shows an error notice and keeps it readable after dictation ends', async () => {
    const host = installHost(true);
    await mount();

    await act(async () => {
      host.emit({ type: 'error', code: 'mic-denied', message: 'Microphone access is off.' });
      host.emit({ type: 'stopped' });
    });

    // A permission error the user must go fix in System Settings must not be
    // wiped by the `stopped` that immediately follows it.
    expect(container.textContent).toContain('Microphone access is off.');
  });
});
