import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createSession, insertMessage, updateSessionTitle } from '../db/chatRepository';

export function createReactionMcpServer(workspaceId: string) {
  return createSdkMcpServer({
    name: 'reaction',
    tools: [
      tool(
        'create_reaction_thread',
        'Create a new reaction thread visible to the user in the Reactions tab. ' +
        'Use this after the reaction skill produces a reaction to save it as a separate, ' +
        'user-facing thread with only the final reaction message.',
        {
          title: z.string().describe('A short, descriptive title summarizing the reaction content (e.g., "New CRISPR delivery method in Nature" or "Grant deadline approaching for NIH R01"). Do NOT use generic timestamps like "Reaction — date".'),
          message: z.string().describe('The full reaction message content (markdown text).'),
        },
        async (args) => {
          try {
            const sessionId = randomUUID();
            createSession(sessionId, workspaceId, 'reactions');
            insertMessage(sessionId, 'assistant', JSON.stringify([{ type: 'text', text: args.message }]));
            updateSessionTitle(sessionId, args.title);
            return {
              content: [{ type: 'text' as const, text: `Reaction thread created: ${args.title} (id: ${sessionId})` }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: 'text' as const, text: `Failed to create reaction thread: ${message}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
