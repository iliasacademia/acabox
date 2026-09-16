/**
 * @jest-environment node
 *
 * Exercises the real `assets/bridge/bridge.ts` — bundled with the real
 * esbuild and evaluated in a real DOM — rather than a reimplementation.
 * `bridge.ts` is excluded from the tsc project (it ships as source, bundled
 * per-app by the mini-app builder's own esbuild invocation), so a clean
 * `tsc --noEmit` proves nothing about it; this is the check that does.
 *
 * Each case builds its own JSDOM window and bundle-evaluates fresh into it,
 * mirroring how a mini-app's iframe boots: the bridge is the first script it
 * runs, and `_workspacePath` starts empty until the host's `init` message
 * arrives (or never arrives at all, in a published shared snapshot).
 *
 * Forced to the `node` environment (Jest's default for this project is
 * jsdom) rather than the jsdom one: esbuild asserts
 * `new TextEncoder().encode('') instanceof Uint8Array` at load, and under
 * jest-environment-jsdom that fails cross-realm — `TextEncoder` and
 * `Uint8Array` come from different VM contexts there. Node's own globals are
 * one realm, so the assertion holds; `jsdom` is still required explicitly
 * below to build the actual mini-app frame under test.
 */
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom') as typeof import('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const esbuild = require('esbuild') as typeof import('esbuild');

const BRIDGE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'manage-mini-application',
  'assets',
  'bridge',
  'bridge.ts',
);

// Bundle once for the whole suite — esbuild is deterministic for a fixed
// source file and this is the slow part.
const BUNDLE = esbuild.buildSync({
  entryPoints: [BRIDGE_PATH],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
}).outputFiles[0].text;

// `any`, not `Window`, deliberately: `renderer/types.d.ts` declares a global
// ambient `Window.containerAPI` of a completely unrelated shape (the host
// renderer's own preload bridge, named the same as this file's deprecated
// mini-app alias by coincidence) which ts-jest picks up project-wide and
// which would fight any narrower `containerAPI` type here.
type BridgeWindow = any;

/**
 * A fresh mini-app frame with the real bridge bundle evaluated into it.
 * `window.fetch` is stubbed before eval because `error-capture.ts` (imported
 * by `bridge.ts` for its side effects) wraps `window.fetch` at load time —
 * jsdom itself ships no `fetch`, so evaluating the bundle without a stub
 * throws before `hostAPI` is ever assigned.
 */
function makeBridgeWindow(): BridgeWindow {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'dangerously',
    url: 'local-file:///ws/.applications/x/src/index.html',
  });
  (dom.window as any).fetch = () => Promise.resolve({ ok: true, status: 200, statusText: 'OK', url: '' });
  dom.window.eval(BUNDLE);
  return dom.window;
}

function sendInit(win: BridgeWindow, workspacePath: string): void {
  win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'init', workspacePath } }));
}

describe('bridge.ts (real bundle, evaluated in JSDOM)', () => {
  it('keeps the deprecated containerAPI alias pointed at the same object', () => {
    const win = makeBridgeWindow();
    expect(win.hostAPI === win.containerAPI).toBe(true);
  });

  describe('hostAPI.fileUrl', () => {
    it('builds a local-file:// URL from the workspace path sent on init, stripping a leading ./', () => {
      const win = makeBridgeWindow();
      sendInit(win, '/ws');

      expect(win.hostAPI.fileUrl('./.applications/x/output/p.png')).toBe(
        'local-file:///ws/.applications/x/output/p.png',
      );
    });

    it('falls back to a bare / path when no workspace path was sent — the shared-viewer case', () => {
      // M2/D1 context: a published shared snapshot's viewer shim sends
      // `init` with `workspacePath: ''`, which never overwrites the default
      // (the bridge only assigns on a truthy value) — so this also covers
      // "init never arrives at all".
      const win = makeBridgeWindow();
      sendInit(win, '');

      expect(win.hostAPI.fileUrl('.applications/x/output/p.png')).toBe('/.applications/x/output/p.png');
    });

    it('strips a leading ./ in the shared-viewer (no workspace path) case too', () => {
      const win = makeBridgeWindow();
      sendInit(win, '');

      expect(win.hostAPI.fileUrl('./.applications/x/output/p.png')).toBe('/.applications/x/output/p.png');
    });

    it('collapses a leading / on the relative path so callers cannot double it up', () => {
      const win = makeBridgeWindow();
      sendInit(win, '/ws');

      expect(win.hostAPI.fileUrl('/.applications/x/output/p.png')).toBe(
        'local-file:///ws/.applications/x/output/p.png',
      );
    });
  });
});
