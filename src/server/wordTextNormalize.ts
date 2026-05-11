/**
 * Tolerant Unicode normalization for `findAndReplaceInWord`'s Pass 5
 * fallback. AppleScript's literal-byte find can't reconcile the agent's
 * clean ASCII search text against doc text that contains comment-ref
 * glyphs, smart quotes, ligatures, soft hyphens, or other invisible
 * artifacts Word likes to embed inline. Pass 5 captures the doc text,
 * runs both sides through this normalizer, and uses indexOf in
 * normalized space — but to actually do the replace it needs to map
 * back to the original-doc character offsets, which is why every
 * substitution here records the input position(s) it consumed.
 *
 * Lives in its own leaf module (no electron / logger imports) so the
 * unit suite can exercise it without spinning up the rest of the
 * server bundle.
 */

const LIGATURE_EXPANSIONS: Record<number, string> = {
  0xFB00: 'ff', 0xFB01: 'fi', 0xFB02: 'fl', 0xFB03: 'ffi',
  0xFB04: 'ffl', 0xFB05: 'ﬅ', 0xFB06: 'st',
};

/**
 * Normalize a string and return both the normalized output and a map
 * from output index back to original-string index. `map[outIdx]` is the
 * source position that produced output position `outIdx`; `map[out.length]`
 * is the input length so callers can compute exclusive-end offsets.
 *
 * Critical invariant: every output character has exactly one map entry.
 * Multi-output substitutions (a single ligature glyph → "ffi") record
 * the same source index for each output char so a match landing in the
 * middle of the expansion still resolves to a coherent range start.
 */
export function normalizeWithMap(input: string): { out: string; map: number[] } {
  const nfc = input.normalize('NFC');
  const outChars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < nfc.length; i++) {
    const code = nfc.charCodeAt(i);

    // Line endings → \n. CRLF collapses to a single \n with the source
    // index pointing at the CR; the LF is consumed by the loop bump.
    if (code === 0x0D) {
      const next = nfc.charCodeAt(i + 1);
      outChars.push('\n');
      map.push(i);
      if (next === 0x0A) i++;
      continue;
    }
    if (code === 0x0A) { outChars.push('\n'); map.push(i); continue; }
    if (code === 0x0009) { outChars.push('\t'); map.push(i); continue; }

    // Strip invisible chars Word loves to embed inline. The Private Use
    // Area in particular is where Word stores comment-reference markers
    // and other anchor-like glyphs; the agent's search text never
    // contains them so they have to disappear on both sides.
    if (
      (code >= 0x0000 && code <= 0x0008) ||
      code === 0x000B || code === 0x000C ||
      (code >= 0x000E && code <= 0x001F) ||
      code === 0x007F ||
      code === 0x00AD ||                       // soft hyphen
      (code >= 0x200B && code <= 0x200F) ||    // zero-width + LRM/RLM
      (code >= 0x202A && code <= 0x202E) ||    // bidi controls
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xFEFF ||                       // BOM
      (code >= 0xFE00 && code <= 0xFE0F) ||    // variation selectors
      code === 0xFFFC ||                       // object replacement
      code === 0xFFFD ||                       // replacement char
      (code >= 0xE000 && code <= 0xF8FF)       // PUA — Word comment refs etc.
    ) {
      continue;
    }

    if (code === 0x2018 || code === 0x2019) { outChars.push("'"); map.push(i); continue; }
    if (code === 0x201C || code === 0x201D) { outChars.push('"'); map.push(i); continue; }
    if (code === 0x2013 || code === 0x2014 || code === 0x2212) { outChars.push('-'); map.push(i); continue; }
    // U+2000–U+200A: all the various-width spaces (en, em, hair, thin,
    // figure, etc.). Word renders these in justified text; the agent's
    // search has plain spaces, so they all need to fold the same way.
    if (
      code === 0x00A0 ||                   // NBSP
      code === 0x202F ||                   // narrow no-break space
      (code >= 0x2000 && code <= 0x200A)
    ) {
      outChars.push(' '); map.push(i); continue;
    }

    if (code >= 0xFB00 && code <= 0xFB06) {
      const expansion = LIGATURE_EXPANSIONS[code] ?? nfc[i];
      for (const c of expansion) { outChars.push(c); map.push(i); }
      continue;
    }

    outChars.push(nfc[i]);
    map.push(i);
  }
  map.push(nfc.length);
  return { out: outChars.join(''), map };
}
