/**
 * The composer's `@` trigger.
 *
 * Its own module, with no `@assistant-ui/react` import, and that is not
 * tidiness: the component that uses it cannot be loaded under Jest at all —
 * importing assistant-ui pulls its ESM source into the runtime and throws
 * before a single case runs. The same constraint that put `dynamicMcp.ts` and
 * `sessionConfig.ts` in their own files. This rule is the whole of the "@"
 * behaviour and is worth pinning, so it lives where it can be.
 */
/**
 * Matches an in-progress `@mention` immediately before the caret.
 *
 * Three properties, each of which a simpler pattern gets wrong:
 *  - `(^|\s)` before the `@`, so an email address does not open a picker.
 *  - the query may contain spaces, because chat titles do and "@dna
 *    sequence" should narrow rather than give up at the space;
 *  - but it may not START with one, so "meet @ 5pm" closes the picker
 *    instead of showing the full chat list next to the word "at".
 */
const AT_TRIGGER = /(^|\s)@([\p{L}\p{N}_-][\p{L}\p{N} _-]{0,39})?$/u;

/**
 * Given the text before the caret, the in-progress `@mention` if there is one.
 *
 * Exported and pure so the rule above can be pinned by tests without driving
 * a textarea: the regex is the whole of the "@" behaviour, and every one of
 * its three properties is a bug someone would otherwise reintroduce.
 */
export function matchAtTrigger(beforeCaret: string): { query: string; atIndex: number } | null {
  const match = AT_TRIGGER.exec(beforeCaret);
  if (!match) return null;
  const query = match[2] ?? '';
  return { query, atIndex: beforeCaret.length - query.length - 1 };
}

