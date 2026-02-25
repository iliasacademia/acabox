export interface CachedUserData {
  userId: number;
  email: string;
  displayName: string;
}

let cachedData: CachedUserData | null = null;

export function setCachedUserData(data: CachedUserData): void {
  cachedData = data;
}

export function clearCachedUserData(): void {
  cachedData = null;
}

export function getCachedUserData(): CachedUserData | null {
  return cachedData;
}
