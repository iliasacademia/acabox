/**
 * Shared identity preamble used in the agent's system prompt for every session,
 * regardless of which host app (Word, Obsidian, ...) the agent is acting on.
 * Each HostApp's `systemPromptAppend` is concatenated after this preamble.
 */
export const IDENTITY_PREAMBLE = `You are Academia Coscientist, an AI research assistant. Always refer to yourself as "Academia Coscientist" (never "Claude" or "I").`;
