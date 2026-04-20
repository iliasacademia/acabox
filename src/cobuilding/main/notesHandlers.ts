import { ipcMain, WebContents } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import log from 'electron-log';
import { getMessages } from './db/chatRepository';
import { analyzeTranscription } from './notesAssistant';
import { SpeechSegmenter, SILERO_CHUNK_SAMPLES } from './sileroVad';

export function registerNotesHandlers(
  getWorkspacePath: () => string | null,
  getAnthropicApiKey: () => string | null,
  getWorkspaceId: () => string | null,
  getOpenAIKey: () => string | null,
): void {
  // One segmenter per renderer session; keyed by WebContents id
  const segmenters = new Map<number, { segmenter: SpeechSegmenter; dayFileRef: { current: string } }>();

  function getOrCreateSegmenter(sender: WebContents, dayFileRef: { current: string }): SpeechSegmenter {
    const existing = segmenters.get(sender.id);
    if (existing) {
      existing.dayFileRef.current = dayFileRef.current;
      return existing.segmenter;
    }

    const ref = { current: dayFileRef.current };
    const segmenter = new SpeechSegmenter(
      (audio) => {
        handleSpeechEnd(audio, ref.current, sender);
        if (!sender.isDestroyed()) sender.send('notes:speechDetected', false);
      },
      () => {
        if (!sender.isDestroyed()) sender.send('notes:speechDetected', true);
      },
    );

    segmenter.init().catch(err => {
      log.error('[SileroVAD] Init failed:', err);
      if (!sender.isDestroyed()) sender.send('notes:transcriptionError', 'VAD model failed to load.');
    });

    segmenters.set(sender.id, { segmenter, dayFileRef: ref });
    sender.once('destroyed', () => segmenters.delete(sender.id));
    return segmenter;
  }

  async function handleSpeechEnd(audio: Float32Array, dayFile: string, sender: WebContents): Promise<void> {
    if (!DAY_FORMAT.test(dayFile)) return;

    const wp = getWorkspacePath();
    if (!wp) return;

    const apiKey = getOpenAIKey();
    if (!apiKey) {
      if (!sender.isDestroyed()) sender.send('notes:transcriptionError', 'No OpenAI API key configured.');
      return;
    }

    // Minimum ~0.5s of audio to avoid sending silence-only segments
    if (audio.length < 8000) return;

    if (!sender.isDestroyed()) sender.send('notes:transcribingStart');

    try {
      const rawText = await transcribeWithOpenAI(audio, apiKey);

      const text = rawText
        .replace(/\[.*?\]/g, '')
        .replace(/(?<!\w)_(?!\w)/g, '')
        .split('\n')
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0)
        .filter((l: string, i: number, arr: string[]) => i === 0 || l.toLowerCase() !== arr[i - 1].toLowerCase())
        .join(' ')
        .replace(/^[.,\s]+/, '')
        .trim();

      if (!text) {
        if (!sender.isDestroyed()) sender.send('notes:transcribingEnd');
        return;
      }

      const writePromise = enqueueWrite(dayFile, async () => {
        const dir = ensureNotesDir(wp);
        const filePath = path.join(dir, `${dayFile}.md`);
        const timeBlock = currentTimeBlock();

        let existing = '';
        try {
          existing = await fsPromises.readFile(filePath, 'utf-8');
        } catch { }

        const headingLine = `## ${timeBlock}`;
        const allHeadings = existing.match(/^## \d{2}:\d{2}$/gm);
        const lastHeading = allHeadings ? allHeadings[allHeadings.length - 1] : null;

        let content: string;
        if (!existing) {
          content = `# Notes - ${formatDateHeader(dayFile)}\n\n${headingLine}\n${text}\n`;
        } else if (lastHeading === headingLine) {
          content = `${existing}\n${text}\n`;
        } else {
          content = `${existing}\n${headingLine}\n${text}\n`;
        }

        await fsPromises.writeFile(filePath, content, 'utf-8');
      });
      await writePromise;

      if (!sender.isDestroyed()) {
        sender.send('notes:transcription', { text, dayFile });
      }

      const anthropicKey = getAnthropicApiKey();
      const workspaceId = getWorkspaceId();
      if (anthropicKey && workspaceId && wp) {
        analyzeTranscription(dayFile, text, wp, anthropicKey, workspaceId, sender, writePromise)
          .catch(err => log.warn('[NotesAssistant] Analysis failed:', err));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transcription failed';
      log.error('[Notes] Transcription error:', message);
      if (!sender.isDestroyed()) {
        sender.send('notes:transcriptionError', message);
      }
    } finally {
      if (!sender.isDestroyed()) sender.send('notes:transcribingEnd');
    }
  }

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

  // Renderer streams 512-sample Float32 PCM chunks (16kHz mono) as base64
  ipcMain.on('notes:audioChunk', (event, data: { chunkBase64: string; dayFile: string }) => {
    const { chunkBase64, dayFile } = data;
    if (!DAY_FORMAT.test(dayFile)) return;

    const buf = Buffer.from(chunkBase64, 'base64');
    if (buf.length !== SILERO_CHUNK_SAMPLES * 4) return; // must be exactly 512 float32 samples

    const samples = new Float32Array(buf.buffer, buf.byteOffset, SILERO_CHUNK_SAMPLES);
    const dayFileRef = { current: dayFile };
    const segmenter = getOrCreateSegmenter(event.sender, dayFileRef);

    // Update the day ref in case it changed
    const entry = segmenters.get(event.sender.id);
    if (entry) entry.dayFileRef.current = dayFile;

    segmenter.processChunk(samples).catch(err => {
      log.error('[SileroVAD] processChunk error:', err);
    });
  });

  ipcMain.on('notes:stopRecording', (event) => {
    const entry = segmenters.get(event.sender.id);
    if (entry) {
      entry.segmenter.flush(); // emit any buffered speech
      entry.segmenter.reset();
    }
  });

  ipcMain.handle('notes:assistantMessages', (_event, dayFile: string) => {
    validateDayFile(dayFile);
    const sessionId = `notes-assistant-${dayFile}`;
    return getMessages(sessionId);
  });
}

// --- Internal helpers ---

const NOTES_DIR = '.notes';
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

async function transcribeWithOpenAI(audio: Float32Array, apiKey: string): Promise<string> {
  const wavBuffer = encodeWav(audio);
  const blob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });
  const formData = new FormData();
  formData.append('file', blob, 'audio.wav');
  formData.append('model', 'gpt-4o-transcribe');
  formData.append('language', 'en');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI transcription failed (${response.status}): ${errText}`);
  }

  const result = await response.json() as { text: string };
  return result.text ?? '';
}

function encodeWav(pcmFloat32: Float32Array, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmFloat32.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcmFloat32.length; i++) {
    const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }

  return buffer;
}

function validateDayFile(day: string): void {
  if (!DAY_FORMAT.test(day)) throw new Error('Invalid day format. Expected YYYY-MM-DD.');
}

function requireWorkspace(getWorkspacePath: () => string | null): string {
  const wp = getWorkspacePath();
  if (!wp) throw new Error('No active workspace.');
  return wp;
}

function notesDir(workspacePath: string): string {
  return path.join(workspacePath, '.notes');
}

function ensureNotesDir(workspacePath: string): string {
  const dir = notesDir(workspacePath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

function currentTimeBlock(): string {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = (Math.floor(now.getMinutes() / 10) * 10).toString().padStart(2, '0');
  return `${h}:${m}`;
}
