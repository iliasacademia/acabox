import { IPC_CHANNELS } from '../../shared/types';

interface PreferenceMemoryContent {
  custom_instructions: string;
}

const DEFAULT_CONTENT: PreferenceMemoryContent = {
  custom_instructions: '',
};

function parseContent(raw: unknown): PreferenceMemoryContent {
  if (!raw) return DEFAULT_CONTENT;
  // Backend may return content as an already-parsed object
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return { custom_instructions: (obj.custom_instructions as string) ?? '' };
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return { custom_instructions: parsed?.custom_instructions ?? '' };
    } catch {
      // Fallback: treat as plain text
      return { custom_instructions: raw };
    }
  }
  return DEFAULT_CONTENT;
}

/**
 * Get the user's custom instructions from backend.
 * Returns empty string if no preference has been set.
 */
export async function getCustomInstructions(): Promise<string> {
  try {
    const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
      method: 'GET',
      endpoint: '/v0/co_scientist/user_preference_memory',
    });
    return parseContent(response.content).custom_instructions;
  } catch (error: any) {
    console.error('[UserPreferenceMemoryAPI] Failed to get custom instructions:', error);
    return '';
  }
}

/**
 * Save (full overwrite) the user's custom instructions.
 * Content is stored as a JSON object to allow future expansion.
 */
export async function saveCustomInstructions(customInstructions: string): Promise<void> {
  const content: PreferenceMemoryContent = { custom_instructions: customInstructions };
  await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'PATCH',
    endpoint: '/v0/co_scientist/user_preference_memory',
    data: { content: JSON.stringify(content) },
  });
}

/**
 * Clear the user's custom instructions.
 */
export async function clearCustomInstructions(): Promise<void> {
  await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'DELETE',
    endpoint: '/v0/co_scientist/user_preference_memory',
  });
}
