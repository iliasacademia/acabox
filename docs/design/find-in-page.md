# Find in page (⌘F) — design and implementation tickets

> **Orchestration model:** Fable reads, plans, reviews and verifies; each
> ticket below is dispatched to a **Sonnet 5** subagent that implements only
> that ticket. A ticket is sized so one agent finishes it in one sitting with
> no design decisions left to make. If a ticket turns out to need a decision,
> the implementer stops and reports instead of guessing.
>
> Written 2026-09-15. Status column is maintained by the orchestrator.
>
> | # | Ticket | Depends on | Runs in | Status |
> |---|---|---|---|---|
> | C0 | Shared contract `src/cobuilding/shared/findInPage.ts` | — | orchestrator | Done |
> | F1 | Main-side controller + `WebContentsView` host | C0 | wave A | Done — 24 tests (20 controller, 4 host), reviewed; lazy-creation defect found in review and fixed |
> | F2 | Find bar renderer entry, preload, component | C0 | wave A | Done — 24 tests, reviewed |
> | F3 | ⌘F / ⌘G trigger in the main renderer + refresh on tab change | C0 | wave A | Done — 10 tests, reviewed |
> | F4 | Chromium-behaviour verification script | — | wave A | Done — `npm run verify:find-in-page` 6/6, exit 0 |
> | F5 | Integration: forge entry + `main/index.ts` wiring | F1 F2 F3 | wave B | Done — tsc clean, 1517 tests, smoke exit 0 |
> | F6 | Live verification (orchestrator, manual) | F5 | wave C | Done — 11/11 live after F7 |
> | F7 | Fix: incremental count while typing (findInPage option semantics) | F6 | wave C | Done — 28 tests; verified live |
> | G1 | Follow-up: data-level search in the CSV/XLSX grids | F6 | not scheduled | — |
> | G2 | Follow-up: collapsed tool cards findable via `hidden="until-found"` | F6 | not scheduled | — |

---

## Why this shape (the decisions, so nobody re-derives them)

- **Native `webContents.findInPage`, not a renderer-side text walker.** It
  reaches into mini-app iframes (cross-origin, out-of-process) for free, skips
  `display:none` content so the always-mounted hidden tabs produce no false
  matches, scrolls nested containers to the active match, and handles the
  notebook, the chat thread and the composer. The cost is Chromium's own
  yellow/orange highlight colours, which cannot be styled. Accepted.
- **The bar is its own `WebContentsView`, not a component in the page.**
  Measured on Electron 37.2 / Chromium 138 (this repo's binary): `findInPage`
  matches the value of an `<input>`, so a find box inside the page always
  matches its own query — a word that appears once in the body reports 2
  matches with active match #1 sitting on the box. A `WebContentsView`'s text
  is not searched (measured: overlay holding the word twice, main count
  unchanged). The in-page alternative (subtract one, skip the box's ordinal on
  wrap) is fragile and still paints a highlight over the user's own query.
- **Trigger is a renderer keydown beside the existing ⌘K handler, not an
  application menu.** The app sets no menu today (Electron's default applies,
  which has no Find item); owning a menu means owning the whole default
  template. ⌘F must **yield inside a CodeMirror editor** — the notebook's
  `basicSetup` binds it to CodeMirror's own search panel.
- **Esc keeps the selection.** `stopFindInPage('keepSelection')` leaves the
  found text selected in the page, which is exactly what the quote-to-composer
  toolbar reacts to.
- **Results are a snapshot.** Chromium does not re-run a find when the DOM
  changes, so the main renderer asks main to re-run the active query when the
  visible tab changes. Streaming replies are not re-queried in this pass.

### Measured Chromium behaviour (Electron 37.2 / Chromium 138, 2026-09-10)

| Behaviour | Result |
|---|---|
| Text in an `<input>` / `<textarea>` value | **Matched** — hence the separate view |
| `display:none` text; `display:none` iframe | Not matched — hidden tabs stay out |
| Cross-origin iframe in a separate renderer process | Matched — mini-apps come free |
| Text inside a `WebContentsView` overlay | Not matched |
| `hidden="until-found"` content | Matched; `beforematch` fires and the attribute is removed **only when the window is shown** (it rides a rendering frame) |

F4 turns these into a checked-in script so the premises stay pinned.

### What native find will not reach (recorded, not fixed here)

- CSV/XLSX viewers virtualize rows (`@tanstack/react-virtual`), so only the
  rendered rows are searchable → G1.
- Collapsed tool cards do not render their body
  (`assistant-ui/tool-fallback.tsx` ~line 117) → G2.
- Highlight colours are Chromium's.

---

## Rules for every ticket

Read `CLAUDE.md` → *Conventions* only (the file is long; `sed -n '/^## Conventions/,/^## Status/p' CLAUDE.md`). Then:

1. **Scope.** Create or modify only the files your ticket lists. If you must
   touch another file, do the minimum and call it out in your report.
2. **Other agents are working in this tree at the same time** on the other
   wave-A tickets, adding files under other paths. If `npx tsc --noEmit`
   reports errors in files outside your ticket's list, they are someone else's
   in-progress work: **do not edit those files**, report the paths, and judge
   your own ticket by errors in your files only
   (`npx tsc --noEmit 2>&1 | grep -E '<your paths>'`).
3. **Verify, then report.** `npx tsc --noEmit` clean for your files;
   `npm test -- <path-to-your-test-file>` green. Do **not** run the full suite
   (F5 does). **Never run bare `npx jest`** — wrong Node ABI.
4. **Tests live in `__tests__/` beside the module.** Tests that touch the real
   filesystem start with `/** @jest-environment node */` (default is jsdom).
   CSS imports are stubbed by `moduleNameMapper`, so a component test can import
   the component even though it imports a `.css` file.
5. **No new dependencies. No commits. Do not edit `CLAUDE.md`.**
6. **Report format.** Files created / modified; test command and result; any
   deviation from the spec and why; anything you noticed but did not touch.

---

## Contract — `src/cobuilding/shared/findInPage.ts` (C0, done — do not redefine)

Read the file; it is short and fully commented. Summary:

- `FIND_IPC` — channel names. Main renderer ↔ main: `find:open` (invoke),
  `find:next` (send `FindStep`), `find:refresh` (send). Bar ↔ main:
  `findbar:query` (send `FindQuery`), `findbar:step` (send `FindStep`),
  `findbar:close` (send `FindClose`); main → bar: `findbar:result`
  (`FindResult`), `findbar:focus` (no payload).
- Types `FindQuery { text }`, `FindStep { forward }`, `FindClose { keepSelection }`,
  `FindResult { activeMatchOrdinal, matches, finalUpdate }`.
- `FindAPI` = `window.findAPI` in the main renderer; `FindBarAPI` =
  `window.findBarAPI` in the bar renderer.
- Geometry: `FIND_BAR_WIDTH = 360`, `FIND_BAR_HEIGHT = 44`,
  `FIND_BAR_MARGIN = 12`, `CHROME_BAR_HEIGHT = 40`, and the pure
  `computeFindBarBounds(contentWidth)`.

---

## Tickets

### F1 — Main-side controller + `WebContentsView` host

**Goal.** Everything main does for find: an electron-free controller holding
the query state machine, and a thin Electron host that owns the bar view and
the IPC handlers. Nothing in this ticket is wired into `main/index.ts` (F5).

**Read first.** `src/cobuilding/shared/findInPage.ts`; `src/cobuilding/main/quickChat.ts`
(a second web contents owned by main, IPC registered in a module);
`src/cobuilding/main/freePort.ts` header (why a module is kept electron-free);
`src/cobuilding/main/__tests__/apiStore.test.ts` (how `electron` is mocked when
a test needs it — you should not need it; the controller takes callbacks).

**Create.** `src/cobuilding/main/findInPage.ts` *(electron-free — must not
import `electron` or `electron-log`)*, `src/cobuilding/main/findInPageHost.ts`,
`src/cobuilding/main/__tests__/findInPage.test.ts`.

**Spec — controller (`findInPage.ts`).**
```ts
import type { FindResult } from '../shared/findInPage';
export interface FindControllerDeps {
  findInPage(text: string, options: { forward?: boolean; findNext?: boolean }): void;
  stopFindInPage(action: 'clearSelection' | 'keepSelection'): void;
  showBar(): void;
  hideBar(): void;
  focusBar(): void;
  focusPage(): void;
  sendToBar(result: FindResult): void;
}
export interface FindController {
  open(): void;
  query(text: string): void;
  step(forward: boolean): void;
  refresh(): void;
  close(keepSelection: boolean): void;
  onFoundInPage(result: FindResult): void;
  isOpen(): boolean;
  activeText(): string;
}
export function createFindController(deps: FindControllerDeps): FindController;
```
Rules — each one is a test:
1. `open()` while closed → `showBar()` then `focusBar()`; `isOpen()` true.
   `open()` while open → `focusBar()` only (no `showBar`, no `findInPage`).
2. `query(t)` while open, `t` non-empty and different from `activeText()` →
   `findInPage(t, { findNext: false })`; `activeText()` becomes `t`.
3. `query(t)` while open with `t === activeText()` →
   `findInPage(t, { forward: true, findNext: true })` (re-submitting the same
   text steps forward, matching browser behaviour).
4. `query('')` while open → `stopFindInPage('clearSelection')`, `activeText()`
   is `''`, `sendToBar({ activeMatchOrdinal: 0, matches: 0, finalUpdate: true })`,
   and **no** `findInPage` call.
5. `step(forward)` with a non-empty `activeText()` →
   `findInPage(activeText, { forward, findNext: true })`; with empty text → no call.
6. `refresh()` while open with non-empty text → `findInPage(activeText, { findNext: false })`;
   while closed, or with empty text → no call.
7. `close(keep)` while open → `stopFindInPage(keep ? 'keepSelection' : 'clearSelection')`,
   `activeText()` becomes `''`, `hideBar()`, `focusPage()`, `isOpen()` false.
   `close()` while closed → **no dep is called** (idempotent).
8. `onFoundInPage(r)` while open → `sendToBar(r)`; while closed → dropped.
9. `query`/`step` while closed → no-op (the bar cannot send when hidden; be defensive).

**Spec — host (`findInPageHost.ts`).**
```ts
import type { BrowserWindow } from 'electron';
export function installFindInPage(opts: {
  getMainWindow: () => BrowserWindow | null;
  barEntryUrl: string;      // FIND_BAR_WINDOW_WEBPACK_ENTRY (F5 passes it)
  barPreloadPath: string;   // FIND_BAR_WINDOW_PRELOAD_WEBPACK_ENTRY
}): void;
```
- Registers `ipcMain.handle(FIND_IPC.open)` and `ipcMain.on` for `FIND_IPC.next`,
  `refresh`, `barQuery`, `barStep`, `barClose`, dispatching to the controller.
  Every handler first resolves `getMainWindow()`; if null or `isDestroyed()`,
  it does nothing.
- The controller is created **per main window**, lazily on the first `open`:
  `deps.findInPage`/`stopFindInPage` call `win.webContents.findInPage` /
  `stopFindInPage`; `focusPage` → `win.webContents.focus()`.
- The bar view is created lazily on the first `open` for that window:
  `new WebContentsView({ webPreferences: { preload: barPreloadPath, contextIsolation: true, nodeIntegration: false } })`,
  `view.setBackgroundColor('#00000000')`, `win.contentView.addChildView(view)`,
  `view.setBounds(computeFindBarBounds(win.getContentBounds().width))`,
  then `await view.webContents.loadURL(barEntryUrl)` **before** the first
  `focusBar` (otherwise `findbar:focus` is sent to a page that has not loaded).
  Re-apply bounds on `win.on('resize')`. `showBar`/`hideBar` →
  `view.setVisible(true/false)`. `focusBar` → `view.webContents.focus()` then
  `view.webContents.send(FIND_IPC.barFocus)`. `sendToBar(r)` →
  `view.webContents.send(FIND_IPC.barResult, r)`.
- `win.webContents.on('found-in-page', (_e, r) => controller.onFoundInPage({ activeMatchOrdinal: r.activeMatchOrdinal, matches: r.matches, finalUpdate: r.finalUpdate }))`.
- **Window recreation.** `createMainWindow()` runs more than once in this app
  (macOS re-activate). Keep `{ win, view, controller }` for the window you
  attached to; when `getMainWindow()` returns a different window, or the kept
  one is destroyed, drop the old triple and build a new one on the next `open`.
  On `win.on('closed')` drop the triple without calling `stopFindInPage` (the
  web contents is gone).
- Log with `electron-log` as the rest of main does, tag `[FindInPage]`, on view
  creation, open and close. Nothing is created until the first ⌘F.

**Tests (`findInPage.test.ts`, jsdom default is fine — pure functions).**
One case per rule above with a fake `FindControllerDeps` built from `jest.fn()`
that also records call order (rule 1 and 7 order matters); plus
`computeFindBarBounds`: normal width places the right edge `FIND_BAR_MARGIN`
from the window edge; a width narrower than the bar clamps `x` to 0; `y` is
`CHROME_BAR_HEIGHT + FIND_BAR_MARGIN`.

**Acceptance.** tsc clean for your files; `npm test -- src/cobuilding/main/__tests__/findInPage.test.ts` green.

---

### F2 — Find bar renderer entry, preload, component

**Goal.** The bar's own page: a fourth renderer entry (not yet registered in
`forge.config.js` — F5 does that) with its preload, a Command Desk styled
component, and a pure state module.

**Read first.** `src/cobuilding/shared/findInPage.ts`;
`src/cobuilding/renderer/quick-chat.html`, `quick-chat-entry.tsx`,
`src/cobuilding/main/quickChatPreload.ts` (the secondary-entry pattern);
`src/cobuilding/renderer/components/command-desk/MSymbol.tsx`;
`.cdIconBtn` (~line 215) and the `:root` tokens (~line 33) in
`src/cobuilding/renderer/commandDesk.css`;
`src/cobuilding/renderer/components/command-desk/__tests__/DictationButton.test.tsx`
(how a component is rendered and driven in this repo's tests).

**Create.**
- `src/cobuilding/renderer/find-bar.html` — copy `quick-chat.html`; title
  `Find`; body `margin:0; background: transparent`.
- `src/cobuilding/renderer/find-bar-entry.tsx` — `import './commandDesk.css'`
  (tokens + self-hosted fonts; it has no `body` rule so it is safe in a small
  document) and `import './components/find-bar/FindBar.css'`; renders
  `<FindBar api={window.findBarAPI} />` into `#root`.
- `src/cobuilding/renderer/find-bar-api.d.ts` — a module-style ambient file:
  `import type { FindBarAPI } from '../shared/findInPage'; declare global { interface Window { findBarAPI: FindBarAPI } } export {};`
- `src/cobuilding/main/findBarPreload.ts` — `contextBridge.exposeInMainWorld('findBarAPI', …)`
  implementing `FindBarAPI` over `FIND_IPC` (`send` for query/step/close;
  `onResult`/`onFocus` register `ipcRenderer.on` and return a function that
  removes exactly that listener).
- `src/cobuilding/renderer/components/find-bar/findBarState.ts` *(pure)*:
  ```ts
  export interface FindBarState { text: string; ordinal: number; matches: number; settled: boolean }
  export const initialFindBarState: FindBarState;   // '', 0, 0, true
  export function applyText(state, text: string): FindBarState;   // sets text; '' → ordinal 0, matches 0, settled true; otherwise settled false (awaiting a result)
  export function applyResult(state, result: FindResult): FindBarState; // ordinal/matches from the result, settled = result.finalUpdate; ignored (state returned unchanged) when state.text === ''
  export function formatCount(state): string;
  ```
  `formatCount`: `''` when `text === ''`; `` `${ordinal} of ${matches}` `` when
  `matches > 0` (incremental updates render too); `'No matches'` when
  `matches === 0 && settled`; `''` when `matches === 0 && !settled` (searching).
- `src/cobuilding/renderer/components/find-bar/FindBar.tsx` — `props: { api: FindBarAPI }`.
  Markup: `div.findBar[role=search]` › `input.findBar__input[aria-label="Find in page"][placeholder="Find in page"][spellCheck=false][autoFocus]`,
  `span.findBar__count` (`formatCount`), `button.cdIconBtn.findBar__btn[aria-label="Previous match"]`
  with `<MSymbol name="keyboard_arrow_up" />`, same for `"Next match"` /
  `keyboard_arrow_down`, and `button.cdIconBtn.findBar__btn[aria-label="Close"]`
  with `<MSymbol name="close" />`. Prev/Next are `disabled` when `matches === 0`.
  Behaviour: input change → `applyText` + `api.query(text)`. Keydown anywhere in
  the bar: `Enter` → `api.step(true)`; `Shift+Enter` → `api.step(false)`;
  `Escape` → `api.close(true)`; `(meta|ctrl)+g` → `api.step(!shiftKey)`;
  `(meta|ctrl)+f` → select the input's text, `preventDefault`, no IPC. Close
  button → `api.close(true)` (Chrome keeps the selection on ✕ too). Subscribe
  `api.onResult` → `applyResult`; `api.onFocus` → focus the input and select its
  text; unsubscribe both on unmount.
- `src/cobuilding/renderer/components/find-bar/FindBar.css`:
  `html, body { margin: 0; background: transparent; overflow: hidden; }`
  `.findBar { box-sizing: border-box; width: 360px; height: 44px; display: flex; align-items: center; gap: 4px; padding: 0 6px 0 12px; background: #ffffff; border: 1px solid var(--cd-border); border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.10); font-family: var(--cd-sans); }`
  input: `flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: inherit; font-size: 13px; color: var(--cd-ink);` placeholder `var(--cd-text3)`;
  count: `font-family: var(--cd-mono); font-size: 11px; color: var(--cd-text3); white-space: nowrap; padding: 0 4px;`.
  The `360px`/`44px` literals must equal `FIND_BAR_WIDTH`/`FIND_BAR_HEIGHT`.
- `__tests__/findBarState.test.ts`, `__tests__/FindBar.test.tsx`.

**Tests.** State: `applyText('')` resets and settles; `applyResult` on empty
text is ignored; `formatCount` for each of the four branches. Component (fake
`api` from `jest.fn()`s; capture the `onResult`/`onFocus` callbacks to drive
them): typing `abc` calls `query('abc')`; `Enter` → `step(true)`; `Shift+Enter`
→ `step(false)`; `Escape` → `close(true)`; `Meta+g` → `step(true)`,
`Shift+Meta+g` → `step(false)`; a result `{2, 5, true}` renders `2 of 5`;
`{0, 0, true}` with text renders `No matches`; with empty text nothing renders
in the count; Prev/Next disabled at 0 and enabled at 5; the focus callback
focuses the input; unmount calls both unsubscribers. **CSS tie test:** read
`FindBar.css` from disk (`fs.readFileSync`, `/** @jest-environment node */`)
and assert it contains `width: ${FIND_BAR_WIDTH}px` and
`height: ${FIND_BAR_HEIGHT}px` — the constant and the stylesheet drift
independently otherwise.

**Acceptance.** tsc clean for your files; both test files green via
`npm test -- src/cobuilding/renderer/components/find-bar`.

---

### F3 — ⌘F / ⌘G trigger in the main renderer + refresh on tab change

**Goal.** Pressing ⌘F anywhere in the app (except inside a CodeMirror editor)
asks main to open the bar; ⌘G / ⇧⌘G step; switching tabs re-runs the query.

**Read first.** `src/cobuilding/shared/findInPage.ts`; the ⌘K handler in
`src/cobuilding/renderer/index.tsx` (~line 947, "interim: routes to the chat
list"); `sidebarTab` (~line 622) and the `activeTabId` passed to
`ToolWorkspace` (~line 1140) — find its declaration; the `toolDataAPI` block in
`src/cobuilding/main/preload.ts` (~line 169) as the shape to copy;
`src/cobuilding/renderer/components/notebook/CodeEditor.tsx` (`basicSetup` →
CodeMirror owns ⌘F inside `.cm-editor`).

**Create.** `src/cobuilding/renderer/components/command-desk/findShortcut.ts`,
`src/cobuilding/renderer/components/command-desk/__tests__/findShortcut.test.ts`,
`src/cobuilding/renderer/find-api.d.ts`
(`import type { FindAPI } from '../shared/findInPage'; declare global { interface Window { findAPI: FindAPI } } export {};`
— do **not** edit `renderer/types.d.ts`).
**Modify.** `src/cobuilding/main/preload.ts` (append one block),
`src/cobuilding/renderer/index.tsx` (extend the ⌘K effect; add one effect).

**Spec.**
```ts
export type FindShortcutAction = 'open' | 'next' | 'prev';
export interface FindShortcutEvent { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: EventTarget | null }
export function isInsideCodeMirror(target: EventTarget | null): boolean; // target is a Node with a `.cm-editor` ancestor (inclusive)
export function findShortcutAction(e: FindShortcutEvent): FindShortcutAction | null;
```
`findShortcutAction`: let `mod = metaKey || ctrlKey`. `altKey` → `null`.
`mod && !shiftKey && key.toLowerCase() === 'f'` → `'open'`, **except** when
`isInsideCodeMirror(target)` → `null` (let CodeMirror's own panel open).
`mod && key.toLowerCase() === 'g'` → `shiftKey ? 'prev' : 'next'`. Everything
else → `null`. ⌘F with the target inside the composer textarea **does** open
(browsers do).

preload.ts, after the `toolDataAPI` block, with `import { FIND_IPC } from '../shared/findInPage';` at the top:
```ts
contextBridge.exposeInMainWorld('findAPI', {
  open: () => ipcRenderer.invoke(FIND_IPC.open),
  next: (forward: boolean) => ipcRenderer.send(FIND_IPC.next, { forward }),
  refresh: () => ipcRenderer.send(FIND_IPC.refresh),
});
```
index.tsx — in the existing keydown handler, **before** the ⌘K branch:
```ts
const action = findShortcutAction(e);
if (action) {
  e.preventDefault();
  if (action === 'open') void window.findAPI?.open();
  else window.findAPI?.next(action === 'next');
  return;
}
```
(keep the ⌘K branch as is; the effect's dependency list is unchanged). Add,
beside it: `useEffect(() => { window.findAPI?.refresh(); }, [sidebarTab, activeTabId]);`
with a one-line comment saying why (find results are a snapshot of the visible
surface). Use optional chaining on `window.findAPI` — tests that render the
shell have no preload.

**Tests (`findShortcut.test.ts`, jsdom).** ⌘F → `open`; Ctrl+F → `open`;
⇧⌘F → `null`; ⌥⌘F → `null`; plain `f` → `null`; ⌘G → `next`; ⇧⌘G → `prev`;
⌘F with `target` a `<div class="cm-content">` inside `<div class="cm-editor">`
→ `null`; ⌘F with `target` a `<textarea>` → `open`; `isInsideCodeMirror(null)` → false.

**Acceptance.** tsc clean for your files and for `index.tsx` / `preload.ts`;
`npm test -- src/cobuilding/renderer/components/command-desk/__tests__/findShortcut.test.ts` green.

---

### F4 — Chromium-behaviour verification script

**Goal.** Pin the five measured behaviours the design rests on, as a script a
future session can run in 30 seconds. Jest cannot host it: it needs a real
Electron window (the `hidden="until-found"` reveal rides a rendering frame, so
the window must be **shown**).

**Read first.** The probes that produced the numbers, in this session's
scratchpad: `find-probe.js` + `host.html` and `find-probe3.js` + `host2.html`
under `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/e2fe3b2e-caa8-49fc-b932-a284d99a641c/scratchpad/`.
`scripts/verify-clear-resume-pointer.sh` (precedent for a checked-in
verification that Jest cannot run). CLAUDE.md → Conventions on
`ELECTRON_RUN_AS_NODE` and `--use-mock-keychain`.

**Create.** `scripts/verify-find-in-page.js` (plain JS, Electron main script)
and `scripts/verify-find-in-page/host.html` (the fixture; the cross-origin
child is served from a `protocol.handle('probe-app', …)` registered in the
script, as the probes do). **Modify.** `package.json` — one script:
`"verify:find-in-page": "env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/verify-find-in-page.js"`.

**Spec.** `app.commandLine.appendSwitch('use-mock-keychain')`. A shown 800×600
window. Helper `findOnce(wc, text)` resolves on the `found-in-page` event with
`finalUpdate`, then waits ~300 ms (so reveals can fire). Assertions, in order,
each printed as a row (`behaviour · expected · got · ok`); the first failure
prints the row, sets exit code 1, and continues; exit 0 when all pass; a 30 s
watchdog exits 2:
1. A word once in body text and once in an `<input value>` → `matches === 2`
   (the premise for the separate view; if Chromium ever stops matching input
   values this row fails and the design may simplify).
2. Text inside `display:none` → 0.
3. An iframe with `display:none` → 0.
4. A visible cross-origin iframe on `probe-app://` → 1, **and**
   `mainFrame.framesInSubtree` shows the child's `processId` differs from the
   main frame's (otherwise the row proves nothing about out-of-process frames).
5. A `WebContentsView` added to `win.contentView` whose page contains the word
   twice → the main page's count is unchanged.
6. `<div hidden="until-found">` → matched, and after the wait the element's
   `hidden` attribute is gone (read via `executeJavaScript`).
Header comment: what the script proves, why it is not a Jest test, how to run it.

**Acceptance.** `npm run verify:find-in-page` exits 0 on this machine. Paste
the printed table in your report.

---

### F5 — Integration: forge entry + `main/index.ts` wiring *(wave B — after F1, F2, F3)*

**Goal.** Register the bar as the fourth renderer entry and install the host.

**Read first.** `forge.config.js` renderer `entryPoints` (~line 250); the
`declare const *_WEBPACK_ENTRY` lines in `src/cobuilding/main/index.ts` (~206)
and `createQuickChatWindow(mainWindow!)` (~1170); `installFindInPage` in
`src/cobuilding/main/findInPageHost.ts` (F1).

**Modify.** `forge.config.js` — add after the quick-chat entry:
`{ html: './src/cobuilding/renderer/find-bar.html', js: './src/cobuilding/renderer/find-bar-entry.tsx', name: 'find_bar_window', preload: { js: './src/cobuilding/main/findBarPreload.ts' } }`
(forge derives `FIND_BAR_WINDOW_WEBPACK_ENTRY` / `FIND_BAR_WINDOW_PRELOAD_WEBPACK_ENTRY`
from the name). `src/cobuilding/main/index.ts` — declare those two constants
beside the others; import `installFindInPage`; call it **once**, right after
`createQuickChatWindow(mainWindow!)`, with
`{ getMainWindow: () => mainWindow, barEntryUrl: FIND_BAR_WINDOW_WEBPACK_ENTRY, barPreloadPath: FIND_BAR_WINDOW_PRELOAD_WEBPACK_ENTRY }`.

**Acceptance.** `npx tsc --noEmit` clean (whole project); full `npm test`
green; `npm start -- -- --smoke-test` exits 0 and its log contains no
`[FindInPage]` line (nothing is created before the first ⌘F). Report the
test count.

---

### F6 — Live verification *(orchestrator, manual)*

`npm start`, then: ⌘F → bar appears top-right under the chrome bar, focused;
type a word that appears in the visible chat → highlights and `n of m`; Enter /
⇧Enter step; ⌘G with the page focused steps; Esc → bar hides, the active match
stays selected, the quote toolbar offers it; switch tab → count re-runs against
the new surface; a word present only inside a mounted mini-app is found; ⌘F
with the caret in a notebook cell opens CodeMirror's panel, not ours; a word in
a hidden tab is **not** counted. Record results in CLAUDE.md → Status.

---

## Follow-ups (defined, not scheduled)

### G1 — Data-level search in the CSV/XLSX grids
`CsvView.tsx` / `XlsxView.tsx` hold the parsed rows and a `useVirtualizer`; only
rendered rows are in the DOM. Give each an in-viewer search that scans the row
array, reports `n of m`, and `scrollToIndex` to the hit. Decide first whether it
is a separate box inside the viewer or a routing of the global bar's query to
the visible grid — that is a product call.

### G2 — Collapsed tool cards findable
`tool-fallback.tsx` renders the body only when `open`. Rendering it with
`hidden="until-found"` makes Chromium reveal it on a match (measured). Cost:
every tool body in the DOM on long threads. Measure the DOM size on a real
long thread before deciding.

---

## F7 — Fix: incremental count while typing (findInPage option semantics)

**Why.** Live verification (F6, driven over CDP against the running app) found
that the count stays blank while you type and only appears after you press
Enter. Root-caused with an instrumented trace of `webContents.findInPage` in the
main process plus a standalone Electron probe (`scripts/`-style, in the session
scratchpad). Measured on this repo's Electron 37.2 / Chromium 138:

| First `findInPage` call for a term | Emits `found-in-page`? |
|---|---|
| `findInPage(t)` (findNext omitted) | yes → ordinal 1 |
| `findInPage(t, { findNext: false })` | **no** — deferred; nothing emits until a later call flushes it |
| `findInPage(t, { findNext: true })` | yes → ordinal 1 |
| `findInPage(t, { forward: true, findNext: true })` | yes → ordinal 1 |

And with an established session: `findInPage(sameTerm, { findNext: true })`
steps to the next match; `{ forward: false, findNext: true }` steps back; a
**changed** term with `findNext: true` resets to ordinal 1 (so progressive
typing lands on match 1 each keystroke). Zero matches emit `0 / 0`; a single
match emits `1 / 1`.

The controller's new-query path uses `{ findNext: false }`, which is exactly the
one form that does not emit. That is the whole bug.

**Read first.** `src/cobuilding/main/findInPage.ts` (the controller you wrote)
and its test; this section's table; the F1 spec above (rules 2–7) — F7 revises
rules 2, 3, 6 and 7, so read what they said before changing them.

**Modify.** `src/cobuilding/main/findInPage.ts`,
`src/cobuilding/main/__tests__/findInPage.test.ts`. Touch nothing else — the bar
component, preload and host are correct.

**New controller behaviour (each bullet is a test):**
1. `query(t)` while open, `t` non-empty and `t !== activeText()` →
   `findInPage(t, { forward: true, findNext: true })`; `activeText()` becomes `t`.
2. `query(t)` while open with `t === activeText()` → **no `findInPage` call**
   (a no-op — advancing is `step()`'s job; this also absorbs a duplicate
   change event so a single keystroke can't jump two matches). Previously this
   stepped; that was wrong.
3. `query('')` while open → unchanged: `stopFindInPage('clearSelection')`,
   `activeText()` becomes `''`, `sendToBar` the empty result, no `findInPage`.
4. `step(forward)` with non-empty `activeText()` → unchanged:
   `findInPage(activeText, { forward, findNext: true })`.
5. `refresh()` while open with non-empty text → now
   `findInPage(activeText, { forward: true, findNext: true })` (was
   `{ findNext: false }`, which did not reliably emit after a tab switch).
6. `close(keep)` while open → `stopFindInPage(...)`, `hideBar()`, `focusPage()`,
   `isOpen()` false, **but `activeText()` is RETAINED** (was reset to `''`).
   Chrome keeps the last term across ⌘F, and retaining it keeps the controller
   in sync with the bar's input, which the bar does not clear on hide.
7. `open()` while closed → `showBar()`, `focusBar()`, **and if `activeText()` is
   non-empty, re-run it**: `findInPage(activeText, { forward: true, findNext: true })`
   so the count is restored on reopen. `open()` while already open → `focusBar()`
   only, no `findInPage`. (Order: `showBar` before `focusBar`; the re-run may
   come before or after `focusBar`.)
8. `onFoundInPage`, `isOpen`, `activeText` getters — unchanged.

Leave `EMPTY_RESULT` and the `!open` guards as they are. Do **not** change the
`FindControllerDeps` interface; `findInPage`'s options type already allows
`forward` and `findNext`.

**Tests.** Update the existing cases for rules 2, 3(query), 6, 7 to the above and
add: (a) `query(t)` then `query(t)` again calls `findInPage` exactly once;
(b) `close` retains `activeText`; (c) `open` after a `close` with retained text
calls `findInPage(text, { forward: true, findNext: true })` once and `showBar`;
(d) `refresh` uses `findNext: true`. Keep the host test
(`findInPageHost.test.ts`) passing unchanged — if it asserted the old option
value anywhere, fix only that assertion.

**Acceptance.** `npx tsc --noEmit 2>&1 | grep -E 'findInPage'` empty;
`npm test -- src/cobuilding/main/__tests__/findInPage` green (both suites).
Report pass counts and the diff of `findInPage.ts`.

## Observed in F6, not a find defect (recorded)

- **G3 — the quote toolbar does not appear on Escape.** Escape correctly leaves
  the found text selected in the page (`keepSelection` holds — verified: the
  selection was `"Rescan"`), but the select-to-quote toolbar did not show. It
  keys off a user selection gesture (mouseup / selectionchange), which a
  programmatic find selection does not raise. Deciding whether find should
  synthesize that event is a quote-feature call, not a find one. Not scheduled.
