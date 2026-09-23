import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  __resetChatActivityStoreForTests,
  chatMarkFor,
  reportViewingChat,
  useActiveChatCount,
  useHasUnreadChats,
} from '../chatActivityStore';
import { ChatMarkDot } from '../components/command-desk/ChatMarkDot';

/**
 * The renderer half of chat activity: one store every chat list reads, and
 * the registry that tells main which conversation is on screen.
 *
 * Driven through the real preload-shaped bridge (mocked at `window`), so a
 * push from main, a re-read on `sessions:changed`, and the IPC the renderer
 * sends back are all exercised the way the app uses them.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Snapshot = { activeIds: string[]; unreadIds: string[] };

let push: (s: Snapshot) => void;
let sessionsChanged: () => void;
let getActivity: jest.Mock;
let setViewing: jest.Mock;
let container: HTMLDivElement;
let root: Root;

function installBridge(first: Snapshot | Promise<Snapshot>): void {
  getActivity = jest.fn(() => Promise.resolve(first));
  setViewing = jest.fn();
  (window as any).sessionsAPI = {
    getActivity,
    setViewing,
    onActivityChanged: (cb: (s: Snapshot) => void) => { push = cb; return () => {}; },
    onSessionsChanged: (cb: () => void) => { sessionsChanged = cb; return () => {}; },
  };
}

beforeEach(() => {
  __resetChatActivityStoreForTests();
  installBridge({ activeIds: [], unreadIds: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

const mark = (id: string) => container.querySelector(`[data-row="${id}"] .cdChatMark`);

function Rows({ ids }: { ids: string[] }) {
  return (
    <>
      {ids.map((id) => (
        <div key={id} data-row={id}><ChatMarkDot sessionId={id} /></div>
      ))}
    </>
  );
}

describe('chatMarkFor', () => {
  const activity = { active: new Set(['a', 'both']), unread: new Set(['u', 'both']) };
  it('working outranks unread — news is only news once the turn ends', () => {
    expect(chatMarkFor(activity, 'both')).toBe('active');
  });
  it('maps each state, and nothing for a quiet or missing id', () => {
    expect(chatMarkFor(activity, 'a')).toBe('active');
    expect(chatMarkFor(activity, 'u')).toBe('unread');
    expect(chatMarkFor(activity, 'quiet')).toBeNull();
    expect(chatMarkFor(activity, undefined)).toBeNull();
    expect(chatMarkFor(activity, '')).toBeNull();
  });
});

describe('<ChatMarkDot/> fed by the store', () => {
  it('draws the initial snapshot, then follows pushes from main', async () => {
    installBridge({ activeIds: ['a'], unreadIds: ['u'] });
    await act(async () => { root.render(<Rows ids={['a', 'u', 'q']} />); });

    expect(mark('a')!.className).toContain('cdDot--busy');
    expect(mark('a')!.className).toContain('cdDot--pulse');
    expect(mark('u')!.className).toContain('cdDot--unread');
    // A quiet chat renders NOTHING — a placeholder would make every row look marked.
    expect(mark('q')).toBeNull();

    // The turn ends while nobody is looking: amber becomes blue.
    await act(async () => { push({ activeIds: [], unreadIds: ['u', 'a'] }); });
    expect(mark('a')!.className).toContain('cdDot--unread');

    // Read: the mark goes away entirely.
    await act(async () => { push({ activeIds: [], unreadIds: [] }); });
    expect(mark('a')).toBeNull();
    expect(mark('u')).toBeNull();
  });

  it('re-reads on sessions:changed, so a deleted unread chat stops counting', async () => {
    installBridge({ activeIds: [], unreadIds: ['gone'] });
    function Dot() { return <span data-has={String(useHasUnreadChats())} />; }
    await act(async () => { root.render(<Dot />); });
    expect(container.querySelector('[data-has="true"]')).not.toBeNull();

    getActivity.mockImplementation(() => Promise.resolve({ activeIds: [], unreadIds: [] }));
    await act(async () => { sessionsChanged(); });
    expect(container.querySelector('[data-has="false"]')).not.toBeNull();
  });
});

describe('useActiveChatCount', () => {
  it('is null until main has answered — never a made-up 0', async () => {
    let resolve!: (s: Snapshot) => void;
    installBridge(new Promise<Snapshot>((r) => { resolve = r; }));
    function Count() {
      const n = useActiveChatCount();
      return <span data-count={n == null ? 'none' : String(n)} />;
    }
    await act(async () => { root.render(<Count />); });
    expect(container.querySelector('[data-count="none"]')).not.toBeNull();

    await act(async () => { resolve({ activeIds: ['x', 'y'], unreadIds: [] }); });
    expect(container.querySelector('[data-count="2"]')).not.toBeNull();
  });
});

describe('reportViewingChat — which conversation is on screen', () => {
  it('tells main about the visible chat, and null when none is', () => {
    reportViewingChat('chats', 'c1');
    expect(setViewing).toHaveBeenLastCalledWith('c1');
    reportViewingChat('chats', null);
    expect(setViewing).toHaveBeenLastCalledWith(null);
  });

  it('switching surfaces never lands on null, whichever order the effects run', () => {
    // Chats page -> tool panel, "hidden" reported AFTER "shown". With
    // last-writer-wins this would end on null and the chat in plain view
    // would go unread.
    reportViewingChat('chats', 'c1');
    reportViewingChat('tool-panel', 'c1');
    reportViewingChat('chats', null);
    expect(setViewing).toHaveBeenLastCalledWith('c1');

    // And the other order.
    reportViewingChat('chats', 'c2');
    reportViewingChat('tool-panel', null);
    expect(setViewing).toHaveBeenLastCalledWith('c2');
  });

  it('sends nothing when the answer has not changed', () => {
    reportViewingChat('chats', 'c1');
    reportViewingChat('chats', 'c1');
    reportViewingChat('tool-panel', 'c1');
    expect(setViewing).toHaveBeenCalledTimes(1);
  });
});
