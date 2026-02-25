import { getCurrentUser } from './apiClient';
import { defaultLogger as logger } from './utils/logger';

export interface CachedUserData {
  id: number;
  email?: string;
  first_name?: string;
  name?: string;
}

let cachedData: CachedUserData | null = null;

export function setCachedUserData(data: CachedUserData): void {
  cachedData = data;
}

export function getCachedUserData(): CachedUserData | null {
  return cachedData;
}

export function clearCachedUserData(): void {
  cachedData = null;
}

/**
 * Fetch the current user from the API and update the cache.
 * Returns the user data (same shape as getCurrentUser), or null if logged out.
 * On fetch failure, logs the error and preserves stale cache.
 */
export async function fetchAndUpdateCache(): Promise<CachedUserData | null> {
  try {
    const user = await getCurrentUser();
    if (user) {
      cachedData = user as CachedUserData;
      return cachedData;
    } else {
      cachedData = null;
      return null;
    }
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 401) {
      logger.warn('[UserDataCache] Auth error fetching user (401), clearing cache');
      cachedData = null;
      return null;
    }
    logger.error('[UserDataCache] Failed to fetch user:', error);
    return cachedData;
  }
}
