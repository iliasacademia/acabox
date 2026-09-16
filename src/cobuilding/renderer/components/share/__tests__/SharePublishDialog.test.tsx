/**
 * Publish dialog (`docs/design/sharing-tickets.md`, ticket U3). Rendered
 * through real React (`react-dom/client` + `act`, matching
 * `SharingSettings.test.tsx` / `shareStore.test.tsx` — this repo has no
 * `@testing-library/react`), with a mocked `window.shareAPI` covering both
 * the `useToolShare` hook's own calls (`statusApp`, `onChanged`) and the
 * dialog's direct calls (`planApp`, `publishApp`, `unpublishApp`,
 * `onProgress`).
 *
 * `__resetShareStoreForTests` is called in `beforeEach`/`afterEach` because
 * `shareStore.ts` is a module-level cache keyed by dirName — without
 * resetting it, a later test's `useToolShare('dnaToolkit')` would silently
 * return a previous test's cached state instead of calling `statusApp`.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SharePublishDialog } from '../SharePublishDialog';
import { __resetShareStoreForTests, refreshToolShare } from '../../../shareStore';
import type { PublishedInfo, SnapshotSummary } from '../../../../shared/share';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ProgressEvent = { dirName: string; uploaded: number; total: number };
type ProgressCallback = (p: ProgressEvent) => void;

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

/** Deliberately clean numbers so `formatBytes` output is unambiguous:
 *  100 B, 2.0 KB, 4.0 KB, 50 KB, 56 KB (total = sum of the other four). */
function sampleSummary(): SnapshotSummary {
  return {
    code: { count: 1, bytes: 100 },
    output: { count: 2, bytes: 2000 },
    input: { count: 4, bytes: 4000 },
    vendor: { count: 5, bytes: 50000 },
    total: { count: 12, bytes: 56100 },
  };
}

let container: HTMLDivElement;
let root: Root;

let statusAppMock: jest.Mock;
let planAppMock: jest.Mock;
let publishAppMock: jest.Mock;
let unpublishAppMock: jest.Mock;
let progressCallback: ProgressCallback | null;

function installShareAPI(opts: { published?: PublishedInfo | null; behind?: boolean } = {}): void {
  const published = opts.published ?? null;
  const behind = opts.behind ?? false;

  statusAppMock = jest.fn(async () => ({ published, behind }));
  planAppMock = jest.fn(async (_dirName: string, _includeInput: boolean) => ({
    ok: true,
    summary: sampleSummary(),
    hash: 'b'.repeat(64),
    published,
    behind,
  }));
  publishAppMock = jest.fn();
  unpublishAppMock = jest.fn(async () => ({ ok: true }));
  progressCallback = null;

  (window as any).shareAPI = {
    getSettings: jest.fn(),
    saveSettings: jest.fn(),
    test: jest.fn(),
    planApp: planAppMock,
    publishApp: publishAppMock,
    unpublishApp: unpublishAppMock,
    statusApp: statusAppMock,
    publishFile: jest.fn(),
    unpublishFile: jest.fn(),
    statusFile: jest.fn(),
    onChanged: jest.fn(() => () => {}),
    onProgress: jest.fn((cb: ProgressCallback) => {
      progressCallback = cb;
      return () => {
        progressCallback = null;
      };
    }),
  };
  (window as any).electronAPI = { invoke: jest.fn(async () => undefined) };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function findButton(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button with text "${text}"`);
  return btn as HTMLButtonElement;
}

function queryButton(text: string): HTMLButtonElement | null {
  return (
    (Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement) ?? null
  );
}

function rowText(label: string): string {
  const rows = Array.from(container.querySelectorAll('.sharePublishDialog__row'));
  const row = rows.find((r) => r.querySelector('.sharePublishDialog__rowLabel')?.textContent === label);
  if (!row) throw new Error(`No row labelled "${label}"`);
  return row.querySelector('.sharePublishDialog__rowValue')?.textContent ?? '';
}

async function renderDialog(
  props: { dirName?: string; appName?: string; onClose?: () => void } = {},
): Promise<jest.Mock> {
  const onClose = (props.onClose as jest.Mock) ?? jest.fn();
  await act(async () => {
    root.render(
      <SharePublishDialog
        dirName={props.dirName ?? 'dnaToolkit'}
        appName={props.appName ?? 'DNA Toolkit'}
        onClose={onClose}
      />,
    );
  });
  // Two async hops (statusApp, then planApp once status is known) — flush a
  // few times so both settle regardless of exact effect-scheduling timing.
  await flush();
  await flush();
  await flush();
  return onClose;
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

describe('SharePublishDialog', () => {
  it('plans exactly once on a cold cache (no optimistic plan before the status is known)', async () => {
    installShareAPI();
    await renderDialog();
    expect(statusAppMock).toHaveBeenCalledTimes(1);
    expect(planAppMock).toHaveBeenCalledTimes(1);
    expect(planAppMock).toHaveBeenCalledWith('dnaToolkit', true);
  });

  it('still plans when a sibling SHARED chip has already warmed the share cache (U5 regression)', async () => {
    // The real tool header mounts ToolShareChip before the user ever clicks
    // Share, so the store already holds a settled answer for this key and no
    // loading→settled transition will be observed by the dialog. It must plan
    // anyway, using the stored `includeInput` default.
    installShareAPI({ published: samplePublished({ includeInput: false }), behind: true });
    await act(async () => {
      await refreshToolShare('dnaToolkit');
    });
    expect(statusAppMock).toHaveBeenCalledTimes(1);
    await renderDialog();
    expect(planAppMock).toHaveBeenCalledTimes(1);
    expect(planAppMock).toHaveBeenCalledWith('dnaToolkit', false);
    expect(container.textContent).toContain('Refresh shared copy');
    expect(rowText('Code')).toMatch(/\d+ files? · /);
  });

  it('renders the five summary rows with formatted sizes', async () => {
    installShareAPI({ published: null, behind: false });
    await renderDialog();

    expect(planAppMock).toHaveBeenCalledWith('dnaToolkit', true);
    expect(rowText('Code')).toBe('1 file · 100 B');
    expect(rowText('Output')).toBe('2 files · 2.0 KB');
    expect(rowText('Input')).toBe('4 files · 4.0 KB');
    expect(rowText('Vendor')).toBe('5 files · 50 KB');
    expect(rowText('Total')).toBe('12 files · 56 KB');
    expect(container.textContent).toContain('Publish "DNA Toolkit"');
  });

  it('unchecking "Include input data" re-plans with includeInput: false', async () => {
    installShareAPI({ published: null, behind: false });
    await renderDialog();
    expect(planAppMock).toHaveBeenCalledTimes(1);

    const checkbox = container.querySelector('.sharePublishDialog__checkbox input') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    act(() => {
      checkbox.click();
    });
    await flush();

    expect(planAppMock).toHaveBeenCalledTimes(2);
    expect(planAppMock).toHaveBeenLastCalledWith('dnaToolkit', false);
    expect(rowText('Input')).toBe('not included');
  });

  it('shows upload progress from onProgress, then the URL and a Copy link button on success', async () => {
    installShareAPI({ published: null, behind: false });
    let resolvePublish: ((v: unknown) => void) | null = null;
    publishAppMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePublish = resolve;
        }),
    );
    await renderDialog();

    act(() => {
      findButton('Publish').click();
    });
    await flush();

    expect(publishAppMock).toHaveBeenCalledWith('dnaToolkit', { includeInput: true });
    expect(progressCallback).not.toBeNull();

    act(() => {
      progressCallback!({ dirName: 'dnaToolkit', uploaded: 1, total: 3 });
    });
    expect(container.textContent).toContain('Uploading 1 of 3 files…');

    const published = samplePublished();
    await act(async () => {
      resolvePublish!({ ok: true, published, unchanged: false });
      await new Promise((r) => setTimeout(r, 0));
    });

    const urlInput = container.querySelector('.sharePublishDialog__urlInput') as HTMLInputElement | null;
    expect(urlInput).not.toBeNull();
    expect(urlInput!.value).toBe(published.url);
    expect(queryButton('Copy link')).not.toBeNull();
  });

  it('shows the error inline and keeps the dialog mounted when publish fails', async () => {
    installShareAPI({ published: null, behind: false });
    publishAppMock.mockResolvedValue({ ok: false, error: 'Upload failed: disk full' });
    const onClose = jest.fn();
    await renderDialog({ onClose });

    act(() => {
      findButton('Publish').click();
    });
    await flush();

    expect(container.textContent).toContain('Upload failed: disk full');
    expect(onClose).not.toHaveBeenCalled();
    // Still fully rendered, not replaced by an empty/error-only view.
    expect(container.textContent).toContain('Publish "DNA Toolkit"');
  });

  it('Unpublish requires a second click before unpublishApp is called', async () => {
    installShareAPI({ published: samplePublished(), behind: false });
    await renderDialog();

    const unpublishBtn = findButton('Unpublish');
    act(() => {
      unpublishBtn.click();
    });
    expect(unpublishAppMock).not.toHaveBeenCalled();
    expect(findButton('Unpublish — are you sure?')).toBeTruthy();

    act(() => {
      findButton('Unpublish — are you sure?').click();
    });
    await flush();

    expect(unpublishAppMock).toHaveBeenCalledWith('dnaToolkit');
  });

  it('disables the primary button and reads "up to date" when published and not behind', async () => {
    installShareAPI({ published: samplePublished(), behind: false });
    await renderDialog();

    expect(container.textContent).toContain('Shared copy is up to date');
    expect(findButton('Refresh').disabled).toBe(true);
  });
});
