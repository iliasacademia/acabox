import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { queryActivity } from '../activityQuery';

export function createActivityMcpServer() {
  return createSdkMcpServer({
    name: 'activity',
    tools: [{
      name: 'query_activity',
      description:
        'Query the user\'s recent activity — browser pages visited and files edited/viewed. ' +
        'Returns raw session data for a time range. Use this to answer questions like ' +
        '"What did I do today?", "What was I reading in the last 2 hours?", ' +
        '"What files was I working on this week?".',
      inputSchema: {
        period: z.enum(['today', 'last_2h', 'last_24h', 'this_week']).optional()
          .describe('Convenience shorthand for common time ranges. Ignored if "since" is provided.'),
        since: z.string().optional()
          .describe('ISO timestamp for custom range start (e.g. "2026-04-06T09:00:00Z"). Overrides "period".'),
        until: z.string().optional()
          .describe('ISO timestamp for custom range end. Defaults to now.'),
        search: z.string().optional()
          .describe('Filter results by title or URL/path content.'),
        source: z.enum(['browser', 'file', 'all']).optional()
          .describe('Which activity source to query. Defaults to "all".'),
        include_content: z.boolean().optional()
          .describe('If true, include full_text and full_text_path for browser sessions, and snapshot_path + full_text_path + diff_path (cumulative diff since first seen, if file was modified) for file sessions. Defaults to false.'),
      },
      handler: async (args) => {
        const result = queryActivity(args);
        if ('error' in result) {
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }
        const browserCount = result.browser_sessions?.length || 0;
        const fileCount = result.file_sessions?.length || 0;
        const header = `Activity from ${result.query.since} to ${result.query.until}\n` +
          `Browser sessions: ${browserCount} | File sessions: ${fileCount}\n`;
        return { content: [{ type: 'text' as const, text: header + '\n' + JSON.stringify(result, null, 2) }] };
      },
    }],
  });
}
