/**
 * Exercises the actual string injected into mini-app frames by evaluating it
 * in a real DOM — not a reimplementation. A copy of the logic here would keep
 * passing while the shipped shim was broken.
 *
 * Each case builds its own JSDOM window, which is also what happens in the
 * app: `did-frame-navigate` injects into a freshly committed document.
 */
import { TextEncoder, TextDecoder } from 'util';
import { MINI_APP_LINK_SHIM } from '../miniAppLinkShim';

// jsdom's URL parser needs these on globalThis and this suite runs in jest's
// node environment (the module under test is main-process code). Assigned
// before jsdom is required, hence the require rather than a hoisted import.
if (!(globalThis as any).TextEncoder) (globalThis as any).TextEncoder = TextEncoder;
if (!(globalThis as any).TextDecoder) (globalThis as any).TextDecoder = TextDecoder;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom') as typeof import('jsdom');

interface BridgeMessage { type: string; id: string; url: string }

interface Frame {
  window: any;
  document: Document;
  posted: BridgeMessage[];
  install: () => unknown;
  /** Click an element; returns true if the default action survived. */
  click: (selector: string) => boolean;
}

/** A mini-app frame: local content, with the host as its postMessage parent. */
function makeFrame(bodyHtml: string): Frame {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'dangerously',
    // Stands in for the mini-app's own document URL, so relative hrefs resolve
    // to a loopback origin exactly as they do against local-file:.
    url: 'http://localhost:3000/tools/demo/index.html',
  });
  const posted: BridgeMessage[] = [];
  Object.defineProperty(dom.window, 'parent', {
    configurable: true,
    value: { postMessage: (msg: BridgeMessage) => posted.push(msg) },
  });

  return {
    window: dom.window,
    document: dom.window.document,
    posted,
    install: () => dom.window.eval(MINI_APP_LINK_SHIM),
    click: (selector: string) => {
      const el = dom.window.document.querySelector(selector);
      if (!el) throw new Error(`no element for ${selector}`);
      const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return !event.defaultPrevented;
    },
  };
}

describe('MINI_APP_LINK_SHIM', () => {
  it('routes a remote link through the openExternal bridge and cancels navigation', () => {
    const f = makeFrame('<a id="l" href="https://doi.org/10.1038/nature12373">paper</a>');
    f.install();

    const notPrevented = f.click('#l');

    expect(f.posted).toEqual([
      { type: 'openExternal', id: 'acabox-link-1', url: 'https://doi.org/10.1038/nature12373' },
    ]);
    expect(notPrevented).toBe(false);
  });

  it('resolves a click on a nested element up to its anchor', () => {
    const f = makeFrame('<a href="https://arxiv.org/abs/1234.5678"><span id="inner">arXiv</span></a>');
    f.install();

    f.click('#inner');

    expect(f.posted[0]?.url).toBe('https://arxiv.org/abs/1234.5678');
  });

  it("leaves the mini-app's own in-app links alone", () => {
    // Relative and loopback links are how a tool navigates itself; sending
    // them to the browser would break the tool.
    const f = makeFrame(`
      <a id="rel" href="./report.html">report</a>
      <a id="hash" href="#section-2">jump</a>
      <a id="local" href="http://localhost:3000/thing">dev server</a>
      <a id="loop" href="http://127.0.0.1:8080/api">loopback</a>
    `);
    f.install();

    for (const sel of ['#rel', '#hash', '#local', '#loop']) {
      expect(f.click(sel)).toBe(true);
    }
    expect(f.posted).toHaveLength(0);
  });

  it('does not launch OS protocol handlers', () => {
    const f = makeFrame('<a id="m" href="mailto:someone@example.com">mail</a>');
    f.install();

    expect(f.click('#m')).toBe(true);
    expect(f.posted).toHaveLength(0);
  });

  it('ignores clicks that are not on a link', () => {
    const f = makeFrame('<button id="b">run</button>');
    f.install();

    expect(f.click('#b')).toBe(true);
    expect(f.posted).toHaveLength(0);
  });

  it("runs before the mini-app's own handler can stop propagation", () => {
    // Capture phase matters: a tool that calls stopPropagation on its own
    // links would otherwise defeat the shim entirely.
    const f = makeFrame('<a id="l" href="https://example.org/x">x</a>');
    f.install();
    f.document.querySelector('#l')!.addEventListener('click', (e: Event) => e.stopPropagation());

    f.click('#l');

    expect(f.posted[0]?.url).toBe('https://example.org/x');
  });

  it('is idempotent, so re-injection does not double-post', () => {
    // did-frame-navigate can fire more than once against one document.
    const f = makeFrame('<a id="l" href="https://example.org/y">y</a>');
    expect(f.install()).toBe('installed');
    expect(f.install()).toBe('already-installed');

    f.click('#l');

    expect(f.posted).toHaveLength(1);
  });

  it('gives each message a distinct id', () => {
    const f = makeFrame(`
      <a id="a" href="https://example.org/1">1</a>
      <a id="b" href="https://example.org/2">2</a>
    `);
    f.install();

    f.click('#a');
    f.click('#b');

    expect(f.posted.map((p) => p.id)).toEqual(['acabox-link-1', 'acabox-link-2']);
  });
});
