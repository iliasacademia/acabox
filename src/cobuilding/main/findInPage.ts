/**
 * Find-in-page controller — the query state machine, kept electron-free so it
 * is unit-testable without a main process (see freePort.ts's header for why
 * that separation matters generally). All Electron effects are pushed
 * through `FindControllerDeps`; `findInPageHost.ts` is the thin Electron glue
 * that supplies the real callbacks.
 *
 * Design and tickets: docs/design/find-in-page.md (ticket F1).
 */
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

const EMPTY_RESULT: FindResult = { activeMatchOrdinal: 0, matches: 0, finalUpdate: true };

export function createFindController(deps: FindControllerDeps): FindController {
  let open = false;
  let text = '';

  return {
    open(): void {
      if (open) {
        deps.focusBar();
        return;
      }
      open = true;
      deps.showBar();
      deps.focusBar();
      // Reopening (⌘F again after a close) restores the count for a
      // retained term rather than leaving the bar showing a stale/blank one.
      if (text !== '') {
        deps.findInPage(text, { forward: true, findNext: true });
      }
    },

    query(t: string): void {
      if (!open) return;

      if (t === '') {
        text = '';
        deps.stopFindInPage('clearSelection');
        deps.sendToBar(EMPTY_RESULT);
        return;
      }

      if (t === text) {
        // A duplicate change event for the same text must not advance the
        // match — that's step()'s job. (Measured, F7: this used to step
        // forward here, on the mistaken assumption that `findInPage(t,
        // {findNext:false})` below was the live-typing path; it never emits
        // `found-in-page` on Electron 37.2/Chromium 138's first call for a
        // term, which is what left the count blank while typing.)
        return;
      }

      // Measured (F7): only `findNext:true` (with `forward:true`, matching
      // Chrome's own incremental-search semantics) reliably emits
      // `found-in-page` on the FIRST call for a new/changed term in this
      // Electron build; `{findNext:false}` is silently deferred until a
      // later call flushes it, which is why the count stayed blank while
      // typing. A changed term still resets to match 1.
      text = t;
      deps.findInPage(t, { forward: true, findNext: true });
    },

    step(forward: boolean): void {
      // Defensive: the bar cannot send while hidden, but a closed controller
      // has already reset `text` to '' anyway, so this also covers "closed".
      if (!open || text === '') return;
      deps.findInPage(text, { forward, findNext: true });
    },

    refresh(): void {
      if (!open || text === '') return;
      // F7: `{findNext:false}` did not reliably emit after a tab switch,
      // same root cause as the query() fix above.
      deps.findInPage(text, { forward: true, findNext: true });
    },

    close(keepSelection: boolean): void {
      if (!open) return;
      open = false;
      // F7: `activeText` is retained (not reset) — Chrome keeps the last
      // term across ⌘F, and the bar's own input does not clear on hide, so
      // resetting here would desync the controller from what the bar shows.
      deps.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection');
      deps.hideBar();
      deps.focusPage();
    },

    onFoundInPage(result: FindResult): void {
      if (!open) return;
      deps.sendToBar(result);
    },

    isOpen(): boolean {
      return open;
    },

    activeText(): string {
      return text;
    },
  };
}
