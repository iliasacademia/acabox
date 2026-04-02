#!/usr/bin/env node

/**
 * MS Word MCP Server (stdio transport)
 *
 * Minimal MCP server that proxies insert_paragraph calls to the
 * Writing Agent Electron app's HTTP API.
 *
 * Usage:
 *   node mcp/ms-word-mcp-server.js
 *
 * Environment:
 *   ACADEMIA_AUTH_TOKEN - Bearer token for the HTTP API (defaults to dev token)
 *   ACADEMIA_PORT       - HTTP server port (defaults to 23111)
 */

const http = require('http');
const readline = require('readline');

const AUTH_TOKEN = process.env.ACADEMIA_AUTH_TOKEN || 'supersecuredevtoken123';
const PORT = parseInt(process.env.ACADEMIA_PORT || '23111', 10);
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

function postToServer(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 15000,
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
    req.write(data);
    req.end();
  });
}

// --- Tool Definition ---

const INSERT_PARAGRAPH_TOOL = {
  name: 'ms_word_insert_paragraph',
  description:
    'Insert a new paragraph at the current cursor position in the active Microsoft Word document. ' +
    'Microsoft Word must be open with a document. The cursor should already be positioned at the desired insertion point.',
  inputSchema: {
    type: 'object',
    required: ['content'],
    properties: {
      content: {
        type: 'string',
        description: 'The text content of the paragraph to insert.',
      },
      method: {
        type: 'string',
        enum: ['applescript', 'keyboard'],
        description:
          'Insertion method. "applescript" (default) uses Word\'s AppleScript API. ' +
          '"keyboard" uses keyboard simulation (focus Word, Return, Cmd+V).',
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
        serverInfo: { name: 'ms-word', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      sendResponse(id, { tools: [INSERT_PARAGRAPH_TOOL] });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName !== 'ms_word_insert_paragraph') {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      if (!args.content) {
        sendError(id, -32602, 'Missing required parameter: content');
        return;
      }

      try {
        const result = await postToServer('/api/ms-word/insert-paragraph', {
          action: 'insert_paragraph',
          content: args.content,
          method: args.method || 'applescript',
        });

        if (result.data?.success) {
          sendResponse(id, {
            content: [{ type: 'text', text: 'Paragraph inserted successfully.' }],
          });
        } else {
          sendResponse(id, {
            content: [
              {
                type: 'text',
                text: `Failed to insert paragraph: ${result.data?.error || `HTTP ${result.status}`}`,
              },
            ],
            isError: true,
          });
        }
      } catch (err) {
        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: `Error connecting to Writing Agent: ${err.message}. Is the app running?`,
            },
          ],
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
