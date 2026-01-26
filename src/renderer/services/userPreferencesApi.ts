import { IPC_CHANNELS } from '../../shared/types';

export interface UserPreferences {
  auto_diff_review: boolean;
}

/**
 * Get current user preferences from backend
 *
 * Response: { "auto_diff_review": boolean }
 */
export async function getUserPreferences(): Promise<UserPreferences> {
  try {
    const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
      method: 'GET',
      endpoint: '/v0/co_scientist/user_preferences',
    });

    // Only extract the fields we care about (filter out any extra fields from backend)
    const preferences: UserPreferences = {
      auto_diff_review: response.auto_diff_review ?? true,
    };

    return preferences;
  } catch (error: any) {
    console.error('[UserPreferencesAPI] Failed to get preferences:', error);
    // Return default on error
    return { auto_diff_review: true };
  }
}

/**
 * Update user preferences on backend
 *
 * Request: { "auto_diff_review": boolean }
 * Response: { "auto_diff_review": boolean }
 */
export async function updateUserPreferences(
  preferences: Partial<UserPreferences>
): Promise<UserPreferences> {
  // Only send the fields defined in UserPreferences interface
  const cleanedData: Partial<UserPreferences> = {};
  if ('auto_diff_review' in preferences) {
    cleanedData.auto_diff_review = preferences.auto_diff_review;
  }

  console.log('[UserPreferencesAPI] PATCH request data:', JSON.stringify(cleanedData));

  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'PATCH',
    endpoint: '/v0/co_scientist/user_preferences',
    data: cleanedData,
  });

  console.log('[UserPreferencesAPI] PATCH response:', JSON.stringify(response));

  // Only extract the fields we care about from response
  const updated: UserPreferences = {
    auto_diff_review: response.auto_diff_review ?? true,
  };

  return updated;
}
