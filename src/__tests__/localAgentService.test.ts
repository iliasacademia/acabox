import Database from 'better-sqlite3';
import { createLocalConversationDb, type LocalConversationDb } from '../localConversationDbFactory';

// Mock electron
jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  BrowserWindow: jest.fn(),
  ipcMain: { handle: jest.fn() },
}));

// Mock appStore
jest.mock('../appStore', () => ({
  store: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

// Mock localConversationDb to use in-memory DB
let testDb: LocalConversationDb;
jest.mock('../localConversationDb', () => ({
  getLocalConversationDb: () => testDb,
}));

// Mock logger
jest.mock('../utils/logger', () => ({
  defaultLogger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock @aws-sdk/client-bedrock-runtime
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  InvokeModelCommand: jest.fn().mockImplementation((input: any) => input),
}));

import { LocalAgentService } from '../localAgentService';
import { store } from '../appStore';

// Helper to wrap response in InvokeModel format (Uint8Array body)
const bedrockResponse = (data: any) => ({
  body: Buffer.from(JSON.stringify(data)),
});

describe('LocalAgentService', () => {
  let service: LocalAgentService;
  let mockWindow: any;

  beforeEach(() => {
    const db = new Database(':memory:');
    testDb = createLocalConversationDb(db);

    mockWindow = {
      isDestroyed: jest.fn().mockReturnValue(false),
      webContents: { send: jest.fn() },
    };

    service = new LocalAgentService();
    service.setMainWindow(mockWindow);
    service.setHttpPort(23111);
    service.setAuthToken('test-token');

    mockSend.mockReset();
    (store.get as jest.Mock).mockReset();
  });

  afterEach(() => {
    testDb.db.close();
  });

  describe('createConversation', () => {
    it('creates a conversation and returns it', async () => {
      (store.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'bedrockApiKey') return 'test-api-key';
        if (key === 'localAgentModel') return 'us.anthropic.claude-sonnet-4-6-20250514-v1:0';
        return undefined;
      });

      mockSend.mockResolvedValue(bedrockResponse({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hello! How can I help?' }],
      }));

      const result = await service.createConversation('Hi there', 1);

      expect(result.conversation).toBeDefined();
      expect(result.conversation.title).toBe('New Conversation');
      expect(result.conversation.agent_name).toBe('local_agent');
      expect(result.conversation.user_id).toBe(1);
    });
  });

  describe('runAgentLoop', () => {
    it('handles single-turn conversation without tool use', async () => {
      (store.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'bedrockApiKey') return 'test-api-key';
        if (key === 'localAgentModel') return 'us.anthropic.claude-sonnet-4-6-20250514-v1:0';
        return undefined;
      });

      mockSend.mockResolvedValue(bedrockResponse({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hello! How can I help you?' }],
      }));

      await service.createConversation('Hello', 1);

      // Wait for async agent loop
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify user message stored
      const messages = testDb.getMessages.all(1) as any[];
      expect(messages.length).toBe(2); // user + assistant
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toBe('Hello! How can I help you?');

      // Verify stream update sent with is_final: true
      const sendCalls = mockWindow.webContents.send.mock.calls;
      const finalUpdate = sendCalls.find(
        (call: any[]) => call[1]?.is_final === true && call[1]?.role === 'assistant',
      );
      expect(finalUpdate).toBeDefined();
    });

    it('handles tool-use loop', async () => {
      (store.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'bedrockApiKey') return 'test-api-key';
        if (key === 'localAgentModel') return 'us.anthropic.claude-sonnet-4-6-20250514-v1:0';
        return undefined;
      });

      // First call: tool_use
      mockSend
        .mockResolvedValueOnce(bedrockResponse({
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Let me get the document text.' },
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'ms_word_get_text',
              input: {},
            },
          ],
        }))
        // Second call: final response
        .mockResolvedValueOnce(bedrockResponse({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'The document contains your essay.' }],
        }));

      // Mock the HTTP fetch for tool execution
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"fileName":"test.docx","content":"Essay text here"}'),
      }) as any;

      try {
        await service.createConversation('What is in my document?', 1);
        await new Promise(resolve => setTimeout(resolve, 100));

        const messages = testDb.getMessages.all(1) as any[];
        // user + assistant(tool_use) + tool(result) + assistant(final)
        expect(messages.length).toBe(4);
        expect(messages[0].role).toBe('user');
        expect(messages[1].role).toBe('assistant');
        expect(messages[1].data).toBeTruthy(); // has tool_use content blocks
        expect(messages[2].role).toBe('tool');
        expect(messages[2].content).toContain('Essay text here');
        expect(messages[3].role).toBe('assistant');
        expect(messages[3].content).toBe('The document contains your essay.');

        // Verify API was called twice
        expect(mockSend).toHaveBeenCalledTimes(2);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('sends error when API key is missing', async () => {
      (store.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'bedrockApiKey') return '';
        return undefined;
      });

      await service.createConversation('Hello', 1);
      await new Promise(resolve => setTimeout(resolve, 50));

      const sendCalls = mockWindow.webContents.send.mock.calls;
      const errorUpdate = sendCalls.find(
        (call: any[]) => call[1]?.content?.includes('No Bedrock API key'),
      );
      expect(errorUpdate).toBeDefined();
    });

    it('handles API error gracefully', async () => {
      (store.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'bedrockApiKey') return 'test-api-key';
        if (key === 'localAgentModel') return 'us.anthropic.claude-sonnet-4-6-20250514-v1:0';
        return undefined;
      });

      mockSend.mockRejectedValue(new Error('API rate limit exceeded'));

      await service.createConversation('Hello', 1);
      await new Promise(resolve => setTimeout(resolve, 50));

      const messages = testDb.getMessages.all(1) as any[];
      // user + error assistant message
      expect(messages.length).toBe(2);
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toContain('API rate limit exceeded');

      // Verify final stream update sent
      const sendCalls = mockWindow.webContents.send.mock.calls;
      const finalUpdate = sendCalls.find(
        (call: any[]) => call[1]?.is_final === true,
      );
      expect(finalUpdate).toBeDefined();
    });
  });

  describe('sendMessage', () => {
    it('adds message to existing conversation', async () => {
      (store.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'bedrockApiKey') return 'test-api-key';
        if (key === 'localAgentModel') return 'us.anthropic.claude-sonnet-4-6-20250514-v1:0';
        return undefined;
      });

      mockSend.mockResolvedValue(bedrockResponse({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Response' }],
      }));

      // Create a conversation first
      const now = new Date().toISOString();
      const result = testDb.insertConversation.run('local_agent', null, null, 'Test', now, now, null, 1);
      const convId = Number(result.lastInsertRowid);

      await service.sendMessage(convId, 'Follow up question', 1);
      await new Promise(resolve => setTimeout(resolve, 50));

      const messages = testDb.getMessages.all(convId) as any[];
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Follow up question');
      expect(messages[1].role).toBe('assistant');
    });
  });

  describe('message storage schema', () => {
    it('stores messages with correct fields', async () => {
      (store.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'bedrockApiKey') return 'test-api-key';
        if (key === 'localAgentModel') return 'us.anthropic.claude-sonnet-4-6-20250514-v1:0';
        return undefined;
      });

      mockSend.mockResolvedValue(bedrockResponse({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Test response' }],
      }));

      await service.createConversation('Test input', 1);
      await new Promise(resolve => setTimeout(resolve, 50));

      const messages = testDb.getMessages.all(1) as any[];
      const userMsg = messages[0];
      expect(userMsg.content).toBe('Test input');
      expect(userMsg.format).toBe('markdown');
      expect(userMsg.role).toBe('user');
      expect(userMsg.conversation_id).toBe(1);
      expect(userMsg.user_id).toBe(1);
      expect(userMsg.created_at).toBeTruthy();
      expect(userMsg.updated_at).toBeTruthy();

      const assistantMsg = messages[1];
      expect(assistantMsg.content).toBe('Test response');
      expect(assistantMsg.format).toBe('markdown');
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.data).toBeNull();
      expect(assistantMsg.user_id).toBeNull();
    });
  });
});
