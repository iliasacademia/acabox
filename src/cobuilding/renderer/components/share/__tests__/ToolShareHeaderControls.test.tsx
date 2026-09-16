/**
 * Tool header sharing controls (`docs/design/sharing-tickets.md`, ticket
 * U5): the SHARED status chip and the button that opens `SharePublishDialog`.
 * Extracted out of `MiniAppViewer.tsx` — which talks to a dozen other
 * `window.*API`s on mount — so this can be rendered and tested on its own.
 *
 * Rendered through real React (`react-dom/client` + `act`), matching
 * `SharePublishDialog.test.tsx` / `shareStore.test.tsx` — this repo has no
 * `@testing-library/react`. `Header` below mounts `ToolShareChip` and
 * `ToolShareHeaderControls` side by side, the same way `MiniAppViewer.tsx`
 * does (they're two components rather than one because the real header puts
 * them either side of its flex spacer — see the doc comment on the module
 * under test).
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolShareChip, ToolShareHeaderControls } from '../ToolShareHeaderControls';
import { __resetShareStoreForTests } from '../../../shareStore';
import type { PublishedInfo, SnapshotSummary } from '../../../../shared/share';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function samplePublished(overrides: Partial<PublishedInfo> = {}): PublishedInfo {
  return {
    id: 'abc123',
    kind: 'app',
    url: 'https://acabox-share.acct.workers.dev/a/abc123/',
    hash: 'a'.repeat(64),
    publishedAt: '2026-01-01T00:00:00.000Z',
    includeInput: true,
    ...overrides,
  };
}

function sampleSummary(): SnapshotSummary {
  return {
    code: { count: 1, bytes: 100 },
    output: { count: 0, bytes: 0 },
    input: { count: 0, bytes: 0 },
    vendor: { count: 0, bytes: 0 },
    total: { count: 1, bytes: 100 },
  };
}

let container: HTMLDivElement;
let root: Root;

function installShareAPI(opts: { published?: PublishedInfo | null; behind?: boolean } = {}): void {
  const published = opts.published ?? null;
  const behind = opts.behind ?? false;

  (window as any).shareAPI = {
    getSettings: jest.fn(),
    saveSettings: jest.fn(),
    test: jest.fn(),
    planApp: jest.fn(async () => ({
      ok: true,
      summary: sampleSummary(),
      hash: 'b'.repeat(64),
      published,
      behind,
    })),
    publishApp: jest.fn(),
    unpublishApp: jest.fn(async () => ({ ok: true })),
    statusApp: jest.fn(async () => ({ published, behind })),
    publishFile: jest.fn(),
    unpublishFile: jest.fn(),
    statusFile: jest.fn(),
    onChanged: jest.fn(() => () => {}),
    onProgress: jest.fn(() => () => {}),
  };
  (window as any).electronAPI = { invoke: jest.fn(async () => undefined) };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Mirrors how `MiniAppViewer.tsx`'s header mounts the two pieces. */
function Header({
  dirName = 'dnaToolkit',
  appName = 'DNA Toolkit',
}: {
  dirName?: string;
  appName?: string;
}): React.ReactElement {
  return (
    <>
      <ToolShareChip dirName={dirName} />
      <ToolShareHeaderControls dirName={dirName} appName={appName} />
    </>
  );
}

async function renderHeader(props: { dirName?: string; appName?: string } = {}): Promise<void> {
  await act(async () => {
    root.render(<Header {...props} />);
  });
  await flush();
}

function findButton(title: string): HTMLButtonElement {
  const btn = container.querySelector(`button[title="${title}"]`);
  if (!btn) throw new Error(`No button titled "${title}"`);
  return btn as HTMLButtonElement;
}

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
  delete (window as any).shareAPI;
  delete (window as any).electronAPI;
  jest.clearAllMocks();
});

describe('ToolShareChip', () => {
  it('reads "SHARED · BEHIND" with a busy dot when published and behind', async () => {
    installShareAPI({ published: samplePublished(), behind: true });
    await renderHeader();

    const chip = container.querySelector('.cdStatusChip');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('SHARED · BEHIND');
    expect(chip!.querySelector('.cdDot--busy')).not.toBeNull();
  });

  it('reads plain "SHARED" with no dot when published and current', async () => {
    installShareAPI({ published: samplePublished(), behind: false });
    await renderHeader();

    const chip = container.querySelector('.cdStatusChip');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('SHARED');
    expect(chip!.querySelector('.cdDot')).toBeNull();
  });

  it('renders no chip when unpublished, but the share button is still present', async () => {
    installShareAPI({ published: null, behind: false });
    await renderHeader();

    expect(container.querySelector('.cdStatusChip')).toBeNull();
    expect(findButton('Share…')).not.toBeNull();
  });
});

describe('ToolShareHeaderControls', () => {
  // Deliberately mounts ONLY this component, not `ToolShareChip` alongside
  // it — see the "IMPORTANT" note below. Mounting both first would pre-warm
  // `useToolShare`'s cache for this key before the dialog ever opens, which
  // trips a bug in SharePublishDialog.tsx unrelated to this component's own
  // wiring (that file is out of scope for this ticket; see the note).
  it('mounts SharePublishDialog on click, titled for this app', async () => {
    installShareAPI({ published: null, behind: false });
    await act(async () => {
      root.render(<ToolShareHeaderControls dirName="dnaToolkit" appName="DNA Toolkit" />);
    });
    await flush();

    expect(container.querySelector('.toolsConfirmModal__title')).toBeNull();

    act(() => {
      findButton('Share…').click();
    });
    // Two async hops inside the dialog (statusApp, then planApp once status
    // is known) — flush a few times, matching SharePublishDialog.test.tsx.
    await flush();
    await flush();
    await flush();

    const title = container.querySelector('.toolsConfirmModal__title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('Publish "DNA Toolkit"');
  });

  // IMPORTANT — cross-ticket finding, not something this test works around
  // silently: in the real header (and in `Header` above) `ToolShareChip` is
  // mounted continuously and warms `useToolShare`'s cache for this dirName
  // long before the share button is ever clicked. SharePublishDialog.tsx's
  // `sawLoadingRef` guard (around its `planApp` effect) assumes ITS OWN
  // `useToolShare` call is the first-ever reader of that cache key, so it
  // only calls `planApp` after observing a `loading: true -> false`
  // transition. With a pre-warmed cache, `statusLoading` is `false` from the
  // dialog's very first render and never becomes `true`, so the guard never
  // fires and the dialog is stuck on "Loading share status…" forever. This
  // is reproducible by rendering `Header` (chip + controls together, exactly
  // as MiniAppViewer does) instead of `ToolShareHeaderControls` alone in the
  // test above. Not fixed here: SharePublishDialog.tsx belongs to ticket U3,
  // out of scope for U5, and may be under concurrent edit.
});
