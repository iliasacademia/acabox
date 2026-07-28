/**
 * Script injected into every mini-app frame so that links inside a tool open in
 * the user's default browser, like links everywhere else in Acabox.
 *
 * Two constraints force this shape, both established by testing against the
 * running app rather than inferred:
 *
 *  1. **The host cannot reach into the frame.** A mini-app document is
 *     `local-file://`, while the host renderer is `http://localhost:3000` in
 *     dev and `file://` when packaged. `iframe.contentDocument` is therefore
 *     cross-origin and returns null, so no listener can be attached from
 *     MiniAppViewer. Only the main process can inject, via
 *     `WebFrameMain.executeJavaScript`.
 *
 *  2. **Letting the frame navigate and catching it in main does not work.**
 *     The host CSP is `frame-src local-file: http://localhost:* http://127.0.0.1:*`,
 *     so Chromium refuses a remote frame navigation ("Refused to frame
 *     'https://…' because it violates … frame-src") before Electron emits
 *     `will-frame-navigate`. The guard in externalLinks.ts never sees it, and
 *     without this shim the click silently does nothing at all.
 *
 * The shim routes through the bridge MiniAppViewer already exposes for
 * mini-apps — `postMessage({ type: 'openExternal', id, url })` — which
 * validates `event.source` against its own iframe before calling
 * `shell.openExternal`, so a message from one tool cannot be handled by another.
 *
 * Plain ES5-style source: it is injected as text into a document Acabox does
 * not control and is never passed through the build's transpiler.
 */

import { LOCAL_HOSTNAMES_LIST } from '../../shared/urlTargets';

export const MINI_APP_LINK_SHIM = `(function () {
  if (window.__acaboxLinkShimInstalled) return 'already-installed';
  window.__acaboxLinkShimInstalled = true;
  var LOCAL_HOSTNAMES = ${JSON.stringify([...LOCAL_HOSTNAMES_LIST])};
  var seq = 0;
  document.addEventListener('click', function (event) {
    var target = event.target;
    // Walk up from the click target so a <span> or icon inside the <a> counts.
    var anchor = target && target.closest ? target.closest('a[href]') : null;
    if (!anchor) return;
    var parsed;
    // anchor.href is already resolved to an absolute URL by the browser, so a
    // relative link correctly resolves against local-file: and is left alone.
    try { parsed = new URL(anchor.href); } catch (err) { return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    if (LOCAL_HOSTNAMES.indexOf(parsed.hostname) !== -1) return;
    event.preventDefault();
    seq += 1;
    window.parent.postMessage(
      { type: 'openExternal', id: 'acabox-link-' + seq, url: anchor.href },
      '*'
    );
  }, true);
  return 'installed';
})();`;
