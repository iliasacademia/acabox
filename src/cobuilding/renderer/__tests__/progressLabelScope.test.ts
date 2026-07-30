/**
 * The processing label is per-thread (B15).
 *
 * It used to be one module-global string. The stall watchdog writes
 * RECONNECTING from a specific thread's run, so with parallel chats — the
 * workflow the streaming fix exists to serve — a stalled BACKGROUND thread
 * would paint RECONNECTING… onto the healthy thread the user was looking at.
 *
 * Rendered through real React so `useSyncExternalStore` subscription and
 * re-render behaviour is exercised, not just the module's internal map.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  setProcessingLabel,
  resetProgress,
  useProcessingLabel,
  RECONNECTING_LABEL,
} from '../progressStore';

/** Renders both threads' labels and reports what each one currently sees. */
function mountProbe(ids: (string | undefined)[]) {
  const seen: Record<string, string | null> = {};
  const Probe: React.FC = () => {
    ids.forEach((id, i) => {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      seen[String(id ?? `undefined-${i}`)] = useProcessingLabel(id);
    });
    return null;
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { seen, root, container, Probe };
}

afterEach(() => { resetProgress(); });

it('a label set on one thread is invisible to another, and clearing is independent', async () => {
  const { seen, root, Probe } = mountProbe(['thread-a', 'thread-b', undefined]);
  await act(async () => { root.render(React.createElement(Probe)); });

  await act(async () => { setProcessingLabel('thread-a', RECONNECTING_LABEL); });
  expect(seen['thread-a']).toBe(RECONNECTING_LABEL);
  expect(seen['thread-b']).toBeNull();
  // A surface with no remoteId yet must not borrow someone else's label.
  expect(seen['undefined-2']).toBeNull();

  await act(async () => { setProcessingLabel('thread-b', 'Indexing'); });
  expect(seen['thread-a']).toBe(RECONNECTING_LABEL);
  expect(seen['thread-b']).toBe('Indexing');

  await act(async () => { setProcessingLabel('thread-a', null); });
  expect(seen['thread-a']).toBeNull();
  expect(seen['thread-b']).toBe('Indexing');

  await act(async () => { root.unmount(); });
});

it('resetProgress(threadId) clears only that thread', async () => {
  const { seen, root, Probe } = mountProbe(['thread-a', 'thread-b']);
  await act(async () => { root.render(React.createElement(Probe)); });

  await act(async () => {
    setProcessingLabel('thread-a', 'Indexing');
    setProcessingLabel('thread-b', RECONNECTING_LABEL);
  });
  await act(async () => { resetProgress('thread-a'); });

  expect(seen['thread-a']).toBeNull();
  expect(seen['thread-b']).toBe(RECONNECTING_LABEL);

  await act(async () => { root.unmount(); });
});
