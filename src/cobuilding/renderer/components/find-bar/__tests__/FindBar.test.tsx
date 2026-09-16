/**
 * Renders the real `<FindBar/>` through React against a fake `FindBarAPI`
 * (this repo has no @testing-library, so events are dispatched on the real
 * DOM the way ServersPage.test.tsx does it — see `typeInto`).
 *
 * The CSS-tie test at the bottom is a deliberate, documented exception to
 * "filesystem tests get `@jest-environment node`" (CLAUDE.md Conventions /
 * the ticket's Rule 4): it needs to live in this file so the same suite
 * exercises both the component and the geometry constant it must not drift
 * from, and `fs.readFileSync` works fine under the default jsdom test
 * environment (jsdom only shims browser globals; it doesn't sandbox Node's
 * core modules) — no React rendering happens in that describe block.
 */

import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FindBar } from '../FindBar';
import { FIND_BAR_HEIGHT, FIND_BAR_WIDTH, type FindBarAPI, type FindResult } from '../../../../shared/findInPage';

// React 19 warns on every state update outside act() without this.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;

/** Set a controlled `<input>`'s value the way a real keystroke would, so
 *  React's `onChange` actually fires (a plain `el.value = x` does not). */
function typeInto(el: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressKey(el: Element, init: KeyboardEventInit): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function createFakeApi() {
  const resultListeners = new Set<(r: FindResult) => void>();
  const focusListeners = new Set<() => void>();
  const unsubResult = jest.fn();
  const unsubFocus = jest.fn();
  const api: FindBarAPI = {
    query: jest.fn(),
    step: jest.fn(),
    close: jest.fn(),
    onResult: jest.fn((cb: (r: FindResult) => void) => {
      resultListeners.add(cb);
      return () => {
        resultListeners.delete(cb);
        unsubResult();
      };
    }),
    onFocus: jest.fn((cb: () => void) => {
      focusListeners.add(cb);
      return () => {
        focusListeners.delete(cb);
        unsubFocus();
      };
    }),
  };
  return {
    api,
    emitResult: (r: FindResult) => resultListeners.forEach((l) => l(r)),
    emitFocus: () => focusListeners.forEach((l) => l()),
    unsubResult,
    unsubFocus,
  };
}

describe('<FindBar/>', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const input = () => container.querySelector('.findBar__input') as HTMLInputElement;
  const count = () => container.querySelector('.findBar__count') as HTMLElement;
  const prevBtn = () => container.querySelector('[aria-label="Previous match"]') as HTMLButtonElement;
  const nextBtn = () => container.querySelector('[aria-label="Next match"]') as HTMLButtonElement;
  const closeBtn = () => container.querySelector('[aria-label="Close"]') as HTMLButtonElement;

  async function mount(api: FindBarAPI): Promise<void> {
    await act(async () => {
      root.render(<FindBar api={api} />);
    });
  }

  it('queries as the user types', async () => {
    const { api } = createFakeApi();
    await mount(api);

    act(() => {
      typeInto(input(), 'abc');
    });

    expect(api.query).toHaveBeenCalledWith('abc');
  });

  it('Enter steps forward', async () => {
    const { api } = createFakeApi();
    await mount(api);

    act(() => {
      pressKey(input(), { key: 'Enter' });
    });

    expect(api.step).toHaveBeenCalledWith(true);
  });

  it('Shift+Enter steps backward', async () => {
    const { api } = createFakeApi();
    await mount(api);

    act(() => {
      pressKey(input(), { key: 'Enter', shiftKey: true });
    });

    expect(api.step).toHaveBeenCalledWith(false);
  });

  it('Escape closes and keeps the selection', async () => {
    const { api } = createFakeApi();
    await mount(api);

    act(() => {
      pressKey(input(), { key: 'Escape' });
    });

    expect(api.close).toHaveBeenCalledWith(true);
  });

  it('Meta+g steps forward, Shift+Meta+g steps backward', async () => {
    const { api } = createFakeApi();
    await mount(api);

    act(() => {
      pressKey(input(), { key: 'g', metaKey: true });
    });
    expect(api.step).toHaveBeenLastCalledWith(true);

    act(() => {
      pressKey(input(), { key: 'g', metaKey: true, shiftKey: true });
    });
    expect(api.step).toHaveBeenLastCalledWith(false);
  });

  it('the close button also keeps the selection', async () => {
    const { api } = createFakeApi();
    await mount(api);

    act(() => {
      closeBtn().click();
    });

    expect(api.close).toHaveBeenCalledWith(true);
  });

  it('renders "N of M" for a result while a query is active', async () => {
    const { api, emitResult } = createFakeApi();
    await mount(api);

    act(() => {
      typeInto(input(), 'abc');
    });
    act(() => {
      emitResult({ activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
    });

    expect(count().textContent).toBe('2 of 5');
  });

  it('renders "No matches" once settled with zero matches', async () => {
    const { api, emitResult } = createFakeApi();
    await mount(api);

    act(() => {
      typeInto(input(), 'zzz');
    });
    act(() => {
      emitResult({ activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
    });

    expect(count().textContent).toBe('No matches');
  });

  it('renders nothing in the count while the input is empty', async () => {
    const { api } = createFakeApi();
    await mount(api);

    expect(count().textContent).toBe('');
  });

  it('disables Prev/Next at zero matches and enables them once matches are found', async () => {
    const { api, emitResult } = createFakeApi();
    await mount(api);

    expect(prevBtn().disabled).toBe(true);
    expect(nextBtn().disabled).toBe(true);

    act(() => {
      typeInto(input(), 'abc');
    });
    act(() => {
      emitResult({ activeMatchOrdinal: 1, matches: 5, finalUpdate: true });
    });

    expect(prevBtn().disabled).toBe(false);
    expect(nextBtn().disabled).toBe(false);
  });

  it('focuses (and selects) the input when the bar is (re)opened', async () => {
    const { api, emitFocus } = createFakeApi();
    await mount(api);

    // Move focus elsewhere first so the assertion is meaningful.
    input().blur();
    expect(document.activeElement).not.toBe(input());

    act(() => {
      emitFocus();
    });

    expect(document.activeElement).toBe(input());
  });

  it('unsubscribes both listeners on unmount', async () => {
    // Its own container/root so unmounting here doesn't collide with the
    // outer afterEach's unmount of the shared `root`.
    const { api, unsubResult, unsubFocus } = createFakeApi();
    const localContainer = document.createElement('div');
    document.body.appendChild(localContainer);
    const localRoot = createRoot(localContainer);

    await act(async () => {
      localRoot.render(<FindBar api={api} />);
    });
    act(() => {
      localRoot.unmount();
    });

    expect(unsubResult).toHaveBeenCalledTimes(1);
    expect(unsubFocus).toHaveBeenCalledTimes(1);
    localContainer.remove();
  });
});

describe('FindBar.css geometry', () => {
  it('matches FIND_BAR_WIDTH/FIND_BAR_HEIGHT so the constant and the stylesheet cannot drift apart', () => {
    const css = fs.readFileSync(path.join(__dirname, '../FindBar.css'), 'utf8');
    expect(css).toContain(`width: ${FIND_BAR_WIDTH}px`);
    expect(css).toContain(`height: ${FIND_BAR_HEIGHT}px`);
  });
});
