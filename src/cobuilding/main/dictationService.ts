import { ipcMain, app, type WebContents } from 'electron';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log';

/**
 * Host side of on-device voice dictation.
 *
 * Recognition runs in `src/cobuilding/swift/dictation-mac` — a Swift child
 * process using Apple's Speech framework. It is not in this process because
 * there is no other option: the Agent SDK has no speech-to-text (Claude takes
 * no audio input at all), and Chromium's Web Speech API cannot work in Electron
 * (no SODA models ship, and the network path would upload the microphone to
 * Google). Apple's framework is the only route that keeps audio on the machine,
 * and it is only reachable from native code.
 *
 * One helper process app-wide, owned by whichever WebContents started it — a
 * second microphone stream is never something the user asked for. The helper is
 * kept warm across dictations (~200ms of spawn latency is very visible when
 * it sits between pressing the mic and being able to talk); it holds no audio
 * device while stopped.
 */

export type DictationEvent =
  | { type: 'hello'; pid: number }
  | { type: 'ready'; engine: string; locale: string }
  | { type: 'listening' }
  | { type: 'installing'; locale: string }
  | { type: 'installed'; locale: string }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'level'; rms: number }
  | { type: 'stopped' }
  | { type: 'error'; code: string; message: string };

export interface DictationCapabilities {
  /** False whenever the mic button must not be shown at all. */
  available: boolean;
  /** 'transcriber' (macOS 26+) or 'sfspeech'. Absent when unavailable. */
  engine?: string;
  locale?: string;
  /** False means the first dictation downloads a model — the UI says so. */
  modelInstalled?: boolean;
  micAuth?: string;
  speechAuth?: string;
  /** Populated only when unavailable, for the log and the Debug tab. */
  reason?: string;
}

const DEFAULT_LOCALE = 'en-US';
const PROBE_TIMEOUT_MS = 10_000;

let helper: ChildProcessWithoutNullStreams | null = null;
let ownerWebContents: WebContents | null = null;
let capabilities: DictationCapabilities | null = null;
/** Partial stdout between newlines — a JSON object can span two chunk reads. */
let stdoutBuffer = '';

function binaryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'dictation-mac');
  }
  return path.join(
    app.getAppPath(),
    'src/cobuilding/swift/dictation-mac/build/dictation-mac',
  );
}

/**
 * Capability check. Deliberately spawns `--probe`, which touches neither the
 * microphone nor the recognizer, so asking whether dictation exists can never
 * raise a permission prompt — the prompt has to come from the user pressing the
 * mic button, not from a composer mounting.
 *
 * Cached for the life of the process. The cached fields decide whether the
 * button renders, and none of them change while the app runs; the auth fields
 * can go stale, but they are only ever used for error copy after a failed
 * start, which reports live status itself.
 */
export async function probeDictation(locale = DEFAULT_LOCALE): Promise<DictationCapabilities> {
  if (capabilities) return capabilities;

  if (process.platform !== 'darwin') {
    capabilities = { available: false, reason: 'Dictation requires macOS.' };
    return capabilities;
  }

  const bin = binaryPath();
  if (!fs.existsSync(bin)) {
    // Expected when the Command Line Tools are missing — the build script
    // skips rather than failing, so this is a normal state, not an error.
    capabilities = { available: false, reason: 'Dictation helper not built.' };
    log.info('[Dictation] Helper binary absent at', bin, '— dictation disabled.');
    return capabilities;
  }

  capabilities = await new Promise<DictationCapabilities>((resolve) => {
    execFile(bin, ['--probe', '--locale', locale], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve({ available: false, reason: `Probe failed: ${err.message}` });
        return;
      }
      // The helper logs framework chatter to stderr, but a bad locale also
      // makes Speech print to stdout; take the last parseable line.
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      if (!line) {
        resolve({ available: false, reason: 'Probe returned nothing.' });
        return;
      }
      try {
        const parsed = JSON.parse(line) as DictationCapabilities & { type?: string };
        resolve({
          available: !!parsed.available,
          engine: parsed.engine,
          locale: parsed.locale,
          modelInstalled: parsed.modelInstalled,
          micAuth: parsed.micAuth,
          speechAuth: parsed.speechAuth,
          reason: parsed.available ? undefined : `Locale ${locale} is not supported.`,
        });
      } catch {
        resolve({ available: false, reason: 'Probe output was not valid JSON.' });
      }
    });
  });

  log.info('[Dictation] Capabilities:', JSON.stringify(capabilities));
  return capabilities;
}

function send(event: DictationEvent): void {
  if (!ownerWebContents || ownerWebContents.isDestroyed()) return;
  ownerWebContents.send('dictation:event', event);
}

function handleLine(line: string): void {
  let event: DictationEvent;
  try {
    event = JSON.parse(line) as DictationEvent;
  } catch {
    log.warn('[Dictation] Unparseable helper output:', line.slice(0, 200));
    return;
  }
  // Level events fire ~12x/second; logging them would bury everything else.
  if (event.type !== 'level' && event.type !== 'partial') {
    log.info('[Dictation] Event:', event.type, 'code' in event ? event.code : '');
  }
  send(event);
}

function ensureHelper(): ChildProcessWithoutNullStreams | null {
  if (helper && !helper.killed) return helper;

  const bin = binaryPath();
  if (!fs.existsSync(bin)) return null;

  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  helper = child;
  stdoutBuffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) handleLine(line.trim());
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    log.info('[Dictation:helper]', chunk.trimEnd());
  });

  child.on('exit', (code, signal) => {
    log.info(`[Dictation] Helper exited code=${code} signal=${signal}`);
    // A crash mid-dictation must not leave the UI stuck in "listening" — the
    // renderer clears its recording state on `stopped`.
    send({ type: 'stopped' });
    helper = null;
    ownerWebContents = null;
  });

  child.on('error', (err) => {
    log.error('[Dictation] Helper spawn error:', err);
    send({ type: 'error', code: 'spawn-failed', message: err.message });
    helper = null;
  });

  return child;
}

function write(command: Record<string, unknown>): boolean {
  if (!helper || helper.killed || !helper.stdin.writable) return false;
  helper.stdin.write(`${JSON.stringify(command)}\n`);
  return true;
}

/**
 * Stop dictating for a window that goes away mid-recording — otherwise the mic
 * stays live with nothing left to receive the transcript.
 *
 * Hooked here rather than from an `app.on('web-contents-created')` listener in
 * `registerDictationHandlers`, because that registration runs *after*
 * `createMainWindow()` — the main window's WebContents already exists by then,
 * so the app-level listener would never fire for the one window that matters.
 * Attaching at ownership time has no such ordering dependency.
 */
const watched = new WeakSet<WebContents>();

function watchForDestruction(sender: WebContents): void {
  if (watched.has(sender)) return;
  watched.add(sender);
  sender.once('destroyed', () => {
    if (ownerWebContents === sender) {
      ownerWebContents = null;
      write({ cmd: 'stop' });
    }
  });
}

export async function startDictation(
  sender: WebContents,
  locale = DEFAULT_LOCALE,
): Promise<{ ok: boolean; error?: string }> {
  const caps = await probeDictation(locale);
  if (!caps.available) {
    return { ok: false, error: caps.reason ?? 'Dictation is unavailable.' };
  }

  // Switching owner mid-dictation: stop the old stream first so two composers
  // can't both be fed the same transcript.
  if (ownerWebContents && ownerWebContents !== sender && !ownerWebContents.isDestroyed()) {
    write({ cmd: 'stop' });
  }
  ownerWebContents = sender;
  watchForDestruction(sender);

  if (!ensureHelper()) {
    return { ok: false, error: 'Dictation helper could not be started.' };
  }
  if (!write({ cmd: 'start', locale })) {
    return { ok: false, error: 'Dictation helper is not accepting commands.' };
  }
  return { ok: true };
}

export function stopDictationSession(): { ok: boolean } {
  write({ cmd: 'stop' });
  return { ok: true };
}

/** Full teardown for app quit. Nothing should hold the mic past this point. */
export function stopDictation(): void {
  if (!helper) return;
  const child = helper;
  helper = null;
  ownerWebContents = null;
  try {
    // `quit` releases the audio device before exiting; SIGKILL is the backstop
    // for a helper that is wedged rather than merely busy.
    if (child.stdin.writable) child.stdin.write('{"cmd":"quit"}\n');
    child.stdin.end();
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 1500).unref();
  } catch (err) {
    log.warn('[Dictation] Teardown failed, killing:', err);
    child.kill('SIGKILL');
  }
}

export function registerDictationHandlers(): void {
  ipcMain.handle('dictation:probe', (_e, locale?: string) => probeDictation(locale ?? DEFAULT_LOCALE));

  ipcMain.handle('dictation:start', (event, locale?: string) =>
    startDictation(event.sender, locale ?? DEFAULT_LOCALE),
  );

  ipcMain.handle('dictation:stop', () => stopDictationSession());
}
