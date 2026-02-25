jest.mock('@fullstory/browser', () => ({
  FullStory: jest.fn(),
  init: jest.fn(),
}));

import type { FullStoryConfig } from '../fullstory';

const makeConfig = (overrides: Partial<FullStoryConfig> = {}): FullStoryConfig => ({
  userId: 111,
  email: 'a@test.com',
  displayName: 'User A',
  deviceId: 'dev-1',
  appVersion: '1.0.0',
  isPackaged: true,
  forceFullStoryRecording: false,
  ...overrides,
});

// Helpers to get a fresh module + mocks per test
function loadModule() {
  const { FullStory, init } = require('@fullstory/browser') as {
    FullStory: jest.Mock;
    init: jest.Mock;
  };
  const mod = require('../fullstory') as typeof import('../fullstory');
  return { FullStory, init, ...mod };
}

beforeEach(() => {
  jest.resetModules();
  // Re-register the mock after resetModules clears it
  jest.mock('@fullstory/browser', () => ({
    FullStory: jest.fn(),
    init: jest.fn(),
  }));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fullstory re-identification', () => {
  it('cacheFullStoryConfig before init does NOT call FullStory', () => {
    const { FullStory, cacheFullStoryConfig } = loadModule();

    cacheFullStoryConfig(makeConfig());

    expect(FullStory).not.toHaveBeenCalled();
  });

  it('re-login as different user calls setIdentity with new user', async () => {
    const { FullStory, cacheFullStoryConfig, onVisibilityChanged } = loadModule();

    // Init with user A
    cacheFullStoryConfig(makeConfig({ userId: 111 }));
    await onVisibilityChanged('review-button', true);

    expect(FullStory).toHaveBeenCalledWith(
      'setIdentity',
      expect.objectContaining({ uid: '111' }),
    );

    FullStory.mockClear();

    // Switch to user B
    cacheFullStoryConfig(makeConfig({ userId: 222, email: 'b@test.com', displayName: 'User B' }));

    expect(FullStory).toHaveBeenCalledWith(
      'setIdentity',
      expect.objectContaining({ uid: '222' }),
    );
  });

  it('logout (userId=null) calls shutdown', async () => {
    const { FullStory, cacheFullStoryConfig, onVisibilityChanged } = loadModule();

    // Init with user A
    cacheFullStoryConfig(makeConfig({ userId: 111 }));
    await onVisibilityChanged('review-button', true);

    FullStory.mockClear();

    // Logout
    cacheFullStoryConfig(makeConfig({ userId: null }));

    expect(FullStory).toHaveBeenCalledWith('shutdown');
  });

  it('same user cached again triggers no extra FullStory calls', async () => {
    const { FullStory, cacheFullStoryConfig, onVisibilityChanged } = loadModule();

    // Init with user A
    cacheFullStoryConfig(makeConfig({ userId: 111 }));
    await onVisibilityChanged('review-button', true);

    FullStory.mockClear();

    // Cache the same user again
    cacheFullStoryConfig(makeConfig({ userId: 111 }));

    expect(FullStory).not.toHaveBeenCalled();
  });
});
