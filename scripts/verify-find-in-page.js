#!/usr/bin/env node
'use strict';

// scripts/verify-find-in-page.js
//
// Pins the Chromium `findInPage` behaviours that the find-in-page design
// (docs/design/find-in-page.md -> "Measured Chromium behaviour") rests on,
// so a future session can re-check them in ~30s instead of re-deriving them
// by hand with a throwaway probe. Six assertions, covering the design doc's
// five measured rows (the "display:none" row splits into a text case and an
// iframe case here):
//
//   1. A word in body text + the same word in an <input value>  -> 2 matches
//      (the reason the find bar is its own WebContentsView, not a component
//      inside the page: a find box in the page would always match itself).
//   2. Text inside display:none                                 -> 0 matches
//   3. An iframe that is itself display:none                    -> 0 matches
//   4. A visible cross-origin iframe (out-of-process, mini-apps) -> 1 match,
//      and the child frame really is a different OS process from the host
//      page's main frame (otherwise the row proves nothing about OOPIFs).
//   5. A WebContentsView overlay's text                         -> invisible
//      to the host page's own find (the host page's count is unaffected).
//   6. <div hidden="until-found"> content                       -> matched,
//      and the `hidden` attribute is gone afterwards -- but only once the
//      window has actually painted a frame, which is why this can't be a
//      Jest test: jsdom never renders anything.
//
// Why this isn't a Jest test: it needs a real, SHOWN Electron window backed
// by real Chromium. jsdom (Jest's default environment) has no find-in-page,
// no out-of-process iframes, and never paints a frame, so assertion 6 could
// never be observed there. This follows the same shape as
// scripts/verify-clear-resume-pointer.sh: a checked-in script for a claim
// Jest structurally cannot host, run by hand or by a future session.
//
// Run:
//   npm run verify:find-in-page
// which is exactly:
//   env -u ELECTRON_RUN_AS_NODE \
//     ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     scripts/verify-find-in-page.js
//
// `env -u ELECTRON_RUN_AS_NODE` matters: if that var leaks in from the
// caller's shell, the Electron binary runs as plain Node and `require
// ('electron')` returns a path string instead of the API -- see CLAUDE.md's
// Conventions section. `--use-mock-keychain` (below) matters too: Chromium's
// own OSCrypt keychain init otherwise blocks on an OS authorization prompt
// for a freshly (ad-hoc) signed binary -- see CLAUDE.md's packaged-build
// hazard entry. Neither is a code change to the shipped app; both are
// measurement-only, scoped to this process.
//
// A window appears briefly while this runs -- expected, not a bug: assertion
// 6 depends on the window actually being shown and painting a frame.

const path = require('path');
const { app, BrowserWindow, WebContentsView, protocol } = require('electron');

app.commandLine.appendSwitch('use-mock-keychain');

const HOST_HTML = path.join(__dirname, 'verify-find-in-page', 'host.html');
const WATCHDOG_MS = 30000;
const REVEAL_SETTLE_MS = 300; // hidden="until-found" reveals ride a rendering frame
const IFRAME_LOAD_SETTLE_MS = 500;

const FIPINPUTWORD = 'FIPINPUTWORD';
const FIPHIDDENTEXT = 'FIPHIDDENTEXT';
const FIPHIDDENIFRAMEWORD = 'FIPHIDDENIFRAMEWORD';
const FIPVISIBLEIFRAMEWORD = 'FIPVISIBLEIFRAMEWORD';
const FIPOVERLAYWORD = 'FIPOVERLAYWORD';
const FIPUNTILFOUND = 'FIPUNTILFOUND';

let exitCode = 0;
const rows = [];

function report(behaviour, expected, got, ok) {
  if (!ok) exitCode = 1;
  rows.push({ behaviour, expected, got, ok });
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status}  ${behaviour} · expected: ${expected} · got: ${got}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves with the `found-in-page` result once Chromium reports
// finalUpdate, then waits a little longer so a hidden="until-found" reveal
// (which rides a rendering frame, not this event) has a chance to happen.
function findOnce(wc, text) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      wc.removeListener('found-in-page', onFound);
      reject(new Error(`findOnce("${text}") never reported finalUpdate`));
    }, 5000);
    function onFound(_event, result) {
      if (!result.finalUpdate) return;
      clearTimeout(timeout);
      wc.removeListener('found-in-page', onFound);
      delay(REVEAL_SETTLE_MS).then(() => resolve(result));
    }
    wc.on('found-in-page', onFound);
    wc.findInPage(text);
  });
}

// Runs a findOnce() call and reports a plain matches===expected row. Used
// for the assertions that need nothing beyond the match count.
async function assertMatchCount(wc, behaviour, text, expectedMatches) {
  let matches;
  try {
    const result = await findOnce(wc, text);
    matches = result.matches;
  } catch (err) {
    report(behaviour, `matches=${expectedMatches}`, `ERROR: ${err.message}`, false);
    return;
  }
  report(behaviour, `matches=${expectedMatches}`, `matches=${matches}`, matches === expectedMatches);
  wc.stopFindInPage('clearSelection');
}

async function main() {
  await app.whenReady();

  // The cross-origin child for assertion 4 (and the display:none one for
  // assertion 3) is served from a custom scheme registered with
  // protocol.handle -- mirroring how this app's own local-file:// scheme is
  // registered (src/cobuilding/main/index.ts), which is the exact mechanism
  // that already gives mini-app iframes an out-of-process, cross-origin
  // frame with zero protocol.registerSchemesAsPrivileged ceremony.
  protocol.handle('probe-app', async (request) => {
    const url = new URL(request.url);
    let word;
    if (url.pathname === '/hidden-child.html') word = FIPHIDDENIFRAMEWORD;
    else if (url.pathname === '/visible-child.html') word = FIPVISIBLEIFRAMEWORD;
    else return new Response('Not Found', { status: 404 });
    const html = `<!doctype html><html><body><p>${word}</p></body></html>`;
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  });

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(HOST_HTML);
  // did-finish-load covers the main frame only; give the two probe-app://
  // child iframes a moment to finish their own (near-instant, in-process-
  // generated) loads before searching them.
  await delay(IFRAME_LOAD_SETTLE_MS);

  const wc = win.webContents;

  // 1. Body text + <input value> -> 2 matches.
  await assertMatchCount(
    wc,
    'word in body text + in an <input value> counts twice',
    FIPINPUTWORD,
    2,
  );

  // 2. display:none text -> 0 matches.
  await assertMatchCount(wc, 'text inside display:none is not matched', FIPHIDDENTEXT, 0);

  // 3. display:none iframe -> 0 matches.
  await assertMatchCount(
    wc,
    'iframe that is itself display:none is not matched',
    FIPHIDDENIFRAMEWORD,
    0,
  );

  // 4. Visible cross-origin iframe -> 1 match, and it runs out-of-process.
  {
    let result;
    try {
      result = await findOnce(wc, FIPVISIBLEIFRAMEWORD);
    } catch (err) {
      report(
        'visible cross-origin iframe matched, and runs out-of-process',
        'matches=1, child frame processId != main frame processId',
        `ERROR: ${err.message}`,
        false,
      );
      result = null;
    }
    if (result) {
      const mainPid = wc.mainFrame.processId;
      const childFrame = wc.mainFrame.framesInSubtree.find(
        (frame) => frame.url && frame.url.includes('visible-child.html'),
      );
      const childPid = childFrame ? childFrame.processId : null;
      const ok = result.matches === 1 && childFrame != null && childPid !== mainPid;
      report(
        'visible cross-origin iframe matched, and runs out-of-process',
        'matches=1, child frame processId != main frame processId',
        `matches=${result.matches}, mainPid=${mainPid}, childPid=${childPid === null ? 'not found' : childPid}`,
        ok,
      );
    }
    wc.stopFindInPage('clearSelection');
  }

  // 5. A WebContentsView overlay's text is invisible to the host page's own
  // find. FIPOVERLAYWORD does not appear anywhere in host.html, so a 0-match
  // search on the host page after mounting the overlay (whose page contains
  // the word twice) shows the host page's count is unaffected by it.
  {
    const overlay = new WebContentsView();
    win.contentView.addChildView(overlay);
    overlay.setBounds({ x: 10, y: 10, width: 200, height: 100 });
    const overlayHtml = `<!doctype html><html><body><p>${FIPOVERLAYWORD} ${FIPOVERLAYWORD}</p></body></html>`;
    await overlay.webContents.loadURL(`data:text/html,${encodeURIComponent(overlayHtml)}`);
    await assertMatchCount(
      wc,
      "text inside a WebContentsView overlay is not matched by the host page's own search",
      FIPOVERLAYWORD,
      0,
    );
    win.contentView.removeChildView(overlay);
  }

  // 6. hidden="until-found" content is matched, and the attribute is removed
  // only once the window has painted a frame with the reveal.
  {
    let result;
    try {
      result = await findOnce(wc, FIPUNTILFOUND);
    } catch (err) {
      report(
        'hidden="until-found" content matched, attribute removed after reveal',
        'matches=1, hidden attribute removed',
        `ERROR: ${err.message}`,
        false,
      );
      result = null;
    }
    if (result) {
      const stillHidden = await wc.executeJavaScript(
        "document.getElementById('until-found-div').hasAttribute('hidden')",
      );
      const ok = result.matches === 1 && stillHidden === false;
      report(
        'hidden="until-found" content matched, attribute removed after reveal',
        'matches=1, hidden attribute removed',
        `matches=${result.matches}, hidden attribute present=${stillHidden}`,
        ok,
      );
    }
    wc.stopFindInPage('clearSelection');
  }

  const passed = rows.filter((r) => r.ok).length;
  console.log(`\n${passed}/${rows.length} assertions passed.`);
}

const watchdog = setTimeout(() => {
  console.error(`verify-find-in-page: watchdog fired after ${WATCHDOG_MS}ms -- something hung`);
  app.exit(2);
}, WATCHDOG_MS);

main()
  .then(() => {
    clearTimeout(watchdog);
    app.exit(exitCode);
  })
  .catch((err) => {
    clearTimeout(watchdog);
    console.error('verify-find-in-page: fatal error', err);
    app.exit(2);
  });
