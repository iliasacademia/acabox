/**
 * Smoke test for the shared `<ChatComposer/>` component.
 *
 * Pins the parity contract between desktop and overlay so the composer
 * can't drift back to two divergent implementations:
 *   - The model picker is mounted.
 *   - The attach button is mounted.
 *   - The input + send button are mounted.
 *   - The optional `prefix` slot renders above the input (used by the
 *     overlay's "selected text" pill).
 *   - The placeholder prop overrides the default (overlay "Reply" mode).
 *
 * Both desktop (`window.electronAPI` defined) and overlay (no
 * `electronAPI`) environments must produce the same set of components;
 * the only difference between contexts is the click transports, which
 * are already covered by `doi-link.test.tsx`.
 *
 * We mock the inner UI primitives down to plain `<div>`s with stable
 * sentinels (data-testid="...") so the render succeeds in jsdom without
 * pulling in radix-ui's full Slot/Tooltip/Select machinery — the goal
 * is structural assertions, not visual fidelity.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('../../../setupStore', () => ({
  __esModule: true,
  useSetupState: () => ({ state: 'ready', message: '', percent: 100 }),
  setSetupState: () => {},
}));

jest.mock('@assistant-ui/react', () => {
  const React = require('react');
  const passthrough = ({ children, asChild: _asChild, ...rest }: any) =>
    React.createElement('div', rest, children);
  const passthroughInput = (props: any) => React.createElement('textarea', props);
  return {
    __esModule: true,
    useAuiState: (_selector: any) => false,
    AuiIf: ({ children }: any) => React.createElement(React.Fragment, null, children),
    ComposerPrimitive: {
      Root: passthrough,
      Input: passthroughInput,
      Attachments: () => null,
      AddAttachment: passthrough,
      Send: passthrough,
      Cancel: passthrough,
    },
    useAssistantRuntime: () => ({
      registerModelContextProvider: () => () => {},
    }),
    useComposerRuntime: () => ({
      addAttachment: async () => {},
    }),
  };
});

// Stub the inner UI components flat. The smoke test cares about
// "the composer mounts the model selector + attach button + send +
// input", not about the inner Tooltip/Slot/Select machinery.
jest.mock('../tooltip-icon-button', () => {
  const React = require('react');
  return {
    __esModule: true,
    TooltipIconButton: ({ children, className, ...rest }: any) =>
      React.createElement('button', { className, ...rest }, children),
  };
});
jest.mock('../../ui/button', () => {
  const React = require('react');
  return {
    __esModule: true,
    Button: ({ children, className, ...rest }: any) =>
      React.createElement('button', { className, ...rest }, children),
  };
});
jest.mock('../../ModelSelector', () => {
  const React = require('react');
  return {
    __esModule: true,
    ModelSelector: () =>
      React.createElement('div', { 'data-testid': 'model-selector' }, 'model'),
  };
});
jest.mock('../composer-attachments', () => ({
  __esModule: true,
  composerAttachmentComponents: {},
}));

import { ChatComposer } from '../chat-composer';

function renderInBothContexts(node: React.ReactElement): { desktop: string; overlay: string } {
  // Desktop: electronAPI present (Electron renderer + preload).
  (window as any).electronAPI = { invoke: () => Promise.resolve(null) };
  const desktop = renderToStaticMarkup(node);

  // Overlay: no preload, HTTP-only WKWebView.
  delete (window as any).electronAPI;
  const overlay = renderToStaticMarkup(node);

  return { desktop, overlay };
}

afterEach(() => {
  delete (window as any).electronAPI;
});

describe('<ChatComposer/>', () => {
  it('renders the composer toolbar (input, attach, model picker, send) on both surfaces', () => {
    const { desktop, overlay } = renderInBothContexts(<ChatComposer />);

    for (const [env, html] of [['desktop', desktop], ['overlay', overlay]] as const) {
      expect(html).toContain('composerInput');                            // input
      expect(html).toContain('composerAttach');                           // paperclip
      expect(html).toContain('composerSend');                             // send
      expect(html).toContain('data-testid="model-selector"');             // model picker
      expect(html).toContain('composerRoot');                             // root wrapper
      // Tag the env in the assertion so any future env-specific drift
      // shows up as a clearly-attributed failure.
      expect({ env, hasInput: html.includes('composerInput') }).toEqual({ env, hasInput: true });
    }
  });

  it('renders the prefix slot above the composer shell (overlay selected-text use case)', () => {
    const html = renderToStaticMarkup(
      <ChatComposer prefix={<div data-testid="overlay-pill">"selected" pill</div>} />,
    );
    expect(html).toContain('data-testid="overlay-pill"');
    expect(html.indexOf('overlay-pill')).toBeLessThan(html.indexOf('composerInput'));
  });

  it('uses the default placeholder when none is provided', () => {
    const html = renderToStaticMarkup(<ChatComposer />);
    expect(html).toContain('placeholder="Send a message..."');
  });

  it('honors a custom placeholder (overlay "Reply" mode)', () => {
    const html = renderToStaticMarkup(<ChatComposer placeholder="Reply" />);
    expect(html).toContain('placeholder="Reply"');
    expect(html).not.toContain('Send a message...');
  });
});
