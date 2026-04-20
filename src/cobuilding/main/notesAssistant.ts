import Anthropic from '@anthropic-ai/sdk';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import log from 'electron-log';
import { createSession, insertMessage, getMessages } from './db/chatRepository';

const NOTES_DIR = '.notes';
const MAX_NOTES_CHARS = 8000;

const SYSTEM_PROMPT = `You are an assistant helping a researcher who is dictating notes via speech-to-text.
You will receive the full notes document and the latest transcribed chunk.
Your job is to determine if the latest chunk contains a request or question directed at you (as opposed to the researcher simply noting an observation or dictating content).

Examples of requests:
- "Can you summarize what I've said so far?"
- "What's the formula for calculating molarity?"
- "At what time did I put my equipment in the autoclave?"
- "Remind me what the control group results were"
- "Hey assistant, what does PCR stand for?"

Examples of non-requests (simple note-taking):
- "I count 65 cells in this sample"
- "The sample showed elevated levels of cortisol"
- "Meeting with Dr. Smith at 3pm tomorrow"
- "TODO: review the data from yesterday"
- "Temperature reading is 37.2 degrees Celsius"

You MUST call the analyze_transcription tool with your analysis.`;

const ANALYZE_TOOL: Anthropic.Tool = {
  name: 'analyze_transcription',
  description: 'Analyze a transcription chunk to detect if it contains a request directed at the assistant',
  input_schema: {
    type: 'object' as const,
    properties: {
      has_request: {
        type: 'boolean',
        description: 'Whether the transcription chunk contains a request or question for the assistant',
      },
      extracted_request: {
        type: 'string',
        description: 'The extracted request text, or empty string if no request detected',
      },
      response: {
        type: 'string',
        description: 'Your response to the request, or empty string if no request detected',
      },
    },
    required: ['has_request', 'extracted_request', 'response'],
  },
};

interface AnalysisResult {
  has_request: boolean;
  extracted_request: string;
  response: string;
}

// Serialize analysis calls per day to prevent stale conversation history.
// Entries are cleaned up after the promise resolves to avoid unbounded growth.
const analysisQueues = new Map<string, Promise<void>>();

function enqueueAnalysis(dayFile: string, fn: () => Promise<void>): Promise<void> {
  const prev = analysisQueues.get(dayFile) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    // Clean up if this is still the latest entry (no new work was queued)
    if (analysisQueues.get(dayFile) === next) {
      analysisQueues.delete(dayFile);
    }
  });
  analysisQueues.set(dayFile, next);
  return next;
}

function sessionIdForDay(dayFile: string): string {
  return `notes-assistant-${dayFile}`;
}

// Cache the Anthropic client, invalidating when the API key changes
let cachedClient: Anthropic | null = null;
let cachedApiKey: string | null = null;

function getClient(apiKey: string): Anthropic {
  if (cachedClient && cachedApiKey === apiKey) return cachedClient;
  cachedClient = new Anthropic({ apiKey });
  cachedApiKey = apiKey;
  return cachedClient;
}

function buildConversationHistory(sessionId: string): string {
  const messages = getMessages(sessionId);
  if (messages.length === 0) return '';

  const lines: string[] = ['', 'Previous requests and responses in this session:'];

  // Iterate through messages matching user/assistant pairs by type
  // rather than assuming strict alternation, to handle partial failures
  let i = 0;
  while (i < messages.length) {
    // Find next user message
    if (messages[i].type !== 'user') { i++; continue; }
    const userMsg = messages[i];
    // Look for the following assistant message
    if (i + 1 < messages.length && messages[i + 1].type === 'assistant') {
      const assistantMsg = messages[i + 1];
      try {
        const request = JSON.parse(userMsg.content).text;
        const response = JSON.parse(assistantMsg.content).text;
        lines.push(`- User asked: "${request}"`);
        lines.push(`  Assistant responded: "${response}"`);
      } catch {
        // Skip malformed messages
      }
      i += 2;
    } else {
      // Orphaned user message (no assistant response followed) — skip it
      i++;
    }
  }
  return lines.length > 2 ? lines.join('\n') : '';
}

function buildUserMessage(notesContent: string, latestChunk: string, conversationHistory: string): string {
  // Truncate notes to last MAX_NOTES_CHARS if very long
  const truncatedNotes = notesContent.length > MAX_NOTES_CHARS
    ? '...\n' + notesContent.slice(-MAX_NOTES_CHARS)
    : notesContent;

  let message = `Here is the full notes document:\n\n${truncatedNotes}\n\n---\n\nLatest transcribed chunk:\n${latestChunk}`;
  if (conversationHistory) {
    message += `\n\n---\n${conversationHistory}`;
  }
  return message;
}

/**
 * @param waitForWrite — optional promise that resolves once the transcription
 *   has been written to the notes file, so we read the up-to-date content.
 */
export async function analyzeTranscription(
  dayFile: string,
  transcribedText: string,
  workspacePath: string,
  apiKey: string,
  workspaceId: string,
  sender: Electron.WebContents,
  waitForWrite?: Promise<void>,
): Promise<void> {
  return enqueueAnalysis(dayFile, async () => {
    // Notify renderer that analysis is starting
    if (!sender.isDestroyed()) {
      sender.send('notes:assistantAnalyzing', { dayFile, analyzing: true });
    }

    try {
      // Wait for the transcription write to settle so we read the latest content
      if (waitForWrite) {
        await waitForWrite.catch(() => {});
      }

      // Read the full notes file
      const filePath = path.join(workspacePath, NOTES_DIR, `${dayFile}.md`);
      let notesContent = '';
      try {
        notesContent = await fsPromises.readFile(filePath, 'utf-8');
      } catch {
        // File may not exist yet
      }

      // Load conversation history from DB
      const sessionId = sessionIdForDay(dayFile);
      const conversationHistory = buildConversationHistory(sessionId);

      // Build the user message
      const userMessage = buildUserMessage(notesContent, transcribedText, conversationHistory);

      // Call Claude
      const client = getClient(apiKey);
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [ANALYZE_TOOL],
        tool_choice: { type: 'tool', name: 'analyze_transcription' },
        messages: [{ role: 'user', content: userMessage }],
      });

      // Extract the tool use result
      const toolUseBlock = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (!toolUseBlock) {
        log.warn('[NotesAssistant] No tool_use block in response');
        return;
      }

      const result = toolUseBlock.input as AnalysisResult;

      if (result.has_request && result.extracted_request && result.response) {
        // Ensure session exists
        createSession(sessionId, workspaceId, 'notes-assistant');

        // Store request and response as messages
        insertMessage(sessionId, 'user', JSON.stringify({ text: result.extracted_request }));
        insertMessage(sessionId, 'assistant', JSON.stringify({ text: result.response }));

        // Notify renderer
        if (!sender.isDestroyed()) {
          sender.send('notes:assistantMessage', {
            dayFile,
            request: result.extracted_request,
            response: result.response,
          });
        }

        log.info('[NotesAssistant] Detected request in day=%s: "%s"', dayFile, result.extracted_request.slice(0, 80));
      }
    } catch (err) {
      log.warn('[NotesAssistant] Analysis failed for day=%s:', dayFile, err);
      if (!sender.isDestroyed()) {
        const message = err instanceof Error ? err.message : 'Analysis failed';
        sender.send('notes:assistantError', { dayFile, error: message });
      }
    } finally {
      // Notify renderer that analysis is done
      if (!sender.isDestroyed()) {
        sender.send('notes:assistantAnalyzing', { dayFile, analyzing: false });
      }
    }
  });
}
