import QRCode from 'qrcode';
import { app } from 'electron';
import { APIclient } from '../uploader';

// Backend URL configuration
const isDev = !app.isPackaged;
const DEFAULT_URL = isDev ? 'https://api.devdemia.com/' : 'https://api.academia.edu/';
const BASE_URL = process.env.ACADEMIA_API_URL || DEFAULT_URL;
const WEB_URL = BASE_URL.replace('api.', ''); // Convert api.academia.edu to academia.edu

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

/**
 * Generate a unique device ID for QR code authentication
 */
export function generateDeviceId(): string {
  return crypto.randomUUID();
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
    const authorizationURL = `${WEB_URL}desktop/authorize?device_id=${deviceId}`;

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

    console.log(`[QR Auth] Created session with device_id: ${deviceId}`);
    console.log(`[QR Auth] Authorization URL: ${authorizationURL}`);

    return {
      deviceId,
      qrCodeDataURL,
      authorizationURL,
    };
  } catch (error) {
    console.error('Error creating QR auth session:', error);
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
    console.log(`[QR Auth] Verifying code for device_id: ${deviceId}`);

    const client = await APIclient();
    const response = await client.post(
      'v0/desktop/verify',
      {
        device_id: deviceId,
        verification_code: code,
      },
      {
        validateStatus: (status) => status >= 200 && status < 500,
      }
    );

    const data = response.data;

    // Handle error responses
    if (response.status >= 400) {
      console.error(`[QR Auth] Verification failed with status ${response.status}:`, data);
      return {
        authorized: false,
        error: data.error || `Verification failed (${response.status})`,
      };
    }

    // Handle successful verification
    // Cookie is automatically captured by cookie jar from Set-Cookie header
    if (data.authorized === true) {
      console.log(`[QR Auth] Verification successful! Cookie set by backend.`);

      return {
        authorized: true,
        user_id: data.user_id,
      };
    }

    // Verification failed
    console.log(`[QR Auth] Verification returned unauthorized`);
    return {
      authorized: false,
      error: data.error || 'Invalid verification code',
    };
  } catch (error) {
    console.error('Error verifying auth code:', error);
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
