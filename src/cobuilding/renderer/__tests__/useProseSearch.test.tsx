import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useProseSearch } from '../useProseSearch';

/**
 * Debounced `sessions:searchProse`. See docs/design/chat-search.md § Ticket B.
 * Fake timers drive the 150ms debounce; the bridge is mocked as in
 * `chatActivityStore.test.tsx`.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let searchProse: jest.Mock;
let container: HTMLDivElement;
let root: Root;

function installBridge(): void {
  searchProse = jest.fn();
  (window as any).sessionsAPI = {
    searchProse,
    onSessionsChanged: () => () => {},
  };
}

function Probe({ query }: { query: string }) {
  const { forQuery, results } = useProseSearch(query);
  return <span data-for={forQuery} data-size={results.size} />;
}

const forAttr = () => container.querySelector('span')!.getAttribute('data-for');
const sizeAttr = () => container.querySelector('span')!.getAttribute('data-size');

beforeEach(() => {
  jest.useFakeTimers();
  installBridge();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  jest.useRealTimers();
});

it('does not call before 150ms', async () => {
  searchProse.mockReturnValue(new Promise(() => { /* never resolves */ }));
  await act(async () => { root.render(<Probe query="abc" />); });
  expect(searchProse).not.toHaveBeenCalled();

  act(() => { jest.advanceTimersByTime(100); });
  expect(searchProse).not.toHaveBeenCalled();
});

it('calls once after the debounce elapses', async () => {
  searchProse.mockReturnValue(new Promise(() => { /* never resolves */ }));
  await act(async () => { root.render(<Probe query="abc" />); });
  await act(async () => { jest.advanceTimersByTime(150); });

  expect(searchProse).toHaveBeenCalledTimes(1);
  expect(searchProse).toHaveBeenCalledWith('abc');
});

it('rapid typing sends only the last query', async () => {
  searchProse.mockReturnValue(new Promise(() => { /* never resolves */ }));
  await act(async () => { root.render(<Probe query="a" />); });
  act(() => { jest.advanceTimersByTime(50); });
  await act(async () => { root.render(<Probe query="ab" />); });
  act(() => { jest.advanceTimersByTime(50); });
  await act(async () => { root.render(<Probe query="abc" />); });
  await act(async () => { jest.advanceTimersByTime(150); });

  expect(searchProse).toHaveBeenCalledTimes(1);
  expect(searchProse).toHaveBeenCalledWith('abc');
});

it('an out-of-order older response does not overwrite a newer one', async () => {
  let resolveFirst!: (rows: ChatProseResultData[]) => void;
  let resolveSecond!: (rows: ChatProseResultData[]) => void;
  searchProse
    .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
    .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));

  await act(async () => { root.render(<Probe query="alpha" />); });
  await act(async () => { jest.advanceTimersByTime(150); }); // request for "alpha" sent

  await act(async () => { root.render(<Probe query="beta" />); });
  await act(async () => { jest.advanceTimersByTime(150); }); // request for "beta" sent

  // The newer ("beta") request answers first.
  await act(async () => { resolveSecond([{ sessionId: 's2', total: 1, hits: [] }]); });
  expect(forAttr()).toBe('beta');
  expect(sizeAttr()).toBe('1');

  // The older ("alpha") request answers after it — must not overwrite "beta".
  await act(async () => { resolveFirst([{ sessionId: 's1', total: 1, hits: [] }]); });
  expect(forAttr()).toBe('beta');
  expect(sizeAttr()).toBe('1');
});

it('empty query returns empty results without calling searchProse', async () => {
  await act(async () => { root.render(<Probe query="   " />); });
  act(() => { jest.advanceTimersByTime(200); });

  expect(searchProse).not.toHaveBeenCalled();
  expect(forAttr()).toBe('');
  expect(sizeAttr()).toBe('0');
});
