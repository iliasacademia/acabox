/**
 * `classifyBuildResult` (pure) and `AwaitingSourceView` (rendered through
 * real React — this repo has no `@testing-library/react`; see
 * `share/__tests__/ToolShareHeaderControls.test.tsx` for the same pattern).
 * CSS imports are stubbed by jest config (`moduleNameMapper['\\.css$']`).
 *
 * Both are imported from `miniAppBuildState.tsx`, NOT from `MiniAppViewer.tsx`
 * — that file imports `useComposerRuntime` from `@assistant-ui/react`, which
 * pulls in the ESM-only `assistant-stream` package. That package isn't in
 * jest's `transformIgnorePatterns` whitelist, so importing anything from
 * `MiniAppViewer.tsx` (even an unrelated leaf component re-exported from it)
 * fails the whole suite with `SyntaxError: Unexpected token 'export'`.
 * `miniAppBuildState.tsx` has no such imports, so it renders cleanly here.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { classifyBuildResult, AwaitingSourceView } from '../miniAppBuildState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('classifyBuildResult', () => {
  it('reads ok on success', () => {
    expect(classifyBuildResult({ ok: true, exitCode: 0 })).toEqual({ kind: 'ok' });
  });

  it('reads awaiting-source when main flags the source as missing', () => {
    expect(
      classifyBuildResult({ ok: false, reason: 'source-missing', error: 'src/App.tsx has not been written yet.', exitCode: 1 }),
    ).toEqual({ kind: 'awaiting-source' });
  });

  it('reads error with the reported message for a genuine build failure', () => {
    expect(
      classifyBuildResult({ ok: false, error: '✘ [ERROR] Could not resolve "./Foo"', exitCode: 1 }),
    ).toEqual({ kind: 'error', message: '✘ [ERROR] Could not resolve "./Foo"' });
  });

  it('falls back to a generic message when the build failed with no output', () => {
    expect(classifyBuildResult({ ok: false, exitCode: 1 })).toEqual({
      kind: 'error',
      message: 'Build failed (exit 1) with no output.',
    });
  });
});

describe('AwaitingSourceView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the waiting copy, not a failure', async () => {
    await act(async () => {
      root.render(<AwaitingSourceView since={Date.now()} onRebuild={() => {}} />);
    });

    expect(container.textContent).toContain('Claude is still writing this tool.');
    expect(container.textContent).not.toContain('BUILD FAILED');

    const eyebrow = Array.from(container.querySelectorAll('span')).find((el) => el.textContent?.includes('BEING WRITTEN'));
    expect(eyebrow).toBeTruthy();
  });

  it('calls onRebuild when "Check again" is clicked', async () => {
    const onRebuild = jest.fn();
    await act(async () => {
      root.render(<AwaitingSourceView since={Date.now()} onRebuild={onRebuild} />);
    });

    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Check again'));
    expect(btn).toBeTruthy();

    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it('omits "Open the chat" when onOpenChat is not provided', async () => {
    await act(async () => {
      root.render(<AwaitingSourceView since={Date.now()} onRebuild={() => {}} />);
    });

    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Open the chat'));
    expect(btn).toBeUndefined();
  });

  it('shows and wires "Open the chat" when onOpenChat is provided', async () => {
    const onOpenChat = jest.fn();
    await act(async () => {
      root.render(<AwaitingSourceView since={Date.now()} onRebuild={() => {}} onOpenChat={onOpenChat} />);
    });

    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Open the chat'));
    expect(btn).toBeTruthy();

    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });
});
