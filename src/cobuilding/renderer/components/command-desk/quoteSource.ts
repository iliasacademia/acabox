/**
 * Resolving a DOM node to the surface a quote came from.
 *
 * Split out of `QuoteToolbar` because this is the part that decides what the
 * user is told and what the agent is told about an excerpt's origin, and it is
 * pure — it takes a node and returns a descriptor. Keeping it here means it can
 * be tested against a real DOM without mounting the toolbar, a composer, or an
 * assistant runtime.
 */

import type { QuoteSource } from '../../../shared/quotes';

/** Attribute a host surface sets to opt into quoting: `kind:value`. */
export const SOURCE_ATTR = 'data-quote-source';

export interface ResolvedSource {
  /**
   * Identity of the surface. Both ends of a selection must produce the same
   * key or the selection is refused — see `resolveSource`.
   */
  key: string;
  /** What the quote anchors to; a synthetic `src:…` token off-message. */
  messageId: string;
  source: QuoteSource;
}

/**
 * Descriptors are `kind:value` strings so a surface declares itself with one
 * static attribute and no wiring. An unrecognised kind resolves to null, which
 * makes that surface simply not quotable — strictly better than quotable with
 * a label invented from the attribute text.
 */
export function parseDescriptor(descriptor: string): QuoteSource | null {
  const sep = descriptor.indexOf(':');
  const kind = sep === -1 ? descriptor : descriptor.slice(0, sep);
  const value = sep === -1 ? '' : descriptor.slice(sep + 1);
  switch (kind) {
    case 'file':
      return value ? { kind: 'file', path: value } : null;
    case 'tool':
      return value ? { kind: 'tool', toolName: value } : null;
    case 'reasoning':
      return { kind: 'message', role: 'reasoning' };
    default:
      return null;
  }
}

function findMessageId(from: HTMLElement | null): string {
  let el = from;
  while (el) {
    const id = el.getAttribute('data-message-id');
    if (id) return id;
    el = el.parentElement;
  }
  return '';
}

/**
 * Walk up from a selection endpoint to the surface that owns it.
 *
 * Three rules, each deliberate:
 *
 *  1. **An editable ancestor makes the node unquotable.** The composer's own
 *     textarea is the case that matters — offering to quote the sentence you
 *     are in the middle of typing is nonsense.
 *  2. **`data-quote-source` beats `data-message-id`.** A tool card lives inside
 *     an assistant message, so both are in the ancestor chain; the inner, more
 *     specific claim is the true one, and quoting a command's output should say
 *     so rather than blaming the surrounding reply.
 *  3. **A surface inside a message still anchors to that message**, so the
 *     quote keeps a real id to point back at even when its label is the tool's.
 */
export function resolveSource(node: Node | null): ResolvedSource | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : ((node?.parentElement as HTMLElement | null) ?? null);

  while (el) {
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return null;

    const descriptor = el.getAttribute(SOURCE_ATTR);
    if (descriptor) {
      const source = parseDescriptor(descriptor);
      if (source) {
        return {
          key: descriptor,
          messageId: findMessageId(el) || `src:${descriptor}`,
          source,
        };
      }
    }

    const id = el.getAttribute('data-message-id');
    if (id) {
      const role = el.getAttribute('data-role') === 'user' ? 'user' : 'assistant';
      return { key: `message:${id}`, messageId: id, source: { kind: 'message', role } };
    }

    el = el.parentElement;
  }
  return null;
}
