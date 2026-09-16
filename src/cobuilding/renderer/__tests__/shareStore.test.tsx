/**
 * Renderer share store: a per-key (`app:<dirName>` / `file:<filePath>`)
 * cache in front of `window.shareAPI.statusApp`/`statusFile`, refetched by a
 * single lazy `onChanged` subscription. Rendered through real React
 * (`react-dom/client` + `act`, matching `toolStatusStore.test.ts` — this repo
 * has no `@testing-library/react` dependency) so the `useSyncExternalStore`
 * wiring is actually exercised, not just the plain functions.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useToolShare,
  useFileShare,
  refreshToolShare,
  __resetShareStoreForTests,
  type ToolShareState,
} from '../shareStore';
import type { PublishedInfo } from '../../shared/share';

// Matches toolStatusStore.test.ts: without this, react-dom logs "The current
// testing environment is not configured to support act(...)" for the updates
// `useSyncExternalStore`'s subscription triggers from inside our `useEffect`,
// and (worse) those updates aren't reliably flushed before `act()` resolves.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ChangedEvent = { dirName?: string; filePath?: string };

function samplePublished(id: string): PublishedInfo {
  return {
    id,
    kind: 'app',
    url: `https://example.workers.dev/a/${id}/`,
    hash: 'a'.repeat(64),
    publishedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Installs a fresh mock `window.shareAPI` and returns handles to drive it. */
function installShareAPI() {
  let onChangedCallback: ((evt: ChangedEvent) => void) | null = null;

  const statusApp = jest.fn(async (dirName: string) => ({
    published: samplePublished(dirName),
    behind: false,
  }));
  const statusFile = jest.fn(async (_filePath: string) => ({
    published: null as PublishedInfo | null,
    behind: false,
  }));
  const onChanged = jest.fn((cb: (evt: ChangedEvent) => void) => {
    onChangedCallback = cb;
    return () => {
      onChangedCallback = null;
    };
  });

  (window as unknown as { shareAPI: unknown }).shareAPI = {
    statusApp,
    statusFile,
    onChanged,
  };

  return {
    statusApp,
    statusFile,
    onChanged,
    fireChanged(evt: ChangedEvent) {
      onChangedCallback?.(evt);
    },
  };
}

function AppProbe({ dirName }: { dirName: string }) {
  const state = useToolShare(dirName);
  return React.createElement('span', { 'data-role': 'state' }, JSON.stringify(state));
}

function FileProbe({ filePath }: { filePath: string | null }) {
  const state = useFileShare(filePath);
  return React.createElement('span', { 'data-role': 'state' }, JSON.stringify(state));
}

function readState(container: HTMLElement, index = 0): ToolShareState {
  const nodes = container.querySelectorAll('[data-role="state"]');
  const node = nodes[index];
  if (!node || !node.textContent) throw new Error('probe did not render a state');
  return JSON.parse(node.textContent) as ToolShareState;
}

/** Lets pending microtasks (the mocked async IPC calls) settle, then flushes React. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('shareStore', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    __resetShareStoreForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    __resetShareStoreForTests();
    delete (window as unknown as { shareAPI?: unknown }).shareAPI;
  });

  it('shows loading on first use, then the fetched state', async () => {
    // A plain `async () => {...}` mock resolves within the same microtask
    // flush that `act()` already drains, which would collapse "loading" and
    // "loaded" into the same observation. Hold the promise open by hand so
    // the loading state is actually observable in between, the way a real
    // IPC round-trip is.
    let resolveStatus: ((v: { published: PublishedInfo | null; behind: boolean }) => void) | null = null;
    const statusApp = jest.fn(
      () =>
        new Promise<{ published: PublishedInfo | null; behind: boolean }>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    (window as unknown as { shareAPI: unknown }).shareAPI = {
      statusApp,
      statusFile: jest.fn(),
      onChanged: jest.fn(() => () => {}),
    };

    await act(async () => {
      root.render(React.createElement(AppProbe, { dirName: 'dnaToolkit' }));
    });

    expect(statusApp).toHaveBeenCalledTimes(1);
    expect(statusApp).toHaveBeenCalledWith('dnaToolkit');
    expect(readState(container).loading).toBe(true);
    expect(readState(container).published).toBeNull();

    await act(async () => {
      resolveStatus!({ published: samplePublished('dnaToolkit'), behind: false });
      await new Promise((r) => setTimeout(r, 0));
    });

    const state = readState(container);
    expect(state.loading).toBe(false);
    expect(state.behind).toBe(false);
    expect(state.published?.id).toBe('dnaToolkit');
  });

  it('refetches the matching key when onChanged fires with its dirName', async () => {
    const api = installShareAPI();

    await act(async () => {
      root.render(React.createElement(AppProbe, { dirName: 'dnaToolkit' }));
    });
    await flush();
    expect(api.statusApp).toHaveBeenCalledTimes(1);

    await act(async () => {
      api.fireChanged({ dirName: 'dnaToolkit' });
    });
    await flush();

    expect(api.statusApp).toHaveBeenCalledTimes(2);
    expect(readState(container).loading).toBe(false);
  });

  it('ignores an onChanged event for a different, never-requested dirName', async () => {
    const api = installShareAPI();

    await act(async () => {
      root.render(React.createElement(AppProbe, { dirName: 'dnaToolkit' }));
    });
    await flush();
    expect(api.statusApp).toHaveBeenCalledTimes(1);

    await act(async () => {
      api.fireChanged({ dirName: 'someOtherTool' });
    });
    await flush();

    // Only the original dirName's fetch ever ran.
    expect(api.statusApp).toHaveBeenCalledTimes(1);
    expect(api.statusApp).not.toHaveBeenCalledWith('someOtherTool');
  });

  it('useFileShare(null) never calls statusFile and stays idle', async () => {
    const api = installShareAPI();

    await act(async () => {
      root.render(React.createElement(FileProbe, { filePath: null }));
    });
    await flush();

    expect(api.statusFile).not.toHaveBeenCalled();
    expect(readState(container)).toEqual({ published: null, behind: false, loading: false });
  });

  it('two hooks on the same dirName share one fetch', async () => {
    const api = installShareAPI();

    function Two() {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(AppProbe, { dirName: 'dnaToolkit' }),
        React.createElement(AppProbe, { dirName: 'dnaToolkit' }),
      );
    }

    await act(async () => {
      root.render(React.createElement(Two));
    });
    await flush();

    expect(api.statusApp).toHaveBeenCalledTimes(1);
    expect(readState(container, 0)).toEqual(readState(container, 1));
  });

  it('subscribes to onChanged exactly once across multiple hooks', async () => {
    const api = installShareAPI();

    function Many() {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(AppProbe, { dirName: 'toolA' }),
        React.createElement(AppProbe, { dirName: 'toolB' }),
        React.createElement(FileProbe, { filePath: '/tmp/a.csv' }),
      );
    }

    await act(async () => {
      root.render(React.createElement(Many));
    });
    await flush();

    expect(api.onChanged).toHaveBeenCalledTimes(1);
  });

  it('a rejected status call resolves to the idle shape and warns once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (window as unknown as { shareAPI: unknown }).shareAPI = {
      statusApp: jest.fn(async () => {
        throw new Error('network down');
      }),
      statusFile: jest.fn(),
      onChanged: jest.fn(() => () => {}),
    };

    await act(async () => {
      root.render(React.createElement(AppProbe, { dirName: 'dnaToolkit' }));
    });
    await flush();

    expect(readState(container)).toEqual({ published: null, behind: false, loading: false });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('refreshToolShare forces a refetch and is reflected by a mounted hook', async () => {
    const api = installShareAPI();

    await act(async () => {
      root.render(React.createElement(AppProbe, { dirName: 'dnaToolkit' }));
    });
    await flush();
    expect(api.statusApp).toHaveBeenCalledTimes(1);

    await act(async () => {
      await refreshToolShare('dnaToolkit');
    });

    expect(api.statusApp).toHaveBeenCalledTimes(2);
    expect(readState(container).loading).toBe(false);
  });
});
