/**
 * `main/findInPage.ts` — the electron-free find-in-page query state machine.
 *
 * One case per rule in docs/design/find-in-page.md's F1 spec, as revised by
 * F7 (live verification found the match count stayed blank while typing:
 * `findInPage(t, {findNext:false})` — F1's new-query path — does not emit
 * `found-in-page` on the first call for a term on this Electron build;
 * `{forward:true, findNext:true}` does, and still resets to match 1 for a
 * changed term. F7 also made `close()` retain `activeText` instead of
 * resetting it, and `open()`/`refresh()` re-run with the same option shape).
 * Deps are `jest.fn()`s that also push onto a shared `calls` array so call
 * ORDER can be asserted (the open/close rules depend on it), not just call
 * presence.
 */
import { createFindController, type FindControllerDeps } from '../findInPage';
import {
  computeFindBarBounds,
  FIND_BAR_WIDTH,
  FIND_BAR_HEIGHT,
  FIND_BAR_MARGIN,
  CHROME_BAR_HEIGHT,
} from '../../shared/findInPage';

type DepName = keyof FindControllerDeps;

function makeDeps(): { deps: FindControllerDeps; calls: DepName[] } {
  const calls: DepName[] = [];
  const deps: FindControllerDeps = {
    findInPage: jest.fn(() => {
      calls.push('findInPage');
    }),
    stopFindInPage: jest.fn(() => {
      calls.push('stopFindInPage');
    }),
    showBar: jest.fn(() => {
      calls.push('showBar');
    }),
    hideBar: jest.fn(() => {
      calls.push('hideBar');
    }),
    focusBar: jest.fn(() => {
      calls.push('focusBar');
    }),
    focusPage: jest.fn(() => {
      calls.push('focusPage');
    }),
    sendToBar: jest.fn(() => {
      calls.push('sendToBar');
    }),
  };
  return { deps, calls };
}

describe('createFindController', () => {
  // Rule 1
  test('open() while closed calls showBar then focusBar, and opens', () => {
    const { deps, calls } = makeDeps();
    const controller = createFindController(deps);

    controller.open();

    expect(calls).toEqual(['showBar', 'focusBar']);
    expect(deps.findInPage).not.toHaveBeenCalled();
    expect(controller.isOpen()).toBe(true);
  });

  test('open() while already open calls only focusBar', () => {
    const { deps, calls } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    calls.length = 0;
    jest.clearAllMocks();

    controller.open();

    expect(calls).toEqual(['focusBar']);
    expect(deps.showBar).not.toHaveBeenCalled();
    expect(deps.findInPage).not.toHaveBeenCalled();
    expect(controller.isOpen()).toBe(true);
  });

  // Rule 1 (F7) — was `{findNext:false}`; measured to not emit `found-in-page`
  // on the first call for a term, which is what left the count blank while typing.
  test('query() with new non-empty text calls findInPage with forward:true, findNext:true and updates activeText', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();

    controller.query('gene');

    expect(deps.findInPage).toHaveBeenCalledWith('gene', { forward: true, findNext: true });
    expect(deps.findInPage).toHaveBeenCalledTimes(1);
    expect(controller.activeText()).toBe('gene');
  });

  // Rule 2 (F7) — was a "step forward" branch; now a no-op, since stepping is
  // step()'s job and a duplicate change event for the same text must not
  // silently advance the match.
  test('query() re-submitting the same text is a no-op', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    controller.query('gene');
    jest.clearAllMocks();

    controller.query('gene');

    expect(deps.findInPage).not.toHaveBeenCalled();
    expect(controller.activeText()).toBe('gene');
  });

  test('query(t) called twice in a row calls findInPage exactly once', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();

    controller.query('gene');
    controller.query('gene');

    expect(deps.findInPage).toHaveBeenCalledTimes(1);
    expect(deps.findInPage).toHaveBeenCalledWith('gene', { forward: true, findNext: true });
  });

  // Rule 3 (F7) — unchanged from F1.
  test('query(\'\') clears the search without calling findInPage', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    controller.query('gene');
    jest.clearAllMocks();

    controller.query('');

    expect(deps.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(controller.activeText()).toBe('');
    expect(deps.sendToBar).toHaveBeenCalledWith({ activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
    expect(deps.findInPage).not.toHaveBeenCalled();
  });

  // Rule 4 (F7) — unchanged from F1.
  test('step() with a non-empty activeText calls findInPage with findNext:true', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    controller.query('gene');
    jest.clearAllMocks();

    controller.step(true);
    expect(deps.findInPage).toHaveBeenLastCalledWith('gene', { forward: true, findNext: true });

    controller.step(false);
    expect(deps.findInPage).toHaveBeenLastCalledWith('gene', { forward: false, findNext: true });

    expect(deps.findInPage).toHaveBeenCalledTimes(2);
  });

  test('step() with an empty activeText is a no-op', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();

    controller.step(true);

    expect(deps.findInPage).not.toHaveBeenCalled();
  });

  // Rule 5 (F7) — was `{findNext:false}`, which did not reliably emit
  // `found-in-page` after a tab switch (same root cause as the query() fix).
  test('refresh() while open with non-empty text re-runs the query with forward:true, findNext:true', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    controller.query('gene');
    jest.clearAllMocks();

    controller.refresh();

    expect(deps.findInPage).toHaveBeenCalledWith('gene', { forward: true, findNext: true });
    expect(deps.findInPage).toHaveBeenCalledTimes(1);
  });

  test('refresh() while closed is a no-op', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);

    controller.refresh();

    expect(deps.findInPage).not.toHaveBeenCalled();
  });

  test('refresh() while open with empty text is a no-op', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();

    controller.refresh();

    expect(deps.findInPage).not.toHaveBeenCalled();
  });

  // Rule 6 (F7) — was `activeText() becomes ''`; now RETAINED. Chrome keeps
  // the last term across ⌘F, and the bar's own input does not clear on hide.
  test('close(true) while open keeps the selection, in order, closes, and retains activeText', () => {
    const { deps, calls } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    controller.query('gene');
    calls.length = 0;
    jest.clearAllMocks();

    controller.close(true);

    expect(calls).toEqual(['stopFindInPage', 'hideBar', 'focusPage']);
    expect(deps.stopFindInPage).toHaveBeenCalledWith('keepSelection');
    expect(controller.activeText()).toBe('gene');
    expect(controller.isOpen()).toBe(false);
  });

  test('close() retains activeText rather than clearing it', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    controller.query('gene');

    controller.close(false);

    expect(controller.activeText()).toBe('gene');
  });

  test('close(false) while open clears the selection', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    controller.query('gene');
    jest.clearAllMocks();

    controller.close(false);

    expect(deps.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  test('close() while already closed is idempotent — no dep is called', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);

    controller.close(true);

    expect(deps.stopFindInPage).not.toHaveBeenCalled();
    expect(deps.hideBar).not.toHaveBeenCalled();
    expect(deps.focusPage).not.toHaveBeenCalled();
    expect(controller.isOpen()).toBe(false);
  });

  // Rule 7 (F7) — open() now re-runs a retained term so the count is
  // restored on reopen rather than showing stale/blank.
  test('open() after close() with a retained term re-runs findInPage once and shows the bar', () => {
    const { deps, calls } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    controller.query('gene');
    controller.close(true);
    calls.length = 0;
    jest.clearAllMocks();

    controller.open();

    expect(deps.showBar).toHaveBeenCalledTimes(1);
    expect(deps.findInPage).toHaveBeenCalledWith('gene', { forward: true, findNext: true });
    expect(deps.findInPage).toHaveBeenCalledTimes(1);
    expect(controller.activeText()).toBe('gene');
    expect(controller.isOpen()).toBe(true);
  });

  test('open() while closed with no retained term does not call findInPage', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);

    controller.open();

    expect(deps.findInPage).not.toHaveBeenCalled();
  });

  // Rule 8 (F7) — onFoundInPage/isOpen/activeText getters are unchanged.
  test('onFoundInPage() while open forwards the result to sendToBar', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    controller.open();
    const result = { activeMatchOrdinal: 2, matches: 5, finalUpdate: true };

    controller.onFoundInPage(result);

    expect(deps.sendToBar).toHaveBeenCalledWith(result);
  });

  test('onFoundInPage() while closed is dropped', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);
    const result = { activeMatchOrdinal: 2, matches: 5, finalUpdate: true };

    controller.onFoundInPage(result);

    expect(deps.sendToBar).not.toHaveBeenCalled();
  });

  // Defensive/no-op guards (F1 rule 9) — unchanged by F7.
  test('query() while closed is a no-op', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);

    controller.query('gene');

    expect(deps.findInPage).not.toHaveBeenCalled();
    expect(deps.stopFindInPage).not.toHaveBeenCalled();
    expect(controller.activeText()).toBe('');
  });

  test('step() while closed is a no-op', () => {
    const { deps } = makeDeps();
    const controller = createFindController(deps);

    controller.step(true);

    expect(deps.findInPage).not.toHaveBeenCalled();
  });
});

describe('computeFindBarBounds', () => {
  test('places the right edge FIND_BAR_MARGIN from the window edge for a normal width', () => {
    const bounds = computeFindBarBounds(1200);

    expect(bounds.width).toBe(FIND_BAR_WIDTH);
    expect(bounds.x + bounds.width).toBe(1200 - FIND_BAR_MARGIN);
  });

  test('clamps x to 0 when the content area is narrower than the bar', () => {
    const bounds = computeFindBarBounds(100);

    expect(bounds.x).toBe(0);
    expect(bounds.width).toBe(FIND_BAR_WIDTH);
  });

  test('y is CHROME_BAR_HEIGHT + FIND_BAR_MARGIN, and height is FIND_BAR_HEIGHT', () => {
    const bounds = computeFindBarBounds(1200);

    expect(bounds.y).toBe(CHROME_BAR_HEIGHT + FIND_BAR_MARGIN);
    expect(bounds.height).toBe(FIND_BAR_HEIGHT);
  });
});
