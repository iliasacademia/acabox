import QRCode from 'qrcode';
import { app } from 'electron';
import { createHash } from 'crypto';
import os from 'os';
import { APIclient, BASE_URL } from '../apiClient';
import { defaultLogger as logger } from '../utils/logger';

const WEB_URL = BASE_URL.replace('api.', '').replace(/\/$/, ''); // Convert api.academia.edu to academia.edu

export interface QRAuthResult {
  authorized: boolean;
  user_id?: number;
  error?: string;
}

export interface QRAuthSession {
  deviceId: string;
  qrCodeDataURL: string;
  authorizationURL: string;
}

export interface DeviceFingerprint {
  hostname: string;
  platform: string;
  arch: string;
  cpuCount: number;
  cpuModel: string;
  userDataPathHash: string;
}

/**
 * Get device-specific fingerprint information
 * Collects moderate device-specific info without exposing sensitive identifiers
 */
function getDeviceFingerprint(): DeviceFingerprint {
  const cpus = os.cpus();
  const userDataPath = app.getPath('userData');

  // Hash the user data path to avoid exposing actual file system paths
  const userDataPathHash = createHash('sha256')
    .update(userDataPath)
    .digest('hex')
    .substring(0, 16);

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model || 'unknown',
    userDataPathHash,
  };
}

/**
 * Generate a unique device ID for QR code authentication
 * Includes device fingerprint hash for security while maintaining unpredictability
 */
export function generateDeviceId(): string {
  // Get device fingerprint
  const fingerprint = getDeviceFingerprint();

  // Create deterministic hash from fingerprint
  const fingerprintString = JSON.stringify(fingerprint);
  const fingerprintHash = createHash('sha256')
    .update(fingerprintString)
    .digest('hex')
    .substring(0, 16); // Use first 16 chars for brevity

  // Generate random UUID for uniqueness
  const randomPart = crypto.randomUUID();

  // Combine fingerprint hash with UUID
  // Format: {fingerprint-hash}-{uuid}
  return `${fingerprintHash}-${randomPart}`;
}

/**
 * Create a QR code session with device ID and QR code data
 * Works locally without calling backend - verification code comes from user after browser auth
 */
export async function createQRAuthSession(): Promise<QRAuthSession> {
  try {
    // Generate device ID locally
    const deviceId = generateDeviceId();

    // Construct authorization URL
    const authorizationURL = `${WEB_URL}/desktop/authorize?device_id=${deviceId}`;

    // Generate QR code from authorization URL
    const qrCodeDataURL = await QRCode.toDataURL(authorizationURL, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 300,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    logger.debug(`[QR Auth] Created session with device_id: ${deviceId}`);
    logger.debug(`[QR Auth] Authorization URL: ${authorizationURL}`);

    return {
      deviceId,
      qrCodeDataURL,
      authorizationURL,
    };
  } catch (error) {
    logger.error('Error creating QR auth session:', error);
    throw new Error('Failed to create QR auth session');
  }
}

/**
 * Verify the authorization code entered by the user
 * Makes a single request to backend to validate the code
 * Backend will set authentication cookie via Set-Cookie header
 */
export async function verifyAuthCode(deviceId: string, code: string): Promise<QRAuthResult> {
  try {
    logger.debug(`[QR Auth] Verifying code for device_id: ${deviceId}`);

    // Get device fingerprint for verification
    const fingerprint = getDeviceFingerprint();

    const client = await APIclient();
    const response = await client.post(
      'v0/desktop/verify',
      {
        device_id: deviceId,
        verification_code: code,
        fingerprint,
      },
      {
        validateStatus: (status) => status >= 200 && status < 500,
      }
    );

    const data = response.data;

    // Handle error responses
    if (response.status >= 400) {
      logger.error(`[QR Auth] Verification failed with status ${response.status}:`, data);
      return {
        authorized: false,
        error: data.error || `Verification failed (${response.status})`,
      };
    }

    // Handle successful verification
    // Cookie is automatically captured by cookie jar from Set-Cookie header
    if (data.authorized === true) {
      logger.debug(`[QR Auth] Verification successful! Cookie set by backend.`);

      return {
        authorized: true,
        user_id: data.user_id,
      };
    }

    // Verification failed
    logger.debug(`[QR Auth] Verification returned unauthorized`);
    return {
      authorized: false,
      error: data.error || 'Invalid verification code',
    };
  } catch (error) {
    logger.error('Error verifying auth code:', error);
    // Type guard for axios error
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as { response?: { status?: number } };
      if (axiosError.response?.status === 429) {
        return {
          authorized: false,
          error: 'Too many attempts. Please try again later.',
        };
      }
      if (axiosError.response?.status === 404) {
        return {
          authorized: false,
          error: 'Session not found or expired. Please start over.',
        };
      }
    }
    return {
      authorized: false,
      error: 'Network error. Please check your connection.',
    };
  }
}
