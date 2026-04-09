import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Notification } from 'electron';
import { z } from 'zod';

export function createNotificationMcpServer() {
  return createSdkMcpServer({
    name: 'notification',
    tools: [
      tool(
        'show_notification',
        'Show a native desktop notification to the user. ' +
        'Use this to alert the user about completed tasks or important updates. ' +
        'Only call this when you have meaningful content to notify about.',
        {
          title: z.string().describe('The notification title.'),
          body: z.string().describe('The notification body text.'),
        },
        async (args) => {
          try {
            new Notification({ title: args.title, body: args.body }).show();
            return {
              content: [{ type: 'text' as const, text: 'Notification shown successfully.' }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: 'text' as const, text: `Failed to show notification: ${message}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
