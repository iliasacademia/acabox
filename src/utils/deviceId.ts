import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { app } from 'electron';

/**
 * Cached device ID to avoid repeated file reads.
 * Once read, the device ID is stable for the lifetime of the app.
 */
let cachedDeviceId: string | null = null;

/**
 * Get or create a persistent device identifier.
 *
 * Uses a UUID stored in the userData directory for stable identification
 * across app restarts. This is the same .machine-id file used by
 * EncryptedCookieStore for encryption key derivation.
 *
 * @returns A persistent UUID string identifying this device/installation
 */
export function getDeviceId(): string {
  // Return cached value if available
  if (cachedDeviceId !== null) {
    return cachedDeviceId;
  }

  try {
    const machineIdPath = path.join(app.getPath('userData'), '.machine-id');

    // Try to read existing machine ID
    if (fs.existsSync(machineIdPath)) {
      const existingId = fs.readFileSync(machineIdPath, 'utf8').trim();
      if (existingId && existingId.length > 0) {
        cachedDeviceId = existingId;
        return cachedDeviceId;
      }
    }

    // Generate new UUID if file doesn't exist or is invalid
    const newId = crypto.randomUUID();

    // Ensure directory exists
    const dir = path.dirname(machineIdPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Save the new ID
    fs.writeFileSync(machineIdPath, newId, 'utf8');

    cachedDeviceId = newId;
    return cachedDeviceId;
  } catch {
    // Fallback to hostname-based ID if file operations fail
    cachedDeviceId = `fallback-${os.hostname()}`;
    return cachedDeviceId;
  }
}

/**
 * Reset the cached device ID (primarily for testing).
 */
export function resetDeviceIdCache(): void {
  cachedDeviceId = null;
}
