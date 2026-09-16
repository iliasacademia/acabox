/**
 * Exercises the viewer page's `mountViewer` (V2, `docs/design/sharing-tickets.md`)
 * against a fake `fetchImpl` and a fake `location` — no bundling, no real
 * network, no real Worker. Default jsdom test environment (this file imports
 * `viewer.ts` directly, which imports `./shim.ts`, which is plain
 * TypeScript — nothing here needs the real-bridge-bundling technique
 * `shim.test.ts` uses).
 *
 * `(window as any).__ACABOX_VIEWER_TEST__ = true` is set BEFORE importing the
 * module under test, because `viewer.ts` auto-mounts against the real
 * `document`/`location` at import time unless that flag is set — without it,
 * importing this module under Jest would fire an unmocked `fetch` the moment
 * the file loads, before any test gets to control it.
 */

(window as unknown as { __ACABOX_VIEWER_TEST__?: boolean }).__ACABOX_VIEWER_TEST__ = true;

import { mountViewer } from '../viewer/viewer';
import { versionedBase, type ArtifactMeta } from '../../../cobuilding/shared/share';

const HASH = 'a'.repeat(64);
const ID = 'testshareid1234'; // 15 chars, [a-z0-9] — satisfies isValidShareId
const DIR_NAME = 'dnaToolkit';
const BASE = versionedBase('app', ID, HASH);

const META: ArtifactMeta = {
  id: ID,
  kind: 'app',
  title: 'DNA Toolkit',
  description: null,
  hash: HASH,
  publishedAt: '2026-09-10T12:00:00.000Z',
  entry: `.applications/${DIR_NAME}/src/index.html`,
  dirName: DIR_NAME,
  files: [],
};

function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function waitTicks(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resets the fixed viewer.html structure (banner + frame-host) before every
 * test, so leftover nodes from a previous case's render never leak into the
 * next one's assertions. */
beforeEach(() => {
  document.body.innerHTML = '<header id="banner"></header><main id="frame-host"></main>';
});

describe('mountViewer', () => {
  it('renders the exact unpublished message on a 404', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ error: 'not-found' }, 404));

    await mountViewer(document, { fetchImpl, location: { pathname: `/a/${ID}/` } });

    const frameHost = document.getElementById('frame-host')!;
    expect(frameHost.textContent).toContain('This link has been unpublished.');
    expect(frameHost.querySelector('iframe')).toBeNull();
    expect(frameHost.querySelector('.viewerState__retry')).toBeNull();
  });

  it('renders the could-not-load message with a Retry button on a 500, and Retry re-fetches', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ error: 'internal' }, 500));

    await mountViewer(document, { fetchImpl, location: { pathname: `/a/${ID}/` } });

    const frameHost = document.getElementById('frame-host')!;
    expect(frameHost.textContent).toContain('Could not load this shared tool.');
    const retryButton = frameHost.querySelector<HTMLButtonElement>('.viewerState__retry');
    expect(retryButton).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    retryButton!.click();
    await waitTicks();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('renders the banner and iframe on success', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(META, 200));

    await mountViewer(document, { fetchImpl, location: { pathname: `/a/${ID}/` } });

    const banner = document.getElementById('banner')!;
    expect(banner.textContent).toContain('DNA Toolkit');
    expect(banner.textContent).toContain('read-only snapshot');

    const allLink = banner.querySelector('a');
    expect(allLink).not.toBeNull();
    expect(allLink!.getAttribute('href')).toBe('/');
    expect(allLink!.textContent).toBe('All shared');

    const iframe = document.querySelector('iframe')!;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute('src')).toBe(`${BASE}/${META.entry}`);
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-downloads');

    // Confirms the fetch that loaded meta.json used the right URL and
    // disabled the browser cache, per the ticket's `cache: 'no-store'`
    // requirement.
    expect(fetchImpl).toHaveBeenCalledWith(`/a/${ID}/meta.json`, { cache: 'no-store' });
  });

  it('shows the refusal hint once, and a second refusal does not add a second hint', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(META, 200));

    await mountViewer(document, { fetchImpl, location: { pathname: `/a/${ID}/` } });

    const banner = document.getElementById('banner')!;
    expect(banner.querySelector('.viewerBanner__hint')).toBeNull();

    // Stands in for the app's own bundled bridge posting an unsupported call
    // to its parent — the shim listens on `window` here since no
    // `windowRef` override was given to `mountViewer`.
    window.postMessage({ type: 'executeCommand', id: 'req-1' }, '*');
    await waitTicks();

    const hints = banner.querySelectorAll('.viewerBanner__hint');
    expect(hints).toHaveLength(1);
    expect(hints[0].textContent).toBe('This tool tried to run something; shared copies are read-only.');

    window.postMessage({ type: 'executeCommand', id: 'req-2' }, '*');
    await waitTicks();

    expect(banner.querySelectorAll('.viewerBanner__hint')).toHaveLength(1);
  });

  it('renders the could-not-load state without fetching when the id in the pathname is invalid', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(META, 200));

    // Shaped like `/a/<id>/` but the id itself is too short to satisfy
    // `isValidShareId` (minimum 10 chars) — this must be refused before any
    // network call, not surfaced as a confusing 404 from a fetch that never
    // could have found anything.
    await mountViewer(document, { fetchImpl, location: { pathname: '/a/short/' } });

    const frameHost = document.getElementById('frame-host')!;
    expect(frameHost.textContent).toContain('Could not load this shared tool.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
