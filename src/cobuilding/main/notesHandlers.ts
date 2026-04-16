import { ipcMain, net } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import FormData from 'form-data';

export function registerNotesHandlers(
  getWorkspacePath: () => string | null,
  getOpenAIKey: () => string | null,
): void {
  ipcMain.handle('notes:listDays', async () => {
    const wp = requireWorkspace(getWorkspacePath);
    const dir = notesDir(wp);
    try {
      const entries = await fsPromises.readdir(dir);
      return entries
        .filter((e) => e.endsWith('.md'))
        .map((e) => e.replace(/\.md$/, ''))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  });

  ipcMain.handle('notes:readDay', async (_event, day: string) => {
    validateDayFile(day);
    const wp = requireWorkspace(getWorkspacePath);
    const filePath = path.join(notesDir(wp), `${day}.md`);
    try {
      return await fsPromises.readFile(filePath, 'utf-8');
    } catch {
      return '';
    }
  });

  ipcMain.on('notes:transcribe', async (event, data: { audioBase64: string; dayFile: string }) => {
    const { audioBase64, dayFile } = data;

    if (!DAY_FORMAT.test(dayFile)) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('notes:transcriptionError', 'Invalid day format.');
      }
      return;
    }

    const wp = getWorkspacePath();
    if (!wp) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('notes:transcriptionError', 'No active workspace.');
      }
      return;
    }

    const apiKey = getOpenAIKey();
    if (!apiKey) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('notes:transcriptionError', 'No OpenAI API key configured. Please add it in Settings.');
      }
      return;
    }

    // Decode and validate audio
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Skip very small chunks (likely silence)
    if (audioBuffer.length < 1000) {
      return;
    }

    // Verify WebM magic bytes
    if (audioBuffer.length < 4 || !audioBuffer.subarray(0, 4).equals(WEBM_MAGIC)) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('notes:transcriptionError', 'Invalid audio format: expected WebM.');
      }
      return;
    }

    // Reject oversized chunks
    if (audioBuffer.length > MAX_CHUNK_SIZE) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('notes:transcriptionError', 'Audio chunk too large.');
      }
      return;
    }

    try {
      // Build multipart form data.
      // Note: getBuffer() below requires all appended values to be Buffers or
      // strings — it will return incomplete data if streams are used instead.
      const form = new FormData();
      form.append('file', audioBuffer, {
        filename: 'audio.webm',
        contentType: 'audio/webm',
      });
      form.append('model', 'gpt-4o-transcribe');
      form.append('response_format', 'text');

      const response = await net.fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...form.getHeaders(),
        },
        body: new Uint8Array(form.getBuffer()),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let message = `OpenAI API error (${response.status})`;
        if (response.status === 401) {
          message = 'Invalid OpenAI API key. Please update it in Settings.';
        } else if (response.status === 429) {
          message = 'OpenAI rate limit exceeded. Please wait a moment.';
        } else {
          try {
            const errorJson = JSON.parse(errorText);
            message = errorJson.error?.message ?? message;
          } catch { }
        }
        if (!event.sender.isDestroyed()) {
          event.sender.send('notes:transcriptionError', message);
        }
        return;
      }

      const text = (await response.text()).trim();

      // Skip empty transcriptions (silence)
      if (!text) {
        return;
      }

      // Write to markdown file
      await enqueueWrite(dayFile, async () => {
        const dir = ensureNotesDir(wp);
        const filePath = path.join(dir, `${dayFile}.md`);
        const timeBlock = currentTimeBlock();

        let existing = '';
        try {
          existing = await fsPromises.readFile(filePath, 'utf-8');
        } catch { }

        // Check if the last heading matches the current 10-minute block
        const headingLine = `## ${timeBlock}`;
        const allHeadings = existing.match(/^## \d{2}:\d{2}$/gm);
        const lastHeading = allHeadings ? allHeadings[allHeadings.length - 1] : null;

        let content: string;
        if (!existing) {
          content = `# Notes - ${formatDateHeader(dayFile)}\n\n${headingLine}\n${text}\n`;
        } else if (lastHeading === headingLine) {
          // Same 10-minute block — append directly
          content = `${existing}${text}\n`;
        } else {
          content = `${existing}\n${headingLine}\n${text}\n`;
        }

        await fsPromises.writeFile(filePath, content, 'utf-8');
      });

      // Send transcription back to renderer
      if (!event.sender.isDestroyed()) {
        event.sender.send('notes:transcription', { text, dayFile });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transcription failed';
      if (!event.sender.isDestroyed()) {
        event.sender.send('notes:transcriptionError', message);
      }
    }
  });
}

// --- Internal helpers ---

const NOTES_DIR = '.notes';
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
// WebM files start with EBML header: 0x1A 0x45 0xDF 0xA3
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
// 5 seconds of WebM/opus at high bitrate should never exceed 500KB
const MAX_CHUNK_SIZE = 500_000;

function validateDayFile(day: string): void {
  if (!DAY_FORMAT.test(day)) {
    throw new Error('Invalid day format. Expected YYYY-MM-DD.');
  }
}

function requireWorkspace(getWorkspacePath: () => string | null): string {
  const wp = getWorkspacePath();
  if (!wp) throw new Error('No active workspace.');
  return wp;
}

function notesDir(workspacePath: string): string {
  return path.join(workspacePath, NOTES_DIR);
}

function ensureNotesDir(workspacePath: string): string {
  const dir = notesDir(workspacePath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Serialize writes per day file to avoid race conditions from concurrent transcriptions
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(dayFile: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(dayFile) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(dayFile, next);
  return next;
}

function formatDateHeader(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Returns a time string rounded down to the nearest 10-minute block, e.g. "14:30". */
function currentTimeBlock(): string {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = (Math.floor(now.getMinutes() / 10) * 10).toString().padStart(2, '0');
  return `${h}:${m}`;
}
