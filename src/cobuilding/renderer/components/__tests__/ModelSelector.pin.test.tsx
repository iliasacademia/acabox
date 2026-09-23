import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The picker must tell the truth about which model a chat will actually use.
 *
 * Model and effort are pinned to a conversation on its first turn — main
 * records what the SDK resolved and from then on `chat:send` prefers the pin
 * over whatever the picker says (`main/index.ts`, `effectiveModel`). Until
 * this change the picker stayed fully interactive in a pinned chat, so
 * choosing a different model there changed a global default and did nothing
 * at all to the conversation in front of you — which is what made a pinned
 * chat read as "the model control is broken".
 *
 * These cases drive the real component against a session row that does, and
 * does not, carry a pin. The load-bearing one is `shows the PINNED model, not
 * the picker's`: a chip that rendered the local selection would look right in
 * every test where the two happen to agree.
 */

jest.mock('@assistant-ui/react', () => ({
  __esModule: true,
  useAssistantRuntime: () => ({ registerModelContextProvider: () => () => {} }),
  // Two selectors are read: the thread-list item's remoteId and the thread's
  // isRunning. Distinguished by probing the selector with a shaped state.
  useAuiState: (selector: (s: any) => unknown) =>
    selector({
      threadListItem: { remoteId: (globalThis as any).__remoteId },
      thread: { isRunning: false },
    }),
}));

import { ModelSelector } from '../ModelSelector';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** One session row, as `sessions:get` returns it. */
function sessionIs(row: Record<string, unknown> | null): void {
  (window as any).sessionsAPI = { get: jest.fn(async () => row) };
}

async function render(): Promise<void> {
  await act(async () => { root.render(<ModelSelector />); });
}

const trigger = () => container.querySelector('.modelSelectorTrigger') as HTMLButtonElement | null;

beforeEach(() => {
  (globalThis as any).__remoteId = 'session-1';
  localStorage.clear();
  // A selection that differs from every pin used below, so a chip rendering
  // the local choice instead of the pin is always visible as a wrong label.
  localStorage.setItem('selectedModel', 'claude-opus-5');
  localStorage.setItem('selectedEffort', 'high');
  (window as any).modelsAPI = { list: jest.fn(async () => ({ models: [] })) };
  sessionIs(null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  jest.clearAllMocks();
});

describe('<ModelSelector/> and the per-chat pin', () => {
  it('stays interactive in a chat with no pin yet', async () => {
    sessionIs({ id: 'session-1', model: null, effort: null });
    await render();
    expect(trigger()).not.toBeNull();
    expect(trigger()!.className).not.toContain('modelSelectorTrigger--pinned');
    expect(trigger()!.disabled).toBe(false);
    expect(container.textContent).toContain('Opus 5');
  });

  it('stays interactive on a brand-new thread that has no session row', async () => {
    (globalThis as any).__remoteId = undefined;
    await render();
    expect(trigger()!.disabled).toBe(false);
    // No id means nothing to look up — the row must not be fetched at all.
    expect((window as any).sessionsAPI.get).not.toHaveBeenCalled();
  });

  it('locks once the chat is pinned, and says why', async () => {
    sessionIs({ id: 'session-1', model: 'claude-haiku-4-5', effort: 'low' });
    await render();
    expect(trigger()!.className).toContain('modelSelectorTrigger--pinned');
    expect(trigger()!.disabled).toBe(true);
    expect(trigger()!.getAttribute('title')).toContain('Start a new chat');
  });

  it('shows the PINNED model, not the picker’s current selection', async () => {
    sessionIs({ id: 'session-1', model: 'claude-haiku-4-5', effort: 'low' });
    await render();
    expect(container.textContent).toContain('Haiku 4.5');
    expect(container.textContent).toContain('Low');
    // The localStorage selection is Opus 5 / High. Either appearing means the
    // chip is rendering the picker's state rather than the conversation's.
    expect(container.textContent).not.toContain('Opus 5');
    expect(container.textContent).not.toContain('High');
  });

  it('renders a pin that recorded a model but no effort', async () => {
    sessionIs({ id: 'session-1', model: 'claude-opus-5', effort: null });
    await render();
    expect(trigger()!.className).toContain('modelSelectorTrigger--pinned');
    expect(container.textContent).toContain('Opus 5');
    expect(container.textContent).not.toContain('High');
  });

  it('shows a resolved snapshot id verbatim rather than a wrong label', async () => {
    // The pin is whatever the SDK's init event resolved, which can be a dated
    // snapshot the picker's roster has never heard of. Naming it by the
    // nearest roster entry would claim a model the chat is not running.
    sessionIs({ id: 'session-1', model: 'claude-sonnet-5-20260801', effort: 'medium' });
    await render();
    expect(container.textContent).toContain('claude-sonnet-5-20260801');
    expect(container.textContent).not.toContain('Sonnet 5 ');
  });

  it('falls back to interactive when the session lookup fails', async () => {
    (window as any).sessionsAPI = { get: jest.fn(async () => { throw new Error('ipc down'); }) };
    await render();
    // A failed read must not lock the control — that would strand the user
    // with no picker anywhere for reasons they cannot see.
    expect(trigger()!.disabled).toBe(false);
  });
});
