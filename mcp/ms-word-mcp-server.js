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
    req.write(data);
    req.end();
  });
}

function getFromServer(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
        },
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

// --- Tool Definition ---

const OPEN_DOCUMENT_TOOL = {
  name: 'ms_word_open_document',
  description:
    'Open (or focus) a Microsoft Word document by file path, making it the active document. ' +
    'All subsequent MCP tool calls will operate on this document. ' +
    'Use this when multiple Word documents are open and you need to target a specific one.',
  inputSchema: {
    type: 'object',
    required: ['filePath'],
    properties: {
      filePath: {
        type: 'string',
        description: 'The full file path to the Word document to open (e.g., "/Users/me/Documents/paper.docx").',
      },
    },
  },
};

const GET_TEXT_TOOL = {
  name: 'ms_word_get_text',
  description:
    'Get the current text content of the active Microsoft Word document, including unsaved changes. ' +
    'Returns a chunk of text with pagination support. ' +
    'Response includes: fileName, totalLength, offset, limit, content, hasMore. ' +
    'Call with increasing offset to read the full document in chunks.',
  inputSchema: {
    type: 'object',
    properties: {
      offset: {
        type: 'number',
        description: 'Character offset to start reading from (0-based). Default: 0.',
      },
      limit: {
        type: 'number',
        description: 'Maximum characters to return. Default: 8000 (~2000 tokens).',
      },
    },
  },
};

const GET_SELECTION_TOOL = {
  name: 'ms_word_get_selection',
  description:
    'Get the currently selected text in the active Microsoft Word document. ' +
    'Returns the selected text content. Useful for verifying what is selected before deleting or replacing.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const INSERT_PARAGRAPH_TOOL = {
  name: 'ms_word_insert_paragraph',
  description:
    'Insert a new paragraph at the current cursor position in the active Microsoft Word document. ' +
    'The cursor should already be positioned via ms_word_position_cursor. ' +
    'Set "position" to match the type used in position_cursor: ' +
    '"after" (default) = cursor was placed after previous text, so Enter then paste. ' +
    '"before" = cursor was placed before next text, so paste then Enter.',
  inputSchema: {
    type: 'object',
    required: ['content'],
    properties: {
      content: {
        type: 'string',
        description: 'The text content of the paragraph to insert.',
      },
      position: {
        type: 'string',
        enum: ['before', 'after'],
        description:
          'How the cursor was positioned. "after" (default): Enter → paste. "before": paste → Enter. ' +
          'Should match the "type" used in ms_word_position_cursor.',
      },
      defaultColor: {
        type: 'string',
        description:
          'Optional hex color (e.g. "#0000FF") to apply to inserted text. If omitted, text uses the document default color.',
      },
    },
  },
};

const POSITION_CURSOR_TOOL = {
  name: 'ms_word_position_cursor',
  description:
    'Position the cursor before or after the specified anchor text in the active Microsoft Word document. ' +
    'Uses Cmd+F to find the text and places the cursor adjacent to it. ' +
    'Call this before ms_word_insert_paragraph to place the cursor at the right location. ' +
    'For type "after": pass the last 60 chars of the preceding paragraph. ' +
    'For type "before": pass the first 60 chars of the following paragraph.',
  inputSchema: {
    type: 'object',
    required: ['anchor'],
    properties: {
      anchor: {
        type: 'string',
        description: 'The text to find in the document. For "after" type, use the last ~60 chars of the preceding text. For "before" type, use the first ~60 chars of the following text.',
      },
      type: {
        type: 'string',
        enum: ['before', 'after'],
        description: '"after" (default) places cursor after the anchor text. "before" places cursor before the anchor text.',
      },
    },
  },
};

const SELECT_TEXT_TOOL = {
  name: 'ms_word_select_text',
  description:
    'Find and precisely select specific text in the active Microsoft Word document. ' +
    'Uses Cmd+F to position cursor at the start, then binary-searches on selection length ' +
    'to match the exact text (up to 10 iterations). ' +
    'Use this before ms_word_delete_selection to select text you want to delete.',
  inputSchema: {
    type: 'object',
    required: ['text'],
    properties: {
      text: {
        type: 'string',
        description: 'The full exact text to find and select in the document.',
      },
    },
  },
};

const DELETE_SELECTION_TOOL = {
  name: 'ms_word_delete_selection',
  description:
    'Delete the currently selected text in the active Microsoft Word document. ' +
    'Use ms_word_select_text first to select the text you want to delete, then call this to remove it.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const GET_FILE_PATH_TOOL = {
  name: 'ms_word_get_file_path',
  description:
    'Get the file path of the active Microsoft Word document. ' +
    'Returns the full file path and file name. Use this to know which file is open, ' +
    'then read the file directly using the Read tool (for .docx files) rather than via AppleScript.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const APPLY_STYLE_TOOL = {
  name: 'ms_word_apply_style',
  description:
    'Apply a named paragraph style to the current selection in the active Microsoft Word document. ' +
    'Use ms_word_select_text first to select the target text, then call this to apply a style. ' +
    'Common styles: "Normal", "Heading 1", "Heading 2", "Heading 3", "Title", "Subtitle", "Body Text".',
  inputSchema: {
    type: 'object',
    required: ['style'],
    properties: {
      style: {
        type: 'string',
        description: 'The name of the Word style to apply (e.g., "Heading 1", "Normal", "Body Text").',
      },
    },
  },
};

const APPLY_FORMATTING_TOOL = {
  name: 'ms_word_apply_formatting',
  description:
    'Apply character-level formatting (bold, italic, underline, color, etc.) to the current selection in the active Microsoft Word document. ' +
    'Use ms_word_select_text first to select the target text, then call this to apply formatting. ' +
    'Boolean properties: set to true to enable, false to disable. Color accepts a hex string (e.g., "#FF0000"). Only provided properties are changed.',
  inputSchema: {
    type: 'object',
    properties: {
      bold: { type: 'boolean', description: 'Set bold formatting on/off.' },
      italic: { type: 'boolean', description: 'Set italic formatting on/off.' },
      underline: { type: 'boolean', description: 'Set underline formatting on/off.' },
      strikethrough: { type: 'boolean', description: 'Set strikethrough formatting on/off.' },
      allCaps: { type: 'boolean', description: 'Set all-caps formatting on/off.' },
      smallCaps: { type: 'boolean', description: 'Set small-caps formatting on/off.' },
      superscript: { type: 'boolean', description: 'Set superscript formatting on/off.' },
      subscript: { type: 'boolean', description: 'Set subscript formatting on/off.' },
      color: { type: 'string', description: 'Font color as hex string (e.g., "#FF0000" for red, "#0000FF" for blue).' },
    },
  },
};

const SAVE_DOCUMENT_TOOL = {
  name: 'ms_word_save_document',
  description:
    'Save the active Microsoft Word document. Call this before reading the file to ensure ' +
    'there are no unsaved changes. Also call after making edits (insert/delete) to persist changes to disk.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

// --- Active Document Helper ---

/**
 * Fetch the active Word document's file path and name.
 * Returns a prefix string to prepend to tool responses, or empty string on failure.
 */
async function getActiveDocumentPrefix() {
  try {
    const result = await getFromServer('/api/ms-word/get-file-path');
    if (result.data?.success) {
      return `[Active document: ${result.data.fileName} — ${result.data.filePath}]\n\n`;
    }
  } catch {
    // Ignore errors — the actual tool call will surface connection issues
  }
  return '';
}

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
      sendResponse(id, { tools: [OPEN_DOCUMENT_TOOL, GET_FILE_PATH_TOOL, GET_TEXT_TOOL, GET_SELECTION_TOOL, SAVE_DOCUMENT_TOOL, POSITION_CURSOR_TOOL, INSERT_PARAGRAPH_TOOL, SELECT_TEXT_TOOL, DELETE_SELECTION_TOOL, APPLY_STYLE_TOOL, APPLY_FORMATTING_TOOL] });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      // Fetch active document info to prepend to every tool response
      const activeDocPrefix = await getActiveDocumentPrefix();

      if (toolName === 'ms_word_open_document') {
        if (!args.filePath) {
          sendError(id, -32602, 'Missing required parameter: filePath');
          return;
        }

        try {
          const result = await postToServer('/api/ms-word/open-document', {
            action: 'open_document',
            filePath: args.filePath,
          });

          if (result.data?.success) {
            sendResponse(id, {
              content: [{ type: 'text', text: `${activeDocPrefix}Document opened: ${result.data.fileName}` }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to open document: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else if (toolName === 'ms_word_insert_paragraph') {
        if (!args.content) {
          sendError(id, -32602, 'Missing required parameter: content');
          return;
        }

        try {
          const result = await postToServer('/api/ms-word/insert-paragraph', {
            action: 'insert_paragraph',
            content: args.content,
            position: args.position || 'after',
            ...(args.defaultColor ? { defaultColor: args.defaultColor } : {}),
          });

          if (result.data?.success) {
            sendResponse(id, {
              content: [{ type: 'text', text: `${activeDocPrefix}Paragraph inserted successfully.` }],
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
      } else if (toolName === 'ms_word_position_cursor') {
        if (!args.anchor) {
          sendError(id, -32602, 'Missing required parameter: anchor');
          return;
        }

        try {
          const cursorType = args.type || 'after';
          const result = await postToServer('/api/ms-word/position-cursor', {
            action: 'position_cursor',
            anchor: args.anchor,
            type: cursorType,
          });

          if (result.data?.success) {
            sendResponse(id, {
              content: [{ type: 'text', text: `${activeDocPrefix}Cursor positioned ${cursorType} anchor text.` }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to position cursor: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else if (toolName === 'ms_word_select_text') {
        if (!args.text) {
          sendError(id, -32602, 'Missing required parameter: text');
          return;
        }

        try {
          const result = await postToServer('/api/ms-word/select-text', {
            action: 'select_text',
            text: args.text,
          });

          if (result.data?.success) {
            const exact = result.data.exact ? 'exact' : 'approximate';
            const msg = `${activeDocPrefix}Text selected (${exact}, ${result.data.iterations} iterations). Selected ${result.data.selectedText?.length || 0} chars.`;
            sendResponse(id, {
              content: [{ type: 'text', text: msg }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to select text: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else if (toolName === 'ms_word_delete_selection') {
        try {
          const result = await postToServer('/api/ms-word/delete-selection', {
            action: 'delete_selection',
          });

          if (result.data?.success) {
            const msg = result.data.deletedText
              ? `${activeDocPrefix}Selection deleted: "${result.data.deletedText}"`
              : `${activeDocPrefix}Selection deleted.`;
            sendResponse(id, {
              content: [{ type: 'text', text: msg }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to delete selection: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else if (toolName === 'ms_word_get_file_path') {
        try {
          const result = await getFromServer('/api/ms-word/get-file-path');

          if (result.data?.success) {
            sendResponse(id, {
              content: [{ type: 'text', text: `${activeDocPrefix}File: ${result.data.fileName}\nPath: ${result.data.filePath}` }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to get file path: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else if (toolName === 'ms_word_get_text') {
        try {
          const offset = args.offset || 0;
          const limit = args.limit || 8000;
          const result = await getFromServer(`/api/ms-word/get-text?offset=${offset}&limit=${limit}`);

          if (result.data?.success) {
            const d = result.data;
            const header = `File: ${d.fileName} | Total: ${d.totalLength} chars | Showing: ${d.offset}-${d.offset + d.content.length} | Has more: ${d.hasMore}`;
            sendResponse(id, {
              content: [{ type: 'text', text: `${activeDocPrefix}${header}\n\n${d.content}` }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to get text: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else if (toolName === 'ms_word_get_selection') {
        try {
          const result = await getFromServer('/api/ms-word/get-selection');

          if (result.data?.success) {
            sendResponse(id, {
              content: [{ type: 'text', text: `${activeDocPrefix}${result.data.selectedText || '(no text selected)'}` }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to get selection: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else if (toolName === 'ms_word_apply_style') {
        if (!args.style) {
          sendError(id, -32602, 'Missing required parameter: style');
          return;
        }

        try {
          const result = await postToServer('/api/ms-word/apply-style', {
            action: 'apply_style',
            style: args.style,
          });

          if (result.data?.success) {
            sendResponse(id, {
              content: [{ type: 'text', text: `${activeDocPrefix}Style "${args.style}" applied successfully.` }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to apply style: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else if (toolName === 'ms_word_apply_formatting') {
        const formattingProps = ['bold', 'italic', 'underline', 'strikethrough', 'allCaps', 'smallCaps', 'superscript', 'subscript', 'color'];
        const hasAny = formattingProps.some((p) => args[p] !== undefined);

        if (!hasAny) {
          sendError(id, -32602, 'At least one formatting property must be provided (e.g., bold, italic, underline).');
          return;
        }

        try {
          const body = { action: 'apply_formatting' };
          for (const p of formattingProps) {
            if (args[p] !== undefined) body[p] = args[p];
          }

          const result = await postToServer('/api/ms-word/apply-formatting', body);

          if (result.data?.success) {
            const applied = formattingProps
              .filter((p) => args[p] !== undefined)
              .map((p) => `${p}: ${args[p]}`)
              .join(', ');
            sendResponse(id, {
              content: [{ type: 'text', text: `${activeDocPrefix}Formatting applied successfully: ${applied}` }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to apply formatting: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else if (toolName === 'ms_word_save_document') {
        try {
          const result = await postToServer('/api/ms-word/save-document', {
            action: 'save_document',
          });

          if (result.data?.success) {
            sendResponse(id, {
              content: [{ type: 'text', text: `${activeDocPrefix}Document saved successfully.` }],
            });
          } else {
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: `Failed to save document: ${result.data?.error || `HTTP ${result.status}`}`,
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
      } else {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
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
