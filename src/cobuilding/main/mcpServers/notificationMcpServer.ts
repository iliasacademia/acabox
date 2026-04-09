import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Notification } from 'electron';
import { z } from 'zod';
import type { NotificationNavigationAction } from '../../shared/types';

export function createNotificationMcpServer(
  onNavigate?: (action: NotificationNavigationAction | null) => void,
) {
  return createSdkMcpServer({
    name: 'notification',
    tools: [
      tool(
        'show_notification',
        'Show a native desktop notification to the user. ' +
        'Use this to alert the user about completed tasks or important updates. ' +
        'Only call this when you have meaningful content to notify about. ' +
        'You can optionally specify a navigation action that will be triggered when the user clicks the notification.',
        {
          title: z.string().describe('The notification title.'),
          body: z.string().describe('The notification body text.'),
          navigation: z.object({
            type: z.enum(['thread', 'sidebar']).describe('The type of navigation action.'),
            threadId: z.string().optional().describe('The thread ID to navigate to (required when type is "thread").'),
            sidebarTab: z.enum(['chats', 'files', 'apps', 'scheduled', 'reactions', 'debug']).optional()
              .describe('The sidebar tab to show when navigating (optional for "thread", required for "sidebar").'),
          }).optional().describe('Optional navigation action when the user clicks the notification.'),
        },
        async (args) => {
          try {
            const notification = new Notification({ title: args.title, body: args.body });

            if (onNavigate) {
              notification.on('click', () => {
                if (args.navigation) {
                  const nav = args.navigation;
                  if (nav.type === 'thread' && nav.threadId) {
                    onNavigate({ type: 'thread', threadId: nav.threadId, sidebarTab: nav.sidebarTab });
                  } else if (nav.type === 'sidebar' && nav.sidebarTab) {
                    onNavigate({ type: 'sidebar', tab: nav.sidebarTab });
                  } else {
                    onNavigate(null);
                  }
                } else {
                  onNavigate(null);
                }
              });
            }

            notification.show();
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
