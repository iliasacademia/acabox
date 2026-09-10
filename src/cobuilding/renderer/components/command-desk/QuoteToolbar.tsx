import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useComposerRuntime } from '@assistant-ui/react';
import { MSymbol } from './MSymbol';
import {
  prepareQuoteText,
  type AcaboxQuote,
  type QuoteSource,
} from '../../../shared/quotes';
import { resolveSource } from './quoteSource';
import type { QuoteInfo } from '@assistant-ui/react';
import type { FC } from 'react';

/**
 * The floating "Quote" affordance: select text anywhere quotable and a small
 * toolbar appears over the selection; clicking it loads that excerpt into the
 * composer as a chip that rides along with the next message.
 *
 * WHY NOT `SelectionToolbarPrimitive.Root`
 * ---------------------------------------
 * assistant-ui ships one, and for chat prose alone it would do. It resolves a
 * selection by walking up for `data-message-id` and refuses anything without
 * one — which is every surface in this app that is not a chat message: a
 * spreadsheet cell, a file viewer, a mini-app iframe. Rather than mount two
 * toolbars with two behaviours, this one generalizes the lookup to an opt-in
 * `[data-quote-source]` ancestor and keeps `data-message-id` as the fallback,
 * so chat messages need no markup change at all.
 *
 * The event handling below is deliberately the library's, kept line-for-line
 * in spirit because each listener earns its place and the set is not
 * guessable:
 *
 *   - `mouseup` / `keyup` are the two ways a selection is completed. Both are
 *     read on a deferred TIMER, because at event time the browser has not
 *     necessarily finished updating `window.getSelection()`. The library's own
 *     toolbar uses `requestAnimationFrame` for this and that is the one place
 *     this deliberately diverges: rAF is suspended whenever the page is not
 *     being rendered, so an occluded window would stop offering to quote —
 *     measured here, with rAF never firing in either the host page or a
 *     mini-app frame while `document.hidden` was true and `setTimeout`
 *     firing in both. The deferral only has to outlast the selection
 *     settling; it has nothing to do with painting.
 *   - `selectionchange` is watched ONLY to notice a collapse. Using it to
 *     *open* the toolbar would make it flicker across every intermediate
 *     selection during a drag.
 *   - `scroll` is captured (third arg `true`) rather than bubbled, because
 *     scroll does not bubble from the element that actually scrolls — and the
 *     toolbar is positioned in fixed viewport coordinates, so it would
 *     otherwise detach from the text it points at.
 *   - `preventDefault` on the toolbar's own mousedown is what stops clicking
 *     it from collapsing the very selection it is about to quote.
 */

interface SelectionInfo {
  text: string;
  truncated: boolean;
  messageId: string;
  source: QuoteSource;
  rect: { top: number; left: number; width: number };
}

/**
 * Mounted once, near the thread. Renders nothing until there is a selection
 * inside a quotable surface.
 *
 * `enabled` is how the routing rule is expressed: the toolbar is not mounted
 * on Settings or Debug, because those pages have no composer for a quote to
 * land in and a control that cannot do anything is worse than no control.
 */
export const QuoteToolbar: FC<{ enabled?: boolean }> = ({ enabled = true }) => {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const setQuote = useSetQuote();

  useEffect(() => {
    if (!enabled) {
      setInfo(null);
      return;
    }

    const readSelection = () => {
      window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return setInfo(null);

        const prepared = prepareQuoteText(sel.toString());
        if (!prepared) return setInfo(null);

        // Both ends must resolve to the SAME surface. A selection dragged
        // across two replies has no single origin, so there is nothing
        // truthful to attribute it to — the library refuses this too.
        const anchor = resolveSource(sel.anchorNode);
        const focus = resolveSource(sel.focusNode);
        if (!anchor || !focus || anchor.key !== focus.key) return setInfo(null);

        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return setInfo(null);
        setInfo({
          text: prepared.text,
          truncated: prepared.truncated,
          messageId: anchor.messageId,
          source: anchor.source,
          rect: { top: rect.top, left: rect.left, width: rect.width },
        });
      }, 0);
    };

    const handleCollapse = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setInfo(null);
    };
    const dismiss = () => setInfo(null);

    document.addEventListener('mouseup', readSelection);
    document.addEventListener('keyup', readSelection);
    document.addEventListener('selectionchange', handleCollapse);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('mouseup', readSelection);
      document.removeEventListener('keyup', readSelection);
      document.removeEventListener('selectionchange', handleCollapse);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, [enabled]);

  // A selection inside a mini-app iframe cannot be read from here — the frame
  // is `local-file://` and cross-origin. MiniAppViewer relays it, already
  // translated into host viewport coordinates, over this event.
  useEffect(() => {
    if (!enabled) return;
    const onFrameSelection = (e: Event) => {
      const detail = (e as CustomEvent<SelectionInfo | null>).detail;
      setInfo(detail ?? null);
    };
    window.addEventListener('cd:frame-selection', onFrameSelection);
    return () => window.removeEventListener('cd:frame-selection', onFrameSelection);
  }, [enabled]);

  const onQuote = useCallback(() => {
    if (!info) return;
    setQuote({
      text: info.text,
      truncated: info.truncated,
      messageId: info.messageId,
      source: info.source,
    });
    // The frame owns its own selection; ours cannot clear it.
    if (info.source.kind === 'miniapp') {
      window.dispatchEvent(new CustomEvent('cd:clear-frame-selection'));
      window.dispatchEvent(new CustomEvent('cd:expand-tool-panel'));
    } else {
      window.getSelection()?.removeAllRanges();
    }
    setInfo(null);
  }, [info, setQuote]);

  if (!enabled || !info) return null;

  return createPortal(
    <div
      className="cdQuoteToolbar"
      style={{
        top: `${info.rect.top - 8}px`,
        left: `${info.rect.left + info.rect.width / 2}px`,
      }}
      // Without this the click collapses the selection before it is read.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="cdQuoteToolbar__btn" onClick={onQuote}>
        <MSymbol name="format_quote" size={15} />
        Quote
      </button>
    </div>,
    document.body,
  );
};

/**
 * Writes the quote into the thread composer.
 *
 * Goes through the library's own single quote slot rather than a store of our
 * own, which buys three behaviours for free: exactly one quote at a time (a
 * second selection replaces the first), automatic clearing on send, and — the
 * reason that matters most — the quote landing verbatim in the sent message's
 * `metadata.custom.quote`, so the bubble renders it with no extra plumbing.
 * `AcaboxQuote` is wider than the library's `QuoteInfo`; the cast is the whole
 * point and is safe because the value is stored and returned untouched.
 */
function useSetQuote(): (quote: AcaboxQuote) => void {
  const composerRuntime = useComposerRuntime();
  const runtimeRef = useRef(composerRuntime);
  runtimeRef.current = composerRuntime;
  return useCallback((quote: AcaboxQuote) => {
    runtimeRef.current.setQuote(quote as unknown as QuoteInfo);
  }, []);
}
