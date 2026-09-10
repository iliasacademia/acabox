/**
 * Which surface an excerpt is attributed to.
 *
 * Built against a real DOM rather than a fake ancestor chain, because the
 * behaviours that matter here are DOM behaviours: nesting, `isContentEditable`,
 * and walking `parentElement` off a text node.
 */

import { parseDescriptor, resolveSource } from '../quoteSource';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** The text node inside an element, which is what a real selection anchors to. */
function textNodeIn(selector: string): Node {
  const el = document.querySelector(selector)!;
  const node = el.firstChild;
  if (!node) throw new Error(`no text node in ${selector}`);
  return node;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('resolveSource', () => {
  it('attributes chat prose to its message, reading the role off the same element', () => {
    // Both attributes are already emitted today: `data-message-id` by
    // assistant-ui's MessageRoot, `data-role` by this app's own thread.
    mount('<div data-message-id="m1" data-role="assistant"><p>hello</p></div>');
    expect(resolveSource(textNodeIn('p'))).toEqual({
      key: 'message:m1',
      messageId: 'm1',
      source: { kind: 'message', role: 'assistant' },
    });
  });

  it('reads a user message as a user message', () => {
    mount('<div data-message-id="m2" data-role="user"><p>hi</p></div>');
    expect(resolveSource(textNodeIn('p'))!.source).toEqual({ kind: 'message', role: 'user' });
  });

  it('treats an unmarked role as assistant rather than refusing', () => {
    mount('<div data-message-id="m3"><p>hi</p></div>');
    expect(resolveSource(textNodeIn('p'))!.source).toEqual({ kind: 'message', role: 'assistant' });
  });

  it('lets a tool card inside a message win over the message', () => {
    // The inner claim is the more specific one: quoting a command's output
    // should say so, not blame the reply that happens to contain the card.
    mount(`
      <div data-message-id="m4" data-role="assistant">
        <div data-quote-source="tool:Bash"><pre>exit 127</pre></div>
      </div>`);
    const resolved = resolveSource(textNodeIn('pre'))!;
    expect(resolved.source).toEqual({ kind: 'tool', toolName: 'Bash' });
    // ...while still anchoring to the message it lives in, so the quote keeps
    // something real to point back at.
    expect(resolved.messageId).toBe('m4');
    expect(resolved.key).toBe('tool:Bash');
  });

  it('gives an off-message surface a synthetic anchor', () => {
    // A real spreadsheet cell, wrapped so the parser keeps it: a bare <td>
    // outside a table is dropped, which is a jsdom-faithful HTML rule.
    mount('<div data-quote-source="file:data/counts.csv"><table><tbody><tr><td>39,335</td></tr></tbody></table></div>');
    const resolved = resolveSource(textNodeIn('td'))!;
    expect(resolved.source).toEqual({ kind: 'file', path: 'data/counts.csv' });
    expect(resolved.messageId).toBe('src:file:data/counts.csv');
  });

  it('marks a thinking block as thinking, not as reply prose', () => {
    mount('<div data-message-id="m5" data-quote-source="reasoning"><p>hm</p></div>');
    expect(resolveSource(textNodeIn('p'))!.source).toEqual({ kind: 'message', role: 'reasoning' });
  });

  it('refuses anything inside an editable surface', () => {
    // The composer's own textarea is the case this exists for: offering to
    // quote the sentence you are typing is nonsense.
    mount('<div data-message-id="m6"><textarea>draft</textarea></div>');
    expect(resolveSource(document.querySelector('textarea'))).toBeNull();

    mount('<div data-message-id="m7"><div contenteditable="true"><p>draft</p></div></div>');
    // jsdom does not implement isContentEditable off the attribute, so assert
    // on the property the resolver actually reads.
    const editable = document.querySelector('[contenteditable]') as HTMLElement;
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(resolveSource(textNodeIn('[contenteditable] p'))).toBeNull();
  });

  it('returns null outside any quotable surface', () => {
    mount('<div><p>chrome</p></div>');
    expect(resolveSource(textNodeIn('p'))).toBeNull();
    expect(resolveSource(null)).toBeNull();
  });

  it('gives two different messages different keys, which is what refuses a cross-message drag', () => {
    // The toolbar requires both endpoints to produce the same key. A selection
    // spanning two replies has no single origin, so there is nothing truthful
    // to attribute it to.
    mount(`
      <div data-message-id="a" data-role="assistant"><p id="one">first</p></div>
      <div data-message-id="b" data-role="assistant"><p id="two">second</p></div>`);
    expect(resolveSource(textNodeIn('#one'))!.key)
      .not.toBe(resolveSource(textNodeIn('#two'))!.key);
  });

  it('gives one message the same key from both ends, which is what permits an ordinary drag', () => {
    mount(`
      <div data-message-id="a" data-role="assistant">
        <p id="one">first</p><p id="two">second</p>
      </div>`);
    expect(resolveSource(textNodeIn('#one'))!.key)
      .toBe(resolveSource(textNodeIn('#two'))!.key);
  });
});

describe('parseDescriptor', () => {
  it('parses the three shipped kinds', () => {
    expect(parseDescriptor('file:a/b.csv')).toEqual({ kind: 'file', path: 'a/b.csv' });
    expect(parseDescriptor('tool:Read')).toEqual({ kind: 'tool', toolName: 'Read' });
    expect(parseDescriptor('reasoning')).toEqual({ kind: 'message', role: 'reasoning' });
  });

  it('keeps colons inside a value, so a path or a URL survives', () => {
    expect(parseDescriptor('file:/Users/x/a:b.csv')).toEqual({ kind: 'file', path: '/Users/x/a:b.csv' });
  });

  it('rejects an unknown kind and a valueless one, making that surface simply not quotable', () => {
    // Better than quotable with a label invented from the attribute text.
    expect(parseDescriptor('wormhole:x')).toBeNull();
    expect(parseDescriptor('file:')).toBeNull();
    expect(parseDescriptor('tool')).toBeNull();
    expect(parseDescriptor('')).toBeNull();
  });
});
