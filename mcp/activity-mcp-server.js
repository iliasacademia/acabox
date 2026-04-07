#!/usr/bin/env node

/**
 * Activity MCP Server (stdio transport)
 *
 * Exposes a query_activity tool that lets an AI agent query the user's
 * recent browsing and file editing activity from the observations database.
 *
 * Usage:
 *   node mcp/activity-mcp-server.js
 *
 * Environment:
 *   REACTIONS_PORT - Reactions server port (defaults to 47321)
 */

const http = require('http');
const readline = require('readline');

const PORT = parseInt(process.env.REACTIONS_PORT || '47321', 10);
const HOST = '127.0.0.1';

// --- MCP Protocol Helpers ---

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

// --- HTTP Client ---

function getFromServer(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: 'GET',
        headers: {},
        timeout: 30000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, data: { error: body } });
          }
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

// --- Period to timestamp conversion ---

function periodToSince(period) {
  const now = new Date();
  switch (period) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
    case 'last_2h':
      return new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    case 'last_24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case 'this_week': {
      const start = new Date(now);
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
    default:
      return null;
  }
}

// --- Tool Definition ---

const QUERY_ACTIVITY_TOOL = {
  name: 'query_activity',
  description:
    'Query the user\'s recent activity — browser pages visited and files edited/viewed. ' +
    'Returns raw session data for a time range. Use this to answer questions like ' +
    '"What did I do today?", "What was I reading in the last 2 hours?", ' +
    '"What files was I working on this week?".',
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['today', 'last_2h', 'last_24h', 'this_week'],
        description: 'Convenience shorthand for common time ranges. Ignored if "since" is provided.',
      },
      since: {
        type: 'string',
        description: 'ISO timestamp for custom range start (e.g. "2026-04-06T09:00:00Z"). Overrides "period".',
      },
      until: {
        type: 'string',
        description: 'ISO timestamp for custom range end. Defaults to now.',
      },
      search: {
        type: 'string',
        description: 'Filter results by title or URL/path content.',
      },
      source: {
        type: 'string',
        enum: ['browser', 'file', 'all'],
        description: 'Which activity source to query. Defaults to "all".',
      },
      include_content: {
        type: 'boolean',
        description: 'If true, include full page text for browser sessions and snapshot file paths for file sessions. Defaults to false.',
      },
    },
  },
};

// --- MCP Request Handler ---

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'activity', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      sendResponse(id, { tools: [QUERY_ACTIVITY_TOOL] });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName !== 'query_activity') {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      // Resolve time range
      let since = args.since;
      if (!since) {
        since = periodToSince(args.period || 'today');
      }
      if (!since) {
        sendError(id, -32602, 'Either "period" or "since" must be provided.');
        return;
      }

      // Build query string
      const queryParams = new URLSearchParams({ since });
      if (args.until) queryParams.set('until', args.until);
      if (args.search) queryParams.set('search', args.search);
      if (args.source) queryParams.set('source', args.source);
      if (args.include_content) queryParams.set('include_content', 'true');

      try {
        const result = await getFromServer(`/activity?${queryParams.toString()}`);

        if (result.status === 200) {
          const data = result.data;
          const browserCount = data.browser_sessions?.length || 0;
          const fileCount = data.file_sessions?.length || 0;
          const header = `Activity from ${data.query.since} to ${data.query.until}\n` +
            `Browser sessions: ${browserCount} | File sessions: ${fileCount}\n`;

          sendResponse(id, {
            content: [{ type: 'text', text: header + '\n' + JSON.stringify(data, null, 2) }],
          });
        } else {
          sendResponse(id, {
            content: [{
              type: 'text',
              text: `Failed to query activity: ${result.data?.error || result.data?.message || `HTTP ${result.status}`}`,
            }],
            isError: true,
          });
        }
      } catch (err) {
        sendResponse(id, {
          content: [{
            type: 'text',
            text: `Error connecting to Academia app: ${err.message}. Is the app running?`,
          }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

// --- Main: Read JSON-RPC from stdin ---

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handleRequest(msg).catch((err) => {
      if (msg.id !== undefined) {
        sendError(msg.id, -32603, `Internal error: ${err.message}`);
      }
    });
  } catch {
    // Ignore unparseable lines
  }
});

rl.on('close', () => process.exit(0));
