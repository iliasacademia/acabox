/**
 * Find in page — the contract shared by main, the main renderer's preload, and
 * the find bar (its own WebContentsView with its own preload).
 *
 * Why the bar is a separate WebContentsView and not a React component in the
 * main page: measured on Electron 37.2 / Chromium 138, `webContents.findInPage`
 * matches the value of an `<input>`, so a find box living in the page would
 * always match its own query (2 matches for a word that appears once, active
 * match #1 sitting on the box). A WebContentsView's text is not searched.
 * Design and tickets: docs/design/find-in-page.md.
 */

/** IPC channel names. Main renderer ↔ main use `find:*`; bar ↔ main use `findbar:*`. */
export const FIND_IPC = {
  /** invoke, main renderer → main: show the bar (create on first use) and focus it. */
  open: 'find:open',
  /** send, main renderer → main: `FindStep` — step the active query (⌘G / ⇧⌘G with the page focused). No-op without a query. */
  next: 'find:next',
  /** send, main renderer → main: re-run the active query after the visible surface changed (tab switch). No-op unless the bar is open with a query. */
  refresh: 'find:refresh',
  /** send, bar → main: `FindQuery` — the input's current text; empty text clears the search. */
  barQuery: 'findbar:query',
  /** send, bar → main: `FindStep` — Enter / ⇧Enter / arrows. */
  barStep: 'findbar:step',
  /** send, bar → main: `FindClose` — Esc keeps the selection so the found text stays selected in the page. */
  barClose: 'findbar:close',
  /** send, main → bar: `FindResult` forwarded from the main webContents' `found-in-page`. */
  barResult: 'findbar:result',
  /** send, main → bar: the bar was (re)opened; focus the input and select its text. */
  barFocus: 'findbar:focus',
} as const;

export interface FindQuery {
  text: string;
}

export interface FindStep {
  forward: boolean;
}

export interface FindClose {
  keepSelection: boolean;
}

/** Subset of Electron's `found-in-page` result the bar renders. */
export interface FindResult {
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

/** `window.findAPI` in the MAIN renderer (exposed by main/preload.ts). */
export interface FindAPI {
  open(): Promise<void>;
  next(forward: boolean): void;
  refresh(): void;
}

/** `window.findBarAPI` in the BAR renderer (exposed by main/findBarPreload.ts). */
export interface FindBarAPI {
  query(text: string): void;
  step(forward: boolean): void;
  close(keepSelection: boolean): void;
  /** Returns an unsubscribe function. */
  onResult(callback: (result: FindResult) => void): () => void;
  /** Returns an unsubscribe function. */
  onFocus(callback: () => void): () => void;
}

/** Geometry of the bar view, in CSS pixels of the main window's content area. */
export const FIND_BAR_WIDTH = 360;
export const FIND_BAR_HEIGHT = 44;
/** Gap between the bar and the window's right edge / the chrome bar's bottom edge. */
export const FIND_BAR_MARGIN = 12;
/** Height of `.cdChrome` in commandDesk.css. The bar is docked just below it. */
export const CHROME_BAR_HEIGHT = 40;

/** Where the bar sits for a given content-area width. Pure, so it is unit-testable. */
export function computeFindBarBounds(contentWidth: number): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.max(0, contentWidth - FIND_BAR_WIDTH - FIND_BAR_MARGIN),
    y: CHROME_BAR_HEIGHT + FIND_BAR_MARGIN,
    width: FIND_BAR_WIDTH,
    height: FIND_BAR_HEIGHT,
  };
}
