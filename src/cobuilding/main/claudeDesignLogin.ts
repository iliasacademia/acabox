/**
 * Settings → Claude Design: drives the bundled CLI's `design-login --json`
 * subcommand so the agent's `DesignSync` tool has a credential to use.
 *
 * The protocol, and why the environment and config dir matter, are documented
 * in `shared/claudeDesign.ts`. This file only spawns, relays, and cleans up.
 *
 * One flow at a time. A second `signIn` while one is running is refused
 * rather than restarting it: the CLI's browser page is bound to the process
 * that printed it, so killing that process would strand a page the user may
 * be halfway through.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import log from 'electron-log';
import { validateExternalUrl } from '../../utils/urlValidation';
import { getClaudeConfigDir } from './claudeConfigDir';
import {
  DESIGN_LOGIN_TIMEOUT_MS,
  buildDesignLoginEnv,
  claudeBinaryCandidates,
  encodeManualCode,
  pageToOpen,
  parseDesignLoginLine,
  parseDesignStatusLine,
  type DesignLoginEvent,
  type DesignLoginStatus,
} from '../shared/claudeDesign';

const STATUS_TIMEOUT_MS = 20_000;

interface ActiveFlow {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  lastPage: string | null;
  finished: boolean;
}

let active: ActiveFlow | null = null;

function resolveClaudeBinary(): { bin: string } | { error: string } {
  const candidates = claudeBinaryCandidates({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    arch: process.arch,
  });
  const bin = candidates.find((candidate) => fs.existsSync(candidate));
  if (bin) return { bin };
  return { error: `Claude executable not found. Looked in:\n  ${candidates.join('\n  ')}` };
}

function spawnDesignLogin(bin: string, args: string[]): ChildProcess {
  return spawn(bin, ['design-login', '--json', ...args], {
    env: buildDesignLoginEnv(process.env, getClaudeConfigDir()),
    // stdin must be a pipe: the CLI refuses a TTY, and the manual-code
    // fallback arrives on it.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function openPage(url: string): void {
  const validation = validateExternalUrl(url);
  if (!validation.isValid) {
    log.warn(`[ClaudeDesign] Refused to open sign-in page "${url}": ${validation.error}`);
    return;
  }
  shell.openExternal(url).catch((err: Error) => {
    log.warn(`[ClaudeDesign] shell.openExternal failed: ${err.message}`);
  });
}

export async function getDesignLoginStatus(): Promise<DesignLoginStatus> {
  const resolved = resolveClaudeBinary();
  if ('error' in resolved) {
    return { available: false, signedIn: false, canSignInHere: false, reason: resolved.error };
  }

  return new Promise((resolve) => {
    const child = spawnDesignLogin(resolved.bin, ['--status']);
    child.stdin?.end();
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), STATUS_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ available: false, signedIn: false, canSignInHere: false, reason: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const status = stdout.split('\n').map(parseDesignStatusLine).find(Boolean);
      if (status) {
        resolve(status);
        return;
      }
      log.warn(`[ClaudeDesign] --status exited ${code} without a status line. stderr: ${stderr.trim().slice(-500)}`);
      resolve({
        available: false,
        signedIn: false,
        canSignInHere: false,
        reason: stderr.trim().split('\n').pop() || `The status check exited with code ${code}.`,
      });
    });
  });
}

export function startDesignLogin(emit: (event: DesignLoginEvent) => void): { ok: true } | { ok: false; error: string } {
  if (active) return { ok: false, error: 'A Claude Design sign-in is already in progress.' };

  const resolved = resolveClaudeBinary();
  if ('error' in resolved) return { ok: false, error: resolved.error };

  const child = spawnDesignLogin(resolved.bin, []);
  const flow: ActiveFlow = {
    child,
    lastPage: null,
    finished: false,
    timer: setTimeout(() => {
      log.warn('[ClaudeDesign] Sign-in outlived the CLI timeout; killing it.');
      child.kill('SIGTERM');
    }, DESIGN_LOGIN_TIMEOUT_MS),
  };
  active = flow;

  const finish = (event: Extract<DesignLoginEvent, { state: 'done' }>) => {
    if (flow.finished) return;
    flow.finished = true;
    emit(event);
  };

  let stderrTail = '';
  child.stderr?.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });

  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    const event = parseDesignLoginLine(line);
    if (!event) return;
    if (event.state === 'waiting') {
      flow.lastPage = pageToOpen(event);
      openPage(flow.lastPage);
      emit(event);
    } else {
      log.info(`[ClaudeDesign] Sign-in finished: ${event.ok ? 'ok' : event.message}`);
      finish(event);
    }
  });

  child.on('error', (err) => {
    finish({ state: 'done', ok: false, message: err.message });
  });

  child.on('close', (code, signal) => {
    clearTimeout(flow.timer);
    if (active === flow) active = null;
    if (!flow.finished) {
      const detail = stderrTail.trim().split('\n').pop();
      log.warn(`[ClaudeDesign] Sign-in exited (code ${code}, signal ${signal}) without a result. stderr: ${stderrTail.trim()}`);
      finish({
        state: 'done',
        ok: false,
        message: signal === 'SIGTERM' ? 'The sign-in was cancelled.' : detail || `The sign-in exited with code ${code}.`,
      });
    }
  });

  return { ok: true };
}

export function submitDesignLoginCode(raw: string): { ok: true } | { ok: false; error: string } {
  if (!active || !active.child.stdin || active.child.stdin.destroyed) {
    return { ok: false, error: 'No Claude Design sign-in is waiting for a code.' };
  }
  const line = encodeManualCode(raw);
  if (!line) return { ok: false, error: 'Paste the code from the sign-in page first.' };
  active.child.stdin.write(line);
  return { ok: true };
}

export function reopenDesignLoginPage(): { ok: boolean } {
  if (!active?.lastPage) return { ok: false };
  openPage(active.lastPage);
  return { ok: true };
}

export function cancelDesignLogin(): void {
  active?.child.kill('SIGTERM');
}

export function registerClaudeDesignHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('claudeDesign:getStatus', () => getDesignLoginStatus());
  ipcMain.handle('claudeDesign:signIn', () =>
    startDesignLogin((event) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('claudeDesign:event', event);
    }),
  );
  ipcMain.handle('claudeDesign:submitCode', (_e, code: string) => submitDesignLoginCode(String(code ?? '')));
  ipcMain.handle('claudeDesign:reopenPage', () => reopenDesignLoginPage());
  ipcMain.handle('claudeDesign:cancel', () => cancelDesignLogin());
  // Quit cleanup is a step in main/index.ts's `appTeardown`, not a listener
  // here: `handleWillQuit` is the sole `will-quit` listener by design.
}
