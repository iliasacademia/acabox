import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ClaudeDesignSettings } from '../ClaudeDesignSettings';

/**
 * Settings mounts at boot behind `display:none`. The Claude Design status
 * check spawns the bundled CLI and reads the keychain, so it must wait until
 * the tab is actually shown — and re-read each time it is.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let getStatus: jest.Mock;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  getStatus = jest.fn(() => Promise.resolve({ available: true, signedIn: false, canSignInHere: true }));
  (window as any).claudeDesignAPI = {
    getStatus,
    signIn: jest.fn(),
    submitCode: jest.fn(),
    reopenPage: jest.fn(),
    cancel: jest.fn(),
    onEvent: () => () => {},
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

it('does not check while hidden, checks on arrival, and again on each return', async () => {
  await act(async () => { root.render(<ClaudeDesignSettings active={false} />); });
  expect(getStatus).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Checking…');

  await act(async () => { root.render(<ClaudeDesignSettings active />); });
  expect(getStatus).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Not signed in');

  await act(async () => { root.render(<ClaudeDesignSettings active={false} />); });
  await act(async () => { root.render(<ClaudeDesignSettings active />); });
  expect(getStatus).toHaveBeenCalledTimes(2);
});

it('says why sign-in is unavailable instead of offering a dead button', async () => {
  getStatus.mockImplementation(() =>
    Promise.resolve({ available: true, signedIn: false, canSignInHere: false, reason: 'Not configured in this build.' }),
  );
  await act(async () => { root.render(<ClaudeDesignSettings active />); });
  expect(container.textContent).toContain('Not configured in this build.');
  expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
});
