/**
 * Regression tests for the Zotero "+" button next to DOI links.
 *
 * The bug: PR #434 wraps every academic-writing-agent response in
 * `<details class="skill-trace">`, so writing-agent output now goes through
 * the `looksLikeHtml()` branch in markdown-text.tsx. That branch used to
 * call `dangerouslySetInnerHTML`, which renders raw HTML directly into the
 * DOM and silently drops every React component override — including the
 * `<a>` override that decorates DOI links with the Zotero add-to-library
 * button. The fix routes the HTML branch through `html-react-parser` with
 * an `<a>` replacer that uses the same `AnchorWithDoi` component the
 * Markdown path does, so the button works in both rendering paths.
 *
 * These tests pin that behavior so the next time someone re-introduces a
 * dangerouslySetInnerHTML-style shortcut (or otherwise breaks the parser
 * hookup), the regression is caught at CI instead of after a PR #434-style
 * silent regression.
 *
 * The same renderer code is loaded by BOTH the desktop chat panel and the
 * Word overlay (the overlay loads index.html over HTTP), so one rendering
 * test covers both surfaces. We make the desktop-vs-overlay coverage
 * visible by toggling `window.editStatesAPI` between the two contexts —
 * the rendered tree must look identical regardless.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Mock the Electron IPC bridge BEFORE importing doi-link. ZoteroAddRefButton
// subscribes to module-level stores at first render that call
// window.electronAPI.invoke; the mock keeps the static-markup render from
// throwing during hydration.
beforeAll(() => {
  (window as any).electronAPI = {
    invoke: jest.fn().mockResolvedValue(null),
  };
});

afterAll(() => {
  delete (window as any).electronAPI;
});

import { extractDoiFromHref, AnchorWithDoi, parseAgentHtml } from '../doi-link';

describe('extractDoiFromHref', () => {
  it('extracts the DOI from a doi.org URL', () => {
    expect(extractDoiFromHref('https://doi.org/10.1177/0748730405277983'))
      .toBe('10.1177/0748730405277983');
  });

  it('extracts the DOI from a dx.doi.org URL', () => {
    expect(extractDoiFromHref('https://dx.doi.org/10.1101/gad.183500'))
      .toBe('10.1101/gad.183500');
  });

  it('handles http (not just https)', () => {
    expect(extractDoiFromHref('http://doi.org/10.1126/science.1195027'))
      .toBe('10.1126/science.1195027');
  });

  it('returns null for non-DOI URLs', () => {
    expect(extractDoiFromHref('https://example.com/foo')).toBeNull();
    expect(extractDoiFromHref('https://github.com/academia-edu/academia-electron')).toBeNull();
  });

  it('returns null for missing href', () => {
    expect(extractDoiFromHref(undefined)).toBeNull();
    expect(extractDoiFromHref('')).toBeNull();
  });
});

describe('AnchorWithDoi (shared between Markdown and HTML render paths)', () => {
  it('renders the Zotero "+" button next to DOI anchors', () => {
    const html = renderToStaticMarkup(
      <AnchorWithDoi href="https://doi.org/10.1177/0748730405277983">
        10.1177/0748730405277983
      </AnchorWithDoi>,
    );
    expect(html).toContain('docRefInline');
    expect(html).toContain('zoteroAddRefBtn');
    // Original anchor must still be there with the original href so the user
    // can click through to the publisher in addition to adding to Zotero.
    expect(html).toContain('href="https://doi.org/10.1177/0748730405277983"');
  });

  it('does NOT render the Zotero button for non-DOI anchors', () => {
    const html = renderToStaticMarkup(
      <AnchorWithDoi href="https://example.com/foo">example link</AnchorWithDoi>,
    );
    expect(html).not.toContain('docRefInline');
    expect(html).not.toContain('zoteroAddRefBtn');
    expect(html).toContain('href="https://example.com/foo"');
  });

  // hasIPC inside markdown-text.tsx is computed once at module load —
  // editStatesAPI's presence affects the click handlers, not the rendered
  // tree. We assert the visual outcome (button present) is identical in
  // both desktop and overlay environments so a future change can't quietly
  // make the button surface-dependent.
  it('renders the same button structure in the desktop context (editStatesAPI present)', () => {
    (window as any).editStatesAPI = { applyEdit: jest.fn(), setState: jest.fn(), getAll: jest.fn() };
    try {
      const html = renderToStaticMarkup(
        <AnchorWithDoi href="https://doi.org/10.1101/test">test</AnchorWithDoi>,
      );
      expect(html).toContain('zoteroAddRefBtn');
    } finally {
      delete (window as any).editStatesAPI;
    }
  });

  it('renders the same button structure in the overlay context (no editStatesAPI)', () => {
    expect((window as any).editStatesAPI).toBeUndefined();
    const html = renderToStaticMarkup(
      <AnchorWithDoi href="https://doi.org/10.1101/test">test</AnchorWithDoi>,
    );
    expect(html).toContain('zoteroAddRefBtn');
  });
});

describe('parseAgentHtml (the writing-agent skill-trace HTML branch)', () => {
  it('decorates DOI anchors inside an HTML response with the Zotero button', () => {
    // This shape mirrors what the academic-writing-agent skill emits after
    // PR #434: a collapsed <details class="skill-trace"> wrapper plus an
    // <article> body containing DOI links.
    const skillHtml = `
      <details class="skill-trace"><summary>Cite</summary></details>
      <article>
        <p>See
          <a href="https://doi.org/10.1177/0748730405277983">10.1177/0748730405277983</a>
        </p>
      </article>
    `;
    const html = renderToStaticMarkup(<>{parseAgentHtml(skillHtml)}</>);
    expect(html).toContain('docRefInline');
    expect(html).toContain('zoteroAddRefBtn');
    // The skill-trace wrapper must survive sanitization (DOMPurify with
    // ADD_TAGS allowing <details>/<summary>) — this regressed once when an
    // older DOMPurify default profile stripped them.
    expect(html).toContain('skill-trace');
    expect(html).toContain('<summary>Cite</summary>');
  });

  it('handles multiple DOI anchors in one response', () => {
    const html = renderToStaticMarkup(
      <>{parseAgentHtml(`
        <article>
          <p><a href="https://doi.org/10.1101/a">a</a></p>
          <p><a href="https://doi.org/10.1101/b">b</a></p>
          <p><a href="https://doi.org/10.1101/c">c</a></p>
        </article>
      `)}</>,
    );
    const matches = html.match(/zoteroAddRefBtn/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves non-DOI anchors plain in HTML responses', () => {
    const html = renderToStaticMarkup(
      <>{parseAgentHtml('<p>See <a href="https://example.com">example</a></p>')}</>,
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('zoteroAddRefBtn');
  });
});
