/**
 * Smoke test for the narrow side-panel `<ChatComposer/>` (Phase B design):
 * `▸` glyph + input + send/stop only — attach & model picker live in the
 * docked GlobalComposer, not here.
 *
 * assistant-ui primitives are mocked down to plain elements so the render
 * succeeds in jsdom; the goal is structural assertions, not visual fidelity.
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
      Send: passthrough,
      Cancel: passthrough,
    },
  };
});

jest.mock('../composer-attachments', () => ({
  __esModule: true,
  composerAttachmentComponents: {},
}));

import { ChatComposer } from '../chat-composer';

describe('<ChatComposer/>', () => {
  it('renders the panel composer: glyph, input, send', () => {
    const html = renderToStaticMarkup(<ChatComposer />);
    expect(html).toContain('cdPanelComposer__glyph');
    expect(html).toContain('cdPanelComposer__input');
    expect(html).toContain('cdPanelComposer__send');
  });

  it('uses the default placeholder when none is provided', () => {
    const html = renderToStaticMarkup(<ChatComposer />);
    expect(html).toContain('placeholder="Reply — or ask for the next change"');
  });

  it('honors a custom placeholder', () => {
    const html = renderToStaticMarkup(<ChatComposer placeholder="Reply" />);
    expect(html).toContain('placeholder="Reply"');
  });
});
