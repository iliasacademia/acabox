/**
 * Script injected into every mini-app frame so that selecting text inside a
 * tool can be quoted into the chat, like selecting text anywhere else in
 * Acabox.
 *
 * WHY THIS CANNOT BE DONE FROM THE HOST
 * ------------------------------------
 * Same constraint that forced `miniAppLinkShim.ts`, and it is worth restating
 * because it is the whole reason this file exists: a mini-app document is
 * `local-file://` while the host renderer is `http://localhost:3000` in dev and
 * `file://` when packaged. `iframe.contentDocument` is cross-origin and returns
 * null, and `window.getSelection()` in the host reports nothing for a selection
 * living inside the frame. Only the frame itself can see it, and only the main
 * process can inject code into the frame.
 *
 * WHY THE TOOLBAR IS STILL DRAWN BY THE HOST
 * ------------------------------------------
 * The shim reports the selection and its rectangle; MiniAppViewer translates
 * that rectangle into host viewport coordinates and the host renders its own
 * toolbar over the frame. Drawing the button inside the frame would have been
 * less plumbing, but a mini-app carries its own stylesheet — the button would
 * inherit whatever the tool's CSS says about `button`, and the one control that
 * has to look identical everywhere would be the one control that looks
 * different in every tool.
 *
 * THE CONSEQUENCE, WHICH THE PROTOCOL HAS TO CARRY
 * ------------------------------------------------
 * A button in the host document cannot clear a selection in the frame's
 * document — `getSelection().removeAllRanges()` only ever touches its own. So
 * clearing is a message back INTO the frame after the quote is taken.
 * Similarly the frame's internal scrolling is invisible to the host's scroll
 * listener, so the shim reports that too; without it, the toolbar would sit
 * where the text used to be.
 *
 * Plain ES5-style source: it is injected as text into a document Acabox does
 * not control and never passes through the build's transpiler.
 */

import { MAX_QUOTE_CHARS } from '../shared/quotes';

/**
 * The frame slices to the cap PLUS ONE, deliberately.
 *
 * The host is what decides whether an excerpt was truncated, by comparing
 * against `MAX_QUOTE_CHARS`. If the frame pre-sliced to exactly the cap, a
 * selection of a million characters would arrive at exactly the limit and be
 * reported as complete — the app would tell the user and the model it had the
 * whole thing. One extra character preserves the signal in both directions:
 * anything genuinely over the cap still measures over it, and anything under is
 * untouched.
 */
const FRAME_SLICE = MAX_QUOTE_CHARS + 1;

export const MINI_APP_SELECTION_SHIM = `(function () {
  if (window.__acaboxSelectionShimInstalled) return 'already-installed';
  window.__acaboxSelectionShimInstalled = true;
  var SLICE = ${FRAME_SLICE};

  function post(payload) {
    window.parent.postMessage(
      { type: 'quoteSelection', selection: payload },
      '*'
    );
  }

  function inEditable(node) {
    var el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    while (el) {
      var tag = el.tagName;
      if (el.isContentEditable || tag === 'TEXTAREA' || tag === 'INPUT') return true;
      el = el.parentElement;
    }
    return false;
  }

  function read() {
    // Deferred because the selection is not necessarily settled at event time.
    //
    // A TIMER, not requestAnimationFrame — measured, not preferred. rAF is
    // suspended entirely whenever the page is not being rendered
    // (document.hidden is true), which covers an occluded window; a timer still
    // fires. Confirmed here by driving a real local-file frame: rAF never ran
    // in either the frame or the host, while setTimeout ran in both. Nothing
    // about this deferral needs to be aligned to a paint — it only has to
    // land after the selection settles — so the timer is strictly better.
    window.setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) { post(null); return; }
      var text = sel.toString();
      if (!text || !text.trim()) { post(null); return; }
      if (inEditable(sel.anchorNode) || inEditable(sel.focusNode)) { post(null); return; }
      var rect;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (err) { post(null); return; }
      if (!rect || (rect.width === 0 && rect.height === 0)) { post(null); return; }
      post({
        text: text.slice(0, SLICE),
        rect: { top: rect.top, left: rect.left, width: rect.width }
      });
    }, 0);
  }

  function collapseCheck() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) post(null);
  }

  document.addEventListener('mouseup', read);
  document.addEventListener('keyup', read);
  document.addEventListener('selectionchange', collapseCheck);
  // Captured, not bubbled: scroll does not bubble from the element that
  // actually scrolls, and the reported rect is viewport-relative.
  document.addEventListener('scroll', function () { post(null); }, true);
  window.addEventListener('blur', function () { post(null); });

  // The host took the quote. Only this document can drop its own selection.
  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'clearQuoteSelection') {
      var sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      post(null);
    }
  });

  return 'installed';
})();`;
