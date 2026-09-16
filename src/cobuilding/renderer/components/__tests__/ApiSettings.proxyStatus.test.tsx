import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ApiSettings } from '../ApiSettings';

/**
 * Regression coverage for "The API proxy isn't running" shown while the proxy
 * was, in fact, listening.
 *
 * The Settings tab is mounted at app boot and only hidden behind
 * `display: none`, so a mount-once `useEffect` read `apis:list` in the window
 * BEFORE `agentInfrastructure.start()` had bound the proxy — measured on a
 * real boot as a ~220ms gap (`did-finish-load` 11:48:03.687, `[APIs] Proxy
 * listening` 11:48:03.908). The `running: false` snapshot was then frozen for
 * the life of the app, and the banner's own advice ("open a chat, or restart
 * Acabox") could not clear it, because nothing re-read.
 *
 * These tests drive the real component against a `list` whose answer CHANGES
 * between calls, which is the only shape that can tell a re-read apart from a
 * cached first answer. A revert to `useEffect(..., [])` fails the second case.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let listSpy: jest.Mock;

/** The boot race: down for the first call, up for every one after it. */
function proxyComesUpAfterFirstCall(): jest.Mock {
  let calls = 0;
  return jest.fn(async () => {
    calls += 1;
    return {
      apis: [],
      catalog: [],
      counters: {},
      proxy: calls === 1
        ? { running: false, baseUrl: null, error: null }
        : { running: true, baseUrl: 'http://127.0.0.1:23500', error: null },
    };
  });
}

const bannerText = () => container.textContent ?? '';
const bannerShown = () => bannerText().includes("The API proxy isn't running");

beforeEach(() => {
  listSpy = proxyComesUpAfterFirstCall();
  (window as any).apisAPI = { list: listSpy, save: jest.fn(), remove: jest.fn(), test: jest.fn() };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  jest.clearAllMocks();
});

async function render(active: boolean) {
  await act(async () => { root.render(<ApiSettings active={active} />); });
}

test('an inactive tab does not read the proxy status at all', async () => {
  await render(false);
  expect(listSpy).not.toHaveBeenCalled();
  // Nothing rendered rather than a fabricated "down" banner: the component
  // gates on `loaded`, so an unread status is never drawn as a verdict.
  expect(bannerShown()).toBe(false);
});

test('becoming the visible tab re-reads, clearing a stale boot-time snapshot', async () => {
  // Mount hidden, then read once while hidden — this stands in for the boot
  // snapshot taken during the race.
  await render(true);
  expect(listSpy).toHaveBeenCalledTimes(1);
  expect(bannerShown()).toBe(true);          // the stale, now-wrong verdict

  await act(async () => { root.render(<ApiSettings active={false} />); });
  await act(async () => { root.render(<ApiSettings active />); });

  expect(listSpy).toHaveBeenCalledTimes(2);  // it looked again
  expect(bannerShown()).toBe(false);         // and stopped lying
});

test('a proxy that genuinely failed to bind still reports, with its reason', async () => {
  // The re-read must not paper over a real failure — the banner has a second
  // branch naming the bind error, and that one has to survive.
  (window as any).apisAPI.list = jest.fn(async () => ({
    apis: [], catalog: [], counters: {},
    proxy: { running: false, baseUrl: null, error: 'EADDRINUSE' },
  }));
  await render(true);
  expect(bannerShown()).toBe(true);
  expect(bannerText()).toContain('EADDRINUSE');
});
