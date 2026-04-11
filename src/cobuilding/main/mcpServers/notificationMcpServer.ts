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
            console.log('[NotificationNav] show_notification called:', {
              title: args.title,
              body: args.body,
              navigation: args.navigation ?? null,
            });
            const notification = new Notification({ title: args.title, body: args.body });

            if (onNavigate) {
              notification.on('click', () => {
                console.log('[NotificationNav] Notification clicked. navigation args:', args.navigation ?? 'none');
                if (args.navigation) {
                  const nav = args.navigation;
                  if (nav.type === 'thread' && nav.threadId) {
                    console.log('[NotificationNav] Dispatching thread navigation:', { threadId: nav.threadId, sidebarTab: nav.sidebarTab });
                    onNavigate({ type: 'thread', threadId: nav.threadId, sidebarTab: nav.sidebarTab });
                  } else if (nav.type === 'sidebar' && nav.sidebarTab) {
                    console.log('[NotificationNav] Dispatching sidebar navigation:', { tab: nav.sidebarTab });
                    onNavigate({ type: 'sidebar', tab: nav.sidebarTab });
                  } else {
                    console.log('[NotificationNav] Navigation args present but no matching branch — dispatching null. type:', nav.type, 'threadId:', nav.threadId, 'sidebarTab:', nav.sidebarTab);
                    onNavigate(null);
                  }
                } else {
                  console.log('[NotificationNav] No navigation args — dispatching null (activate only)');
                  onNavigate(null);
                }
              });
            } else {
              console.warn('[NotificationNav] onNavigate callback is not set — click handler will not be registered');
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
