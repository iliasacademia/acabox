/**
 * Exercises the ACTUAL string injected into mini-app frames, evaluated in a
 * real DOM. A reimplementation of the logic here would keep passing while the
 * shipped shim was broken — and this shim is unusually exposed to that, since
 * it is plain ES5 text that never passes through the build or the typechecker.
 *
 * Each case builds its own JSDOM window, matching the app: `did-frame-navigate`
 * injects into a freshly committed document.
 */
import { TextEncoder, TextDecoder } from 'util';
import { MINI_APP_SELECTION_SHIM } from '../miniAppSelectionShim';
import { MAX_QUOTE_CHARS } from '../../shared/quotes';

if (!(globalThis as any).TextEncoder) (globalThis as any).TextEncoder = TextEncoder;
if (!(globalThis as any).TextDecoder) (globalThis as any).TextDecoder = TextDecoder;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom') as typeof import('jsdom');

interface SelectionMessage {
  type: string;
  selection: { text: string; rect: { top: number; left: number; width: number } } | null;
}

interface Frame {
  window: any;
  posted: SelectionMessage[];
  install: () => unknown;
  /** Stand in for a user selection over the given element's text. */
  select: (selector: string, opts?: { rect?: DOMRect | null }) => void;
  collapse: () => void;
  fire: (type: string) => void;
  flush: () => Promise<void>;
}

function makeFrame(bodyHtml: string): Frame {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'dangerously',
    url: 'http://localhost:3000/tools/demo/index.html',
    pretendToBeVisual: true,
  });
  const posted: SelectionMessage[] = [];
  Object.defineProperty(dom.window, 'parent', {
    configurable: true,
    value: { postMessage: (msg: SelectionMessage) => posted.push(msg) },
  });
  // jsdom has no layout, so a Range reports a zero rect. The shim treats a
  // zero-area rect as "nothing to point at", so give ranges a real one.
  const rect = { top: 120, left: 40, width: 220, height: 18 } as DOMRect;
  dom.window.Range.prototype.getBoundingClientRect = function () { return rect; };

  const setSelection = (node: Node | null, text: string) => {
    const range = new dom.window.Range();
    if (node) range.selectNodeContents(node as any);
    Object.defineProperty(dom.window, 'getSelection', {
      configurable: true,
      value: () => (node
        ? {
          isCollapsed: false,
          anchorNode: node,
          focusNode: node,
          toString: () => text,
          getRangeAt: () => range,
          removeAllRanges: () => { setSelection(null, ''); },
        }
        : { isCollapsed: true, anchorNode: null, focusNode: null, toString: () => '' }),
    });
  };
  setSelection(null, '');

  return {
    window: dom.window,
    posted,
    install: () => dom.window.eval(MINI_APP_SELECTION_SHIM),
    select: (selector) => {
      const el = dom.window.document.querySelector(selector);
      if (!el) throw new Error(`no element for ${selector}`);
      setSelection(el.firstChild ?? el, el.textContent ?? '');
      dom.window.document.dispatchEvent(new dom.window.Event('mouseup', { bubbles: true }));
    },
    collapse: () => {
      setSelection(null, '');
      dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
    },
    fire: (type: string) => {
      dom.window.document.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    },
    // The shim defers its read to a timer (see the module header: rAF is
    // suspended in a hidden page, a timer is not), so draining one macrotask
    // is what lets the report land.
    flush: () => new Promise<void>((r) => dom.window.setTimeout(() => r(), 0)),
  };
}

describe('MINI_APP_SELECTION_SHIM', () => {
  it('reports a selection with its text and frame-relative rect', async () => {
    const f = makeFrame('<p id="p">reverse_complement returned TACCGCAT</p>');
    f.install();

    f.select('#p');
    await f.flush();

    expect(f.posted).toEqual([{
      type: 'quoteSelection',
      selection: {
        text: 'reverse_complement returned TACCGCAT',
        // Viewport-relative to the FRAME. The host offsets it by where the
        // iframe sits before drawing the toolbar.
        rect: { top: 120, left: 40, width: 220 },
      },
    }]);
  });

  it('installs once, so a re-injection cannot double-report', async () => {
    const f = makeFrame('<p id="p">hello</p>');
    expect(f.install()).toBe('installed');
    expect(f.install()).toBe('already-installed');

    f.select('#p');
    await f.flush();

    expect(f.posted).toHaveLength(1);
  });

  it('slices at the cap PLUS ONE so the host can still tell it was truncated', async () => {
    // If the frame pre-sliced to exactly MAX_QUOTE_CHARS, a million-character
    // selection would arrive at the limit and be reported as complete — the
    // app would tell the user and the model it had the whole thing.
    const huge = 'z'.repeat(MAX_QUOTE_CHARS * 2);
    const f = makeFrame(`<p id="p">${huge}</p>`);
    f.install();

    f.select('#p');
    await f.flush();

    const text = f.posted[0].selection!.text;
    expect(text.length).toBe(MAX_QUOTE_CHARS + 1);
    expect(text.length).toBeGreaterThan(MAX_QUOTE_CHARS);
  });

  it('leaves a selection under the cap untouched', async () => {
    const exact = 'q'.repeat(MAX_QUOTE_CHARS);
    const f = makeFrame(`<p id="p">${exact}</p>`);
    f.install();

    f.select('#p');
    await f.flush();

    expect(f.posted[0].selection!.text.length).toBe(MAX_QUOTE_CHARS);
  });

  it('reports a dismissal when the selection collapses', async () => {
    const f = makeFrame('<p id="p">hello</p>');
    f.install();
    f.select('#p');
    await f.flush();
    f.posted.length = 0;

    f.collapse();
    await f.flush();

    expect(f.posted).toEqual([{ type: 'quoteSelection', selection: null }]);
  });

  it('dismisses on scroll inside the frame, which the host cannot see', async () => {
    // The host's own scroll listener never fires for a scroll in a
    // cross-origin frame, so without this the toolbar would sit where the
    // text used to be.
    const f = makeFrame('<p id="p">hello</p>');
    f.install();
    f.select('#p');
    await f.flush();
    f.posted.length = 0;

    f.fire('scroll');

    expect(f.posted).toEqual([{ type: 'quoteSelection', selection: null }]);
  });

  it('refuses a selection inside the tool’s own input', async () => {
    const f = makeFrame('<textarea id="t">a draft the user is typing</textarea>');
    f.install();

    f.select('#t');
    await f.flush();

    expect(f.posted).toEqual([{ type: 'quoteSelection', selection: null }]);
  });

  it('refuses a whitespace-only selection', async () => {
    const f = makeFrame('<p id="p">   </p>');
    f.install();

    f.select('#p');
    await f.flush();

    expect(f.posted).toEqual([{ type: 'quoteSelection', selection: null }]);
  });

  it('clears its own selection when the host says the quote was taken', async () => {
    // A button in the HOST document cannot drop a selection living in this
    // one — removeAllRanges only ever touches its own document. Clearing has
    // to travel back in as a message.
    const f = makeFrame('<p id="p">hello</p>');
    f.install();
    f.select('#p');
    await f.flush();
    expect(f.posted[0].selection).not.toBeNull();
    f.posted.length = 0;

    const event = new f.window.MessageEvent('message', { data: { type: 'clearQuoteSelection' } });
    f.window.dispatchEvent(event);

    expect(f.window.getSelection().isCollapsed).toBe(true);
    expect(f.posted).toEqual([{ type: 'quoteSelection', selection: null }]);
  });

  it('defers on a timer, never on requestAnimationFrame', async () => {
    // rAF is suspended whenever the page is not being rendered, which is
    // exactly when a mini-app frame sits behind an occluded window — the shim
    // would then silently stop offering to quote. Measured against the real
    // app: rAF never fired in the frame or the host while document.hidden was
    // true, and setTimeout fired in both. Asserted on the shipped SOURCE so a
    // well-meaning revert to rAF fails here.
    expect(MINI_APP_SELECTION_SHIM).not.toContain('requestAnimationFrame(');
    expect(MINI_APP_SELECTION_SHIM).toContain('window.setTimeout(');
  });

  it('ignores an unrelated message from the host', async () => {
    const f = makeFrame('<p id="p">hello</p>');
    f.install();
    f.select('#p');
    await f.flush();
    f.posted.length = 0;

    f.window.dispatchEvent(new f.window.MessageEvent('message', { data: { type: 'init' } }));

    expect(f.posted).toEqual([]);
  });
});
