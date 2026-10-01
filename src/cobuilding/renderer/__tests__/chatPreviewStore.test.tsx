import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  __resetChatPreviewStoreForTests,
  formatPreviewLine,
  useChatPreview,
} from '../chatPreviewStore';

/**
 * Renderer store of chat previews (see docs/design/chat-search.md). Driven
 * through the real preload-shaped bridge (mocked at `window`), following the
 * pattern in `chatActivityStore.test.tsx`: one initial fetch, one re-fetch on
 * `sessions:changed`, nothing polled.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let previews: jest.Mock;
let sessionsChanged: () => void;
let container: HTMLDivElement;
let root: Root;

function installBridge(rows: ChatPreviewData[]): void {
  previews = jest.fn(() => Promise.resolve(rows));
  (window as any).sessionsAPI = {
    previews,
    onSessionsChanged: (cb: () => void) => { sessionsChanged = cb; return () => {}; },
  };
}

beforeEach(() => {
  __resetChatPreviewStoreForTests();
  installBridge([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('formatPreviewLine', () => {
  it('joins both halves with a middle dot', () => {
    const line = formatPreviewLine({ sessionId: 's', userText: 'hi', assistantText: 'hello' });
    expect(line).toBe('You: hi · ▸ hello');
  });

  it('renders the user half alone when there is no assistant reply yet', () => {
    expect(formatPreviewLine({ sessionId: 's', userText: 'hi', assistantText: '' })).toBe('You: hi');
  });

  it('renders the assistant half alone when there is no user text', () => {
    expect(formatPreviewLine({ sessionId: 's', userText: '', assistantText: 'hello' })).toBe('▸ hello');
  });

  it('is empty for null (no preview yet)', () => {
    expect(formatPreviewLine(null)).toBe('');
  });
});

function Preview({ sessionId }: { sessionId: string }) {
  const preview = useChatPreview(sessionId);
  return <span>{formatPreviewLine(preview)}</span>;
}

describe('useChatPreview', () => {
  it('renders the preview once previews() resolves', async () => {
    installBridge([{ sessionId: 's1', userText: 'hi', assistantText: 'hello' }]);
    await act(async () => { root.render(<Preview sessionId="s1" />); });
    expect(container.textContent).toBe('You: hi · ▸ hello');
  });

  it('renders nothing for a chat with no preview yet', async () => {
    installBridge([]);
    await act(async () => { root.render(<Preview sessionId="unseen" />); });
    expect(container.textContent).toBe('');
  });

  it('re-reads on sessions:changed, and the new value renders', async () => {
    installBridge([{ sessionId: 's1', userText: 'hi', assistantText: 'hello' }]);
    await act(async () => { root.render(<Preview sessionId="s1" />); });
    expect(container.textContent).toBe('You: hi · ▸ hello');

    previews.mockImplementation(() => Promise.resolve([{ sessionId: 's1', userText: 'updated', assistantText: '' }]));
    await act(async () => { sessionsChanged(); });
    expect(previews).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('You: updated');
  });
});
