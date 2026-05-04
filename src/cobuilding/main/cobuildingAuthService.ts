import QRCode from 'qrcode';
import { APIclient } from '../../apiClient';
import { defaultLogger as logger } from '../../utils/logger';
import { generateDeviceId } from '../../auth/qrAuthService';
import type { QRAuthResult, QRAuthSession } from '../../auth/qrAuthService';

export type { QRAuthResult, QRAuthSession };

export interface CobuildingApiKeyResult {
  apiKey: string;
  keyIdentifier: string;
}

export async function createCobuildingAuthSession(apiBaseUrl: string): Promise<QRAuthSession> {
  try {
    const deviceId = generateDeviceId();
    const webUrl = apiBaseUrl.replace('api.', '').replace(/\/$/, '');
    const authorizationURL = `${webUrl}/cobuilding/desktop/authorize?device_id=${deviceId}`;

    const qrCodeDataURL = await QRCode.toDataURL(authorizationURL, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 300,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    logger.debug(`[Cobuilding Auth] Created session with device_id: ${deviceId}`);
    logger.debug(`[Cobuilding Auth] Authorization URL: ${authorizationURL}`);

    return { deviceId, qrCodeDataURL, authorizationURL };
  } catch (error) {
    logger.error('Error creating cobuilding auth session:', error);
    throw new Error('Failed to create cobuilding auth session');
  }
}

export async function fetchCobuildingApiKey(): Promise<CobuildingApiKeyResult> {
  const client = await APIclient();
  const response = await client.get('v0/cobuilding/api_key', {
    validateStatus: (status) => status >= 200 && status < 600,
  });

  if (response.status === 401) {
    throw new Error('Not authenticated');
  }
  if (response.status === 403) {
    throw new Error(response.data?.error || 'API key has been deactivated');
  }
  if (response.status === 503) {
    throw new Error(response.data?.error || 'No API keys available. Please contact support.');
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected response (${response.status})`);
  }

  const { api_key, key_identifier } = response.data;
  if (!api_key) {
    throw new Error('No api_key in response');
  }

  logger.debug(`[Cobuilding Auth] Fetched API key (identifier: ${key_identifier})`);
  return { apiKey: api_key, keyIdentifier: key_identifier };
}

export async function verifyCobuildingAuthCode(deviceId: string, code: string): Promise<QRAuthResult> {
  try {
    logger.debug(`[Cobuilding Auth] Verifying code for device_id: ${deviceId}`);

    const client = await APIclient();
    const response = await client.post(
      'v0/cobuilding/desktop/verify',
      { device_id: deviceId, verification_code: code },
      { validateStatus: (status) => status >= 200 && status < 500 },
    );

    const data = response.data;

    if (response.status >= 400) {
      logger.error(`[Cobuilding Auth] Verification failed with status ${response.status}:`, data);
      return { authorized: false, error: data.error || `Verification failed (${response.status})` };
    }

    if (data.authorized === true) {
      logger.debug('[Cobuilding Auth] Verification successful!');
      return { authorized: true, user_id: data.user_id };
    }

    logger.debug('[Cobuilding Auth] Verification returned unauthorized');
    return { authorized: false, error: data.error || 'Invalid verification code' };
  } catch (error) {
    logger.error('Error verifying cobuilding auth code:', error);
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as { response?: { status?: number } };
      if (axiosError.response?.status === 429) {
        return { authorized: false, error: 'Too many attempts. Please try again later.' };
      }
      if (axiosError.response?.status === 404) {
        return { authorized: false, error: 'Session not found or expired. Please start over.' };
      }
    }
    return { authorized: false, error: 'Network error. Please check your connection.' };
  }
}
