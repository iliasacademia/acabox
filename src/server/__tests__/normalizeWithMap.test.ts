/**
 * Pass 5 of `findAndReplaceInWord` runs an indexOf in normalized space and
 * then maps the matched output offsets back to the original doc-text
 * offsets so AppleScript can replace at the right Word range. Get the
 * offset map wrong and the replace lands in the middle of unrelated text.
 *
 * This suite pins the load-bearing invariants — each output index has a
 * map entry, the sentinel is set to input length, every map entry is in
 * bounds — and locks down the substitution behavior for the character
 * classes we know break Word's literal find: PUA / comment refs, smart
 * quotes, dashes, NBSP, ligatures, soft hyphens, line endings.
 */

import { normalizeWithMap } from '../wordTextNormalize';

function assertMapInvariants(input: string, result: { out: string; map: number[] }) {
  expect(result.map.length).toBe(result.out.length + 1);
  for (let i = 0; i < result.out.length; i++) {
    expect(result.map[i]).toBeGreaterThanOrEqual(0);
    expect(result.map[i]).toBeLessThanOrEqual(input.length);
  }
  expect(result.map[result.out.length]).toBe(input.length);
}

describe('normalizeWithMap', () => {
  it('passes plain ASCII through unchanged with identity map', () => {
    const input = 'Hello world';
    const { out, map } = normalizeWithMap(input);
    expect(out).toBe(input);
    for (let i = 0; i < out.length; i++) expect(map[i]).toBe(i);
    assertMapInvariants(input, { out, map });
  });

  it('strips a Word comment-reference PUA char without disturbing surrounding offsets', () => {
    //  is in Word's PUA range — typical of comment anchor refs that
    // appear inline in a paragraph and silently defeat literal find.
    const input = 'Creep is a ubiquitous response';
    const { out, map } = normalizeWithMap(input);
    expect(out).toBe('Creep is a ubiquitous response');
    // The space immediately after the stripped char should map to its
    // original position (after the PUA), not collapse onto the 's'.
    const idxOfSpace = out.indexOf(' a ');
    expect(map[idxOfSpace]).toBe(input.indexOf(' a '));
    assertMapInvariants(input, { out, map });
  });

  it('folds smart quotes, en/em dashes, NBSP, and minus to ASCII', () => {
    const input = '“Hello” – world—end now−one';
    const { out } = normalizeWithMap(input);
    expect(out).toBe('"Hello" - world-end now-one');
  });

  it('expands a multi-char ligature with all output chars pointing at the same source index', () => {
    const input = 'aﬃb'; // a + ﬃ (ffi) + b
    const { out, map } = normalizeWithMap(input);
    expect(out).toBe('affib');
    // Each of the three expanded chars (f, f, i) maps back to the
    // single source position of the ligature glyph.
    expect(map[1]).toBe(1);
    expect(map[2]).toBe(1);
    expect(map[3]).toBe(1);
    expect(map[4]).toBe(2); // 'b' followed the ligature in the source
    assertMapInvariants(input, { out, map });
  });

  it('drops soft hyphens, zero-width joiners, BOM, and variation selectors', () => {
    const input = 'so­ft hy​phen﻿ok️';
    const { out } = normalizeWithMap(input);
    //   (hair space) is one of the spaces we fold to a regular space.
    expect(out).toBe('soft hyphenok');
  });

  it('collapses CRLF to a single \\n with the map pointing at the CR', () => {
    const input = 'line1\r\nline2';
    const { out, map } = normalizeWithMap(input);
    expect(out).toBe('line1\nline2');
    // The newline char in the output sits at index 5; map should point
    // at the CR (index 5 of input), not the LF that followed it.
    expect(map[5]).toBe(5);
    // 'line2' continues at original index 7 (skipping CRLF pair).
    expect(map[6]).toBe(7);
    assertMapInvariants(input, { out, map });
  });

  it('lowercase indexOf can locate a smart-quote phrase against an ASCII search', () => {
    // The end-to-end shape Pass 5 relies on: doc has fancy chars, search
    // has been ASCII-folded, and the indexOf in normalized space lands.
    const docInput = 'Title: “Creep” in polymers';
    const searchInput = '"Creep" in polymers';
    const docNorm = normalizeWithMap(docInput);
    const searchNorm = normalizeWithMap(searchInput);
    const idx = docNorm.out.indexOf(searchNorm.out);
    expect(idx).toBeGreaterThan(-1);
    const startOrig = docNorm.map[idx];
    const endOrig = docNorm.map[idx + searchNorm.out.length];
    // Verify the range slice from the ORIGINAL doc string covers the
    // whole quoted phrase — including the smart quotes — even though we
    // searched for ASCII quotes.
    expect(docInput.slice(startOrig, endOrig)).toBe('“Creep” in polymers');
  });
});
