/**
 * Mock for deviceId utility in tests
 */

let mockDeviceId = 'mock-device-id-12345';

export function getDeviceId(): string {
  return mockDeviceId;
}

export function resetDeviceIdCache(): void {
  mockDeviceId = 'mock-device-id-12345';
}

// Test helper to set a custom device ID
export function __setMockDeviceId(id: string): void {
  mockDeviceId = id;
}
