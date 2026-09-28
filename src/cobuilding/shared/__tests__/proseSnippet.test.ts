/**
 * `proseSnippet` is what a chat-search hit actually shows in the list: the
 * line around the match (or, absent one, the chat's first line), with
 * markdown noise cleaned off. These cases are the spec in
 * docs/design/chat-search.md's Appendix, worked through by hand.
 */

import { proseSnippet } from '../proseSnippet';

describe('proseSnippet', () => {
  it('returns a short matching line cleaned of markdown noise', () => {
    expect(proseSnippet('This is about **KII** results.', 'KII')).toBe('This is about KII results.');
  });

  it('finds a match on the 3rd line and returns only that line', () => {
    const body = 'Line one\nLine two\nThe needle is here\nLine four';
    expect(proseSnippet(body, 'needle')).toBe('The needle is here');
  });

  it('windows a long line around the match, clipping both sides', () => {
    const line = 'A'.repeat(100) + 'NEEDLE' + 'B'.repeat(200);
    const result = proseSnippet(line, 'NEEDLE');
    expect(result.length).toBeLessThanOrEqual(162); // maxChars (160) + 2 ellipses
    expect(result).toContain('NEEDLE');
    expect(result.startsWith('…')).toBe(true);
    expect(result.endsWith('…')).toBe(true);
  });

  // The list shows a hit on one line and ellipsizes it at ~90-100 chars, so a
  // match late in a line that fits in 160 chars was cut off by the ROW. Seen
  // live: "…download the paper PDF directly (same as the dat…".
  it('keeps a late match near the start, even on a line shorter than maxChars', () => {
    const line = "WebFetch approval isn't coming through. Let me instead download the paper PDF directly (same as the dataset) and read it locally.";
    const result = proseSnippet(line, 'dataset');
    expect(result.startsWith('…')).toBe(true);
    expect(result.indexOf('dataset')).toBeLessThanOrEqual(45);
    expect(result.endsWith('read it locally.')).toBe(true);
    // Opens at a word break, not mid-word.
    expect(result).toBe('…the paper PDF directly (same as the dataset) and read it locally.');
  });

  it('leaves a line alone when the match is already near its start', () => {
    const line = 'The dataset is ' + 'x'.repeat(120);
    expect(proseSnippet(line, 'dataset')).toBe(line);
  });

  it('matches case-insensitively', () => {
    expect(proseSnippet('The KII results are great', 'kii')).toBe('The KII results are great');
  });

  it('strips a heading marker and bold emphasis', () => {
    expect(proseSnippet('## **KII** results', 'KII')).toBe('KII results');
  });

  it('turns a table row into an inline list', () => {
    expect(proseSnippet('| GTEx | KII data |', 'KII')).toBe('GTEx · KII data');
  });

  it('strips a markdown link down to its text', () => {
    expect(proseSnippet('[KII](http://x.y)', 'KII')).toBe('KII');
  });

  it('falls back to the first non-empty line when there is no match', () => {
    const body = '\n\nFirst real line\nSecond line';
    expect(proseSnippet(body, 'no such word anywhere')).toBe('First real line');
  });
});
