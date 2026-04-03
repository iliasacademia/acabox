import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getLocalConversationDb } from './localConversationDb';
import { store } from './appStore';
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from './shared/types';
import { defaultLogger as logger } from './utils/logger';

const SYSTEM_PROMPT = `You are a helpful writing assistant. You can read and edit Microsoft Word documents using the available tools. When the user asks you to make changes to their document, use the tools to read the current content, make edits, and verify your changes.`;

// Types matching Anthropic Messages API format (used by InvokeModelCommand body)
interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string }
type ContentBlock = TextBlock | ToolUseBlock;
interface MessageParam { role: 'user' | 'assistant'; content: string | ContentBlock[] | ToolResultBlock[] }
interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }

// Tool definitions extracted from mcp/ms-word-mcp-server.js, converted to Anthropic API format
const MS_WORD_TOOLS: ToolDef[] = [
  {
    name: 'ms_word_open_document',
    description:
      'Open (or focus) a Microsoft Word document by file path, making it the active document. ' +
      'All subsequent tool calls will operate on this document. ' +
      'Use this when multiple Word documents are open and you need to target a specific one.',
    input_schema: {
      type: 'object' as const,
      required: ['filePath'],
      properties: {
        filePath: {
          type: 'string',
          description: 'The full file path to the Word document to open (e.g., "/Users/me/Documents/paper.docx").',
        },
      },
    },
  },
  {
    name: 'ms_word_get_file_path',
    description:
      'Get the file path of the active Microsoft Word document. ' +
      'Returns the full file path and file name.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'ms_word_get_text',
    description:
      'Get the current text content of the active Microsoft Word document, including unsaved changes. ' +
      'Returns a chunk of text with pagination support. ' +
      'Response includes: fileName, totalLength, offset, limit, content, hasMore. ' +
      'Call with increasing offset to read the full document in chunks.',
    input_schema: {
      type: 'object' as const,
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
  },
  {
    name: 'ms_word_get_selection',
    description:
      'Get the currently selected text in the active Microsoft Word document. ' +
      'Returns the selected text content. Useful for verifying what is selected before deleting or replacing.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'ms_word_save_document',
    description:
      'Save the active Microsoft Word document. Call this before reading the file to ensure ' +
      'there are no unsaved changes. Also call after making edits (insert/delete) to persist changes to disk.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'ms_word_position_cursor',
    description:
      'Position the cursor before or after the specified anchor text in the active Microsoft Word document. ' +
      'Uses Cmd+F to find the text and places the cursor adjacent to it. ' +
      'Call this before ms_word_insert_paragraph to place the cursor at the right location. ' +
      'For type "after": pass the last 60 chars of the preceding paragraph. ' +
      'For type "before": pass the first 60 chars of the following paragraph.',
    input_schema: {
      type: 'object' as const,
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
  },
  {
    name: 'ms_word_insert_paragraph',
    description:
      'Insert a new paragraph at the current cursor position in the active Microsoft Word document. ' +
      'The cursor should already be positioned via ms_word_position_cursor. ' +
      'Set "position" to match the type used in position_cursor: ' +
      '"after" (default) = cursor was placed after previous text, so Enter then paste. ' +
      '"before" = cursor was placed before next text, so paste then Enter.',
    input_schema: {
      type: 'object' as const,
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
  },
  {
    name: 'ms_word_select_text',
    description:
      'Find and precisely select specific text in the active Microsoft Word document. ' +
      'Uses Cmd+F to position cursor at the start, then binary-searches on selection length ' +
      'to match the exact text (up to 10 iterations). ' +
      'Use this before ms_word_delete_selection to select text you want to delete.',
    input_schema: {
      type: 'object' as const,
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'The full exact text to find and select in the document.',
        },
      },
    },
  },
  {
    name: 'ms_word_delete_selection',
    description:
      'Delete the currently selected text in the active Microsoft Word document. ' +
      'Use ms_word_select_text first to select the text you want to delete, then call this to remove it.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'ms_word_apply_style',
    description:
      'Apply a named paragraph style to the current selection in the active Microsoft Word document. ' +
      'Use ms_word_select_text first to select the target text, then call this to apply a style. ' +
      'Common styles: "Normal", "Heading 1", "Heading 2", "Heading 3", "Title", "Subtitle", "Body Text".',
    input_schema: {
      type: 'object' as const,
      required: ['style'],
      properties: {
        style: {
          type: 'string',
          description: 'The name of the Word style to apply (e.g., "Heading 1", "Normal", "Body Text").',
        },
      },
    },
  },
  {
    name: 'ms_word_apply_formatting',
    description:
      'Apply character-level formatting (bold, italic, underline, color, etc.) to the current selection in the active Microsoft Word document. ' +
      'Use ms_word_select_text first to select the target text, then call this to apply formatting. ' +
      'Boolean properties: set to true to enable, false to disable. Color accepts a hex string (e.g., "#FF0000"). Only provided properties are changed.',
    input_schema: {
      type: 'object' as const,
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
  },
];

// Map tool names to HTTP endpoints and methods
const TOOL_ROUTES: Record<string, { method: 'GET' | 'POST'; path: string }> = {
  ms_word_open_document:    { method: 'POST', path: '/api/ms-word/open-document' },
  ms_word_get_file_path:    { method: 'GET',  path: '/api/ms-word/get-file-path' },
  ms_word_get_text:         { method: 'GET',  path: '/api/ms-word/get-text' },
  ms_word_get_selection:    { method: 'GET',  path: '/api/ms-word/get-selection' },
  ms_word_save_document:    { method: 'POST', path: '/api/ms-word/save-document' },
  ms_word_position_cursor:  { method: 'POST', path: '/api/ms-word/position-cursor' },
  ms_word_insert_paragraph: { method: 'POST', path: '/api/ms-word/insert-paragraph' },
  ms_word_select_text:      { method: 'POST', path: '/api/ms-word/select-text' },
  ms_word_delete_selection: { method: 'POST', path: '/api/ms-word/delete-selection' },
  ms_word_apply_style:      { method: 'POST', path: '/api/ms-word/apply-style' },
  ms_word_apply_formatting: { method: 'POST', path: '/api/ms-word/apply-formatting' },
};

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  port: number,
  authToken: string,
): Promise<string> {
  const route = TOOL_ROUTES[toolName];
  if (!route) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
  };

  if (route.method === 'GET') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(toolInput)) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
    const queryString = params.toString();
    const url = queryString ? `${baseUrl}${route.path}?${queryString}` : `${baseUrl}${route.path}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return await response.text();
  } else {
    headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${route.path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolInput),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return await response.text();
  }
}

export class LocalAgentService {
  private mainWindow: BrowserWindow | null = null;
  private httpPort: number = 23111;
  private authToken: string = '';
  private manuscriptPaths: Map<number, string> = new Map();

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  setHttpPort(port: number) {
    this.httpPort = port;
  }

  setAuthToken(token: string) {
    this.authToken = token;
  }

  async createConversation(content: string, userId: number, manuscriptFilePath?: string): Promise<{ conversation: any }> {
    const db = getLocalConversationDb();
    const now = new Date().toISOString();

    const result = db.insertConversation.run(
      'local_agent', // agent_name
      null,          // parent_type
      null,          // summary
      'New Conversation', // title
      now,           // created_at
      now,           // updated_at
      null,          // parent_id
      userId,        // user_id
    );
    const conversationId = Number(result.lastInsertRowid);

    if (manuscriptFilePath) {
      this.manuscriptPaths.set(conversationId, manuscriptFilePath);
    }

    // Run agent loop async — sends stream updates
    this.runAgentLoop(conversationId, content, userId);

    const conversation = db.getConversation.get(conversationId);
    return { conversation };
  }

  async sendMessage(conversationId: number, content: string, userId: number): Promise<void> {
    this.runAgentLoop(conversationId, content, userId);
  }

  private async runAgentLoop(conversationId: number, userContent: string, userId: number) {
    const db = getLocalConversationDb();
    const apiKey = store.get('bedrockApiKey') as string;
    const model = (store.get('localAgentModel') as string) || 'us.anthropic.claude-sonnet-4-6-20250514-v1:0';

    if (!apiKey) {
      logger.warn('[LocalAgent] No Bedrock API key configured');
      this.sendStreamUpdate(conversationId, {
        role: 'assistant',
        content: 'Error: No Bedrock API key configured. Please set your API key in Settings.',
        is_final: true,
      });
      return;
    }

    // Build dynamic system prompt with manuscript path if available
    const manuscriptFilePath = this.manuscriptPaths.get(conversationId);
    let systemPrompt = SYSTEM_PROMPT;
    if (manuscriptFilePath) {
      systemPrompt += `\n\nThe user is working on a specific document located at: ${manuscriptFilePath}\nAt the start of the conversation, use the ms_word_open_document tool to open this document before responding to the user's request. This ensures all subsequent tool calls operate on the correct document.`;
    }

    logger.info(`[LocalAgent] Starting agent loop for conversation ${conversationId}, model: ${model}`);

    // Set bearer token for Bedrock API key auth
    process.env.AWS_BEARER_TOKEN_BEDROCK = apiKey;
    const client = new BedrockRuntimeClient({ region: 'us-east-1' });
    const now = new Date().toISOString();

    // 1. Insert user message
    db.insertMessage.run(userContent, null, 'markdown', 'user', now, now, conversationId, userId);

    // 2. Build messages array from DB history
    const messages = this.buildAnthropicMessages(conversationId);

    try {
      // 3. Call Bedrock via InvokeModel (Anthropic Messages API format)
      logger.debug(`[LocalAgent] Sending initial request to Bedrock (${messages.length} messages)`);
      let response = await this.invokeModel(client, model, messages, { system: systemPrompt });
      logger.debug(`[LocalAgent] Received response, stop_reason: ${response.stop_reason}`);

      // 4. Agentic loop — keep calling tools until stop_reason is not tool_use
      while (response.stop_reason === 'tool_use') {
        const assistantNow = new Date().toISOString();

        // Store assistant message with tool_use blocks
        const assistantContent = response.content as ContentBlock[];
        const textParts = assistantContent
          .filter((b): b is TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        db.insertMessage.run(
          textParts || null,
          JSON.stringify(assistantContent),
          'markdown',
          'assistant',
          assistantNow,
          assistantNow,
          conversationId,
          null,
        );
        this.sendStreamUpdate(conversationId, { role: 'assistant', is_final: false });

        // Execute each tool and store results
        for (const block of assistantContent) {
          if (block.type === 'tool_use') {
            logger.debug(`[LocalAgent] Executing tool: ${block.name} (id: ${block.id})`);
            let resultText: string;
            try {
              resultText = await executeTool(
                block.name,
                block.input as Record<string, unknown>,
                this.httpPort,
                this.authToken,
              );
              logger.debug(`[LocalAgent] Tool ${block.name} succeeded (${resultText.length} chars)`);
            } catch (err) {
              resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
              logger.error(`[LocalAgent] Tool ${block.name} failed: ${resultText}`);
            }

            const toolNow = new Date().toISOString();
            db.insertMessage.run(
              resultText,
              JSON.stringify({ tool_use_id: block.id, tool_name: block.name, tool_call: { name: block.name, parameters: block.input } }),
              null,
              'tool',
              toolNow,
              toolNow,
              conversationId,
              null,
            );
            this.sendStreamUpdate(conversationId, { role: 'tool', is_final: false });
          }
        }

        // Rebuild messages and call API again
        const updatedMessages = this.buildAnthropicMessages(conversationId);
        logger.debug(`[LocalAgent] Continuing agent loop (${updatedMessages.length} messages)`);
        response = await this.invokeModel(client, model, updatedMessages, { system: systemPrompt });
        logger.debug(`[LocalAgent] Received response, stop_reason: ${response.stop_reason}`);
      }

      // 5. Store final assistant response
      const finalText = (response.content as ContentBlock[])
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      const finalNow = new Date().toISOString();
      db.insertMessage.run(finalText, null, 'markdown', 'assistant', finalNow, finalNow, conversationId, null);
      this.sendStreamUpdate(conversationId, { role: 'assistant', is_final: true });
      logger.info(`[LocalAgent] Agent loop completed for conversation ${conversationId} (${finalText.length} chars)`);

      // 6. Generate title after first exchange
      const messageCount = (db.getMessages.all(conversationId) as any[]).length;
      if (messageCount <= 3) {
        this.generateTitle(client, model, conversationId, userContent, finalText);
      }
    } catch (err) {
      const errorNow = new Date().toISOString();
      const errorMsg = `Error: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(`[LocalAgent] Agent loop failed for conversation ${conversationId}: ${errorMsg}`);
      db.insertMessage.run(errorMsg, null, null, 'assistant', errorNow, errorNow, conversationId, null);
      this.sendStreamUpdate(conversationId, { role: 'assistant', is_final: true });
    }
  }

  private async invokeModel(client: BedrockRuntimeClient, modelId: string, messages: MessageParam[], options?: { max_tokens?: number; system?: string; tools?: ToolDef[] }) {
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options?.max_tokens ?? 4096,
      system: options?.system ?? SYSTEM_PROMPT,
      messages,
      ...(options?.tools !== undefined ? { tools: options.tools } : { tools: MS_WORD_TOOLS }),
    };

    const command = new InvokeModelCommand({
      modelId,
      body: Buffer.from(JSON.stringify(body)),
      contentType: 'application/json',
      accept: 'application/json',
    });

    logger.debug(`[LocalAgent] InvokeModel request to ${modelId}`);
    const result = await client.send(command);
    const parsed = JSON.parse(Buffer.from(result.body!).toString('utf-8'));
    logger.debug(`[LocalAgent] InvokeModel response: stop_reason=${parsed.stop_reason}, usage=${JSON.stringify(parsed.usage)}`);
    return parsed;
  }

  private buildAnthropicMessages(conversationId: number): MessageParam[] {
    const db = getLocalConversationDb();
    const dbMessages = db.getMessages.all(conversationId) as any[];
    const anthropicMessages: MessageParam[] = [];

    for (const msg of dbMessages) {
      if (msg.role === 'user') {
        anthropicMessages.push({ role: 'user', content: msg.content || '' });
      } else if (msg.role === 'assistant') {
        if (msg.data) {
          const contentBlocks = JSON.parse(msg.data);
          anthropicMessages.push({ role: 'assistant', content: contentBlocks });
        } else {
          anthropicMessages.push({ role: 'assistant', content: msg.content || '' });
        }
      } else if (msg.role === 'tool') {
        const toolData = msg.data ? JSON.parse(msg.data) : {};
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolData.tool_use_id,
              content: msg.content || '',
            },
          ],
        });
      }
    }

    return anthropicMessages;
  }

  private async generateTitle(
    client: BedrockRuntimeClient,
    model: string,
    conversationId: number,
    userMessage: string,
    assistantResponse: string,
  ) {
    try {
      const titleResponse = await this.invokeModel(client, model, [
        {
          role: 'user',
          content: `Generate a short title (max 6 words) for a conversation that starts with this exchange:\nUser: ${userMessage}\nAssistant: ${assistantResponse}\n\nRespond with only the title, no quotes.`,
        },
      ], { max_tokens: 50, system: SYSTEM_PROMPT, tools: [] });
      const title =
        titleResponse.content[0].type === 'text'
          ? titleResponse.content[0].text.trim()
          : 'New Conversation';
      logger.debug(`[LocalAgent] Generated title for conversation ${conversationId}: "${title}"`);
      const db = getLocalConversationDb();
      db.updateConversationTitle.run(title, new Date().toISOString(), conversationId);
      this.sendStreamUpdate(conversationId, { titleUpdated: title, is_final: false });
    } catch (err) {
      logger.warn(`[LocalAgent] Title generation failed for conversation ${conversationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sendStreamUpdate(conversationId: number, data: Record<string, unknown>) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.LOCAL_AGENT_STREAM_UPDATE, {
        conversation_id: conversationId,
        ...data,
      });
    }
  }
}
