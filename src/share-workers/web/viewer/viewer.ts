/**
 * Viewer page (V2) — the page a visitor lands on at `/a/<id>/`. It fetches
 * the artifact's metadata, then either shows one of two failure states or
 * renders the banner + sandboxed iframe that hosts the published mini-app,
 * wiring the viewer shim (V1, `./shim.ts`) onto it so the app's own bundled
 * bridge (`assets/bridge/bridge.ts`) gets read-only answers instead of
 * talking to a real Acabox host.
 *
 * Design: `docs/design/sharing.md`. Contracts: `docs/design/sharing-tickets.md`
 * (this file implements the V2 ticket; see C1, C5).
 *
 * BROWSER-ONLY MODULE. No Node imports, no `Buffer` — bundled by
 * `share-workers/package.json`'s `build:viewer` script into
 * `web/public/viewer.js` and served as a static asset by the `acabox-share`
 * Worker (C5), so it runs in an arbitrary visitor's browser.
 */

import { isValidShareId, versionedBase, type ArtifactMeta } from '../../../cobuilding/shared/share';
import { installShim, sendInit } from './shim';

export interface MountViewerOptions {
  fetchImpl?: typeof fetch;
  location?: { pathname: string };
  /** Overrides the window the shim listens on / posts init into. Defaults to
   * `root`'s own `defaultView`, or the ambient `window` if that's null (a
   * `Document` created via `createHTMLDocument()` has no `defaultView`). */
  windowRef?: Window;
}

const UNPUBLISHED_MESSAGE = 'This link has been unpublished.';
const LOAD_FAILURE_MESSAGE = 'Could not load this shared tool.';
const REFUSED_HINT_MESSAGE = 'This tool tried to run something; shared copies are read-only.';

/** `/a/<id>/` exactly — a trailing-slash id, one path segment, nothing else. */
const PATHNAME_PATTERN = /^\/a\/([^/]+)\/$/;

/**
 * Parses the share id out of a pathname shaped like `/a/<id>/`. Returns null
 * for anything that doesn't match that shape at all, and also for an id that
 * matches the shape but fails `isValidShareId` — both are "can't load this",
 * and neither should attempt a fetch (a malformed id can't possibly name a
 * real artifact, so asking the network is pointless and would just surface a
 * confusing 404 for something that was never valid to begin with).
 */
function parseShareId(pathname: string): string | null {
  const match = PATHNAME_PATTERN.exec(pathname);
  if (!match) return null;
  const id = match[1];
  return isValidShareId(id) ? id : null;
}

/** Removes every child of `el` — used before re-rendering a container so a
 * Retry or a re-mount in a test never leaves stale nodes behind. */
function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Picks the `fetch` implementation to use, in order: an explicit override
 * (tests), the resolved host window's own `fetch` (real usage), then the
 * ambient global as a last resort. The `typeof fetch !== 'undefined'` guard
 * matters: referencing a bare identifier that isn't declared anywhere throws
 * a `ReferenceError`, and `hostWindow` can be null (a `Document` with no
 * `defaultView`, no `windowRef` override, and no ambient `window` either) —
 * `typeof` is the one way to ask "does this exist" without risking that.
 */
function resolveFetch(hostWindow: Window | null, explicit?: typeof fetch): typeof fetch {
  if (explicit) return explicit;
  if (hostWindow) return hostWindow.fetch.bind(hostWindow) as typeof fetch;
  if (typeof fetch !== 'undefined') return fetch;
  return (async () => {
    throw new Error('No fetch implementation available in this environment.');
  }) as typeof fetch;
}

function formatPublishedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString();
}

/**
 * Tracks the previous mount's teardown (the shim's uninstall + the iframe's
 * `load` listener) so mounting again — a Retry click, or a second call in a
 * test — never leaves an old `message` listener running alongside a new one.
 * Module-level rather than a return value because `mountViewer`'s own return
 * type is fixed by the ticket (`Promise<void>`) and the auto-mount at the
 * bottom of this file has nothing to hold a per-call handle for it anyway.
 */
let activeTeardown: (() => void) | null = null;

function teardownActive(): void {
  if (activeTeardown) {
    activeTeardown();
    activeTeardown = null;
  }
}

/**
 * Renders one of the two failure states into `#frame-host`, with the banner
 * left empty — there is no title or publish date to show when the fetch
 * itself is what failed. `retry`, when given, adds a button that re-runs
 * `mountViewer` with the same arguments.
 */
function renderFailure(root: Document, message: string, retry?: () => void): void {
  const banner = root.getElementById('banner');
  const frameHost = root.getElementById('frame-host');
  if (banner) clearChildren(banner);
  if (!frameHost) return;
  clearChildren(frameHost);

  const wrap = root.createElement('div');
  wrap.className = 'viewerState';

  const text = root.createElement('p');
  text.className = 'viewerState__message';
  text.textContent = message;
  wrap.appendChild(text);

  if (retry) {
    const button = root.createElement('button');
    button.type = 'button';
    button.className = 'viewerState__retry';
    button.textContent = 'Retry';
    button.addEventListener('click', () => {
      retry();
    });
    wrap.appendChild(button);
  }

  frameHost.appendChild(wrap);
}

/**
 * Renders the banner + sandboxed iframe for a successfully-fetched
 * `ArtifactMeta`, and wires the shim onto the iframe so the app's own
 * bundled bridge gets answered. Every piece of dynamic text goes through
 * `textContent`, never `innerHTML` — a title or description came from
 * whatever the publishing user typed and must not be interpreted as markup.
 */
function renderSuccess(root: Document, meta: ArtifactMeta, hostWindow: Window, doFetch: typeof fetch): void {
  const banner = root.getElementById('banner');
  const frameHost = root.getElementById('frame-host');
  if (!banner || !frameHost) return;
  clearChildren(banner);
  clearChildren(frameHost);

  const row = root.createElement('div');
  row.className = 'viewerBanner__row';

  const metaLine = root.createElement('span');
  metaLine.className = 'viewerBanner__meta';
  metaLine.textContent =
    `${meta.title} · Shared from Acabox · read-only snapshot · published ${formatPublishedDate(meta.publishedAt)}`;
  row.appendChild(metaLine);

  const allLink = root.createElement('a');
  allLink.className = 'viewerBanner__all';
  allLink.href = '/';
  allLink.textContent = 'All shared';
  row.appendChild(allLink);

  banner.appendChild(row);

  // Shown at most once per mount, no matter how many calls the app makes
  // that the shim has to refuse — a chatty (or malicious) app trying the
  // same unsupported call in a loop must not fill the banner with copies of
  // the same sentence.
  let hintShown = false;
  function showHintOnce(): void {
    if (hintShown) return;
    hintShown = true;
    const hint = root.createElement('div');
    hint.className = 'viewerBanner__hint';
    hint.textContent = REFUSED_HINT_MESSAGE;
    banner!.appendChild(hint);
  }

  const base = versionedBase('app', meta.id, meta.hash);
  const iframe = root.createElement('iframe');
  iframe.className = 'viewerFrame';
  // `allow-same-origin` is safe here specifically because the snapshot is
  // served same-origin with the viewer itself — there is no credentialed
  // parent origin for it to reach into. `allow-downloads` is what lets an
  // app's own "export a file" button (the shim's `downloadFile` handler)
  // actually save anything.
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads');
  iframe.src = `${base}/${meta.entry}`;
  frameHost.appendChild(iframe);

  const uninstallShim = installShim({
    meta,
    base,
    hostWindow,
    frameWindow: () => iframe.contentWindow,
    fetchImpl: doFetch,
    onRefused: () => showHintOnce(),
  });

  const onLoad = (): void => {
    const frame = iframe.contentWindow;
    if (frame) sendInit(frame);
  };
  iframe.addEventListener('load', onLoad);

  activeTeardown = () => {
    iframe.removeEventListener('load', onLoad);
    uninstallShim();
  };
}

/**
 * Mounts the viewer into `root` (in practice, always `document`). Exported
 * so the test suite can drive it directly against a fake `fetchImpl` and a
 * fake `location`, with no bundling and no real network — see
 * `__tests__/viewer.test.ts`.
 */
export async function mountViewer(root: Document, opts: MountViewerOptions = {}): Promise<void> {
  teardownActive();

  const hostWindow = opts.windowRef ?? root.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const pathname = opts.location?.pathname ?? hostWindow?.location.pathname ?? '';
  const doFetch = resolveFetch(hostWindow, opts.fetchImpl);

  const id = parseShareId(pathname);
  if (!id || !hostWindow) {
    // No id worth asking about (or nowhere to host the iframe even if we
    // had one) — render the generic failure with no Retry, since retrying a
    // fetch was never going to help a URL that was never valid.
    renderFailure(root, LOAD_FAILURE_MESSAGE);
    return;
  }

  const retry = (): void => {
    void mountViewer(root, opts);
  };

  let response: Response;
  try {
    response = await doFetch(`/a/${id}/meta.json`, { cache: 'no-store' });
  } catch {
    renderFailure(root, LOAD_FAILURE_MESSAGE, retry);
    return;
  }

  if (response.status === 404) {
    renderFailure(root, UNPUBLISHED_MESSAGE);
    return;
  }
  if (!response.ok) {
    renderFailure(root, LOAD_FAILURE_MESSAGE, retry);
    return;
  }

  let meta: ArtifactMeta;
  try {
    meta = (await response.json()) as ArtifactMeta;
  } catch {
    renderFailure(root, LOAD_FAILURE_MESSAGE, retry);
    return;
  }

  renderSuccess(root, meta, hostWindow, doFetch);
}

// Auto-mount in a real browser. `__ACABOX_VIEWER_TEST__` is set by the test
// suite before importing this module, specifically to suppress this — without
// it, importing the module under Jest would immediately fetch against the
// real jsdom `document`/`location` before a test ever calls `mountViewer`
// itself.
if (typeof window !== 'undefined' && !(window as unknown as { __ACABOX_VIEWER_TEST__?: boolean }).__ACABOX_VIEWER_TEST__) {
  void mountViewer(document);
}
