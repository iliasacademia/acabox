/**
 * `chat-link-chip.tsx` deliberately imports only `react`, `MSymbol`, and
 * `shared/chatLinks` (no `@assistant-ui/react`), so — like
 * `ToolShareHeaderControls.test.tsx` — it is rendered through real React
 * (`react-dom/client` + `act`) rather than any assistant-ui test harness.
 * This repo has no `@testing-library/react`.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ChatLinkChip,
  TextWithChatLinks,
  OPEN_CHAT_EVENT,
  __resetChatLinkCacheForTests,
} from '../chat-link-chip';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

let container: HTMLDivElement;
let root: Root;

/** Installs `window.sessionsAPI` with a stubbed `get`, and returns the mock. */
function installSessionsAPI(
  resolve: (id: string) => Promise<{ id: string; title: string } | undefined | null>,
): jest.Mock {
  const get = jest.fn(resolve);
  (window as any).sessionsAPI = { get };
  return get;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  __resetChatLinkCacheForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  __resetChatLinkCacheForTests();
  delete (window as any).sessionsAPI;
  jest.clearAllMocks();
});

function findChip(): HTMLButtonElement {
  const btn = container.querySelector('button.cdChatLinkChip');
  if (!btn) throw new Error('No chat link chip rendered');
  return btn as HTMLButtonElement;
}

describe('ChatLinkChip', () => {
  it('shows the chat title once the lookup resolves', async () => {
    installSessionsAPI(async (id) => ({ id, title: 'Spend Explorer' }));
    await act(async () => {
      root.render(<ChatLinkChip sessionId={SESSION_ID} />);
    });
    await flush();

    const chip = findChip();
    expect(chip.querySelector('.cdChatLinkChip__label')!.textContent).toBe('Spend Explorer');
    expect(chip.classList.contains('cdChatLinkChip--missing')).toBe(false);
  });

  it('shows "Deleted chat" with the missing class when no chat is found', async () => {
    installSessionsAPI(async () => undefined);
    await act(async () => {
      root.render(<ChatLinkChip sessionId={SESSION_ID} />);
    });
    await flush();

    const chip = findChip();
    expect(chip.querySelector('.cdChatLinkChip__label')!.textContent).toBe('Deleted chat');
    expect(chip.classList.contains('cdChatLinkChip--missing')).toBe(true);
  });

  it('caches the lookup: two chips for the same chat call sessionsAPI.get once', async () => {
    const get = installSessionsAPI(async (id) => ({ id, title: 'Shared chat' }));
    await act(async () => {
      root.render(
        <>
          <ChatLinkChip sessionId={SESSION_ID} />
          <ChatLinkChip sessionId={SESSION_ID} />
        </>,
      );
    });
    await flush();

    expect(get).toHaveBeenCalledTimes(1);
    const chips = container.querySelectorAll('button.cdChatLinkChip');
    expect(chips.length).toBe(2);
    chips.forEach((chip) => {
      expect(chip.querySelector('.cdChatLinkChip__label')!.textContent).toBe('Shared chat');
    });
  });

  it('dispatches cd:open-chat with the session id on click', async () => {
    installSessionsAPI(async (id) => ({ id, title: 'Click target' }));
    await act(async () => {
      root.render(<ChatLinkChip sessionId={SESSION_ID} />);
    });
    await flush();

    const events: CustomEvent<{ sessionId: string }>[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent<{ sessionId: string }>);
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    try {
      act(() => {
        findChip().click();
      });
    } finally {
      window.removeEventListener(OPEN_CHAT_EVENT, handler);
    }

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ sessionId: SESSION_ID });
  });

  it('dispatches cd:open-chat on click even for a missing chat', async () => {
    installSessionsAPI(async () => null);
    await act(async () => {
      root.render(<ChatLinkChip sessionId={SESSION_ID} />);
    });
    await flush();

    const events: CustomEvent<{ sessionId: string }>[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent<{ sessionId: string }>);
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    try {
      act(() => {
        findChip().click();
      });
    } finally {
      window.removeEventListener(OPEN_CHAT_EVENT, handler);
    }

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ sessionId: SESSION_ID });
  });

  it('sets the title attribute to the full chat link', async () => {
    installSessionsAPI(async (id) => ({ id, title: 'Anything' }));
    await act(async () => {
      root.render(<ChatLinkChip sessionId={SESSION_ID} />);
    });
    await flush();

    expect(findChip().getAttribute('title')).toBe(`acabox://chat/${SESSION_ID}`);
  });
});

describe('TextWithChatLinks', () => {
  it('renders text runs and exactly one chip for a link embedded in text', async () => {
    installSessionsAPI(async (id) => ({ id, title: 'Referenced chat' }));
    await act(async () => {
      root.render(<TextWithChatLinks text={`see acabox://chat/${SESSION_ID} now`} />);
    });
    await flush();

    const chips = container.querySelectorAll('button.cdChatLinkChip');
    expect(chips.length).toBe(1);
    expect(container.textContent).toContain('see ');
    expect(container.textContent).toContain(' now');
    expect(container.textContent).toContain('Referenced chat');
  });

  it('renders plain text unchanged with no chip', async () => {
    await act(async () => {
      root.render(<TextWithChatLinks text="just a plain message, no links" />);
    });
    await flush();

    expect(container.querySelector('button.cdChatLinkChip')).toBeNull();
    expect(container.textContent).toBe('just a plain message, no links');
  });
});
