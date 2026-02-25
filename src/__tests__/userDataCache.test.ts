/* eslint-disable */

// Mock logger before any imports
jest.mock('../utils/logger', () => ({
  defaultLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock apiClient
jest.mock('../apiClient', () => ({
  getCurrentUser: jest.fn(),
}));

import { getCurrentUser } from '../apiClient';
import { defaultLogger as logger } from '../utils/logger';
import {
  getCachedUserData,
  setCachedUserData,
  clearCachedUserData,
  fetchAndUpdateCache,
} from '../userDataCache';

const mockGetCurrentUser = getCurrentUser as jest.MockedFunction<typeof getCurrentUser>;

beforeEach(() => {
  clearCachedUserData();
  jest.clearAllMocks();
});

describe('userDataCache', () => {
  test('getCachedUserData returns null initially', () => {
    expect(getCachedUserData()).toBeNull();
  });

  test('setCachedUserData → getCachedUserData returns the data', () => {
    const data = { id: 1, email: 'test@example.com', first_name: 'Test' };
    setCachedUserData(data);
    expect(getCachedUserData()).toEqual(data);
  });

  test('clearCachedUserData clears previously set data', () => {
    setCachedUserData({ id: 1, email: 'test@example.com' });
    clearCachedUserData();
    expect(getCachedUserData()).toBeNull();
  });

  test('fetchAndUpdateCache — logged-in user populates cache and returns user', async () => {
    const user = { id: 42, email: 'a@b.com', first_name: 'Alice' };
    mockGetCurrentUser.mockResolvedValue(user);

    const result = await fetchAndUpdateCache();

    expect(result).toEqual(user);
    expect(getCachedUserData()).toEqual(user);
  });

  test('fetchAndUpdateCache — logged-out user (null) clears cache', async () => {
    setCachedUserData({ id: 99, email: 'old@test.com' });
    mockGetCurrentUser.mockResolvedValue(null);

    const result = await fetchAndUpdateCache();

    expect(result).toBeNull();
    expect(getCachedUserData()).toBeNull();
  });

  test('fetchAndUpdateCache — 401 error clears cache', async () => {
    setCachedUserData({ id: 99, email: 'old@test.com' });
    mockGetCurrentUser.mockRejectedValue({ response: { status: 401 } });

    const result = await fetchAndUpdateCache();

    expect(result).toBeNull();
    expect(getCachedUserData()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('401'),
    );
  });

  test('fetchAndUpdateCache — network error preserves stale cache', async () => {
    const staleData = { id: 99, email: 'old@test.com' };
    setCachedUserData(staleData);
    mockGetCurrentUser.mockRejectedValue(new Error('Network timeout'));

    const result = await fetchAndUpdateCache();

    expect(result).toEqual(staleData);
    expect(getCachedUserData()).toEqual(staleData);
    expect(logger.error).toHaveBeenCalled();
  });
});
