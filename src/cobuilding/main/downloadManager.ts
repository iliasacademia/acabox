import { app, BrowserWindow, ipcMain } from 'electron';
import { execFile, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';
import {
  ensureBinariesDownloaded,
  getBundledPodmanBin,
  getBundledPodmanBinDir,
  getBundledPodmanBinIfExists,
  getBundledPodmanEnv,
} from './podmanBinaries';
import {
  ensureImageTarDownloaded,
  getImageCacheDir,
  readLoadedImageVersion,
} from './imageTarManager';
import { getImageTier, writeImageTier } from './containerService';

declare const DOWNLOAD_MANAGER_WINDOW_WEBPACK_ENTRY: string;
declare const DOWNLOAD_MANAGER_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const IS_WINDOWS = process.platform === 'win32';

type StepName = 'podman-download' | 'podman-setup' | 'machine' | 'image-download' | 'image-setup';
type StepStatus = 'pending' | 'active' | 'done' | 'error';

interface StepProgress {
  step: StepName;
  status: StepStatus;
  message: string;
  percent?: number;
}

interface SetupStatus {
  podmanDownload: 'done' | 'needed' | 'partial';
  podmanSetup: 'done' | 'needed';
  machine: 'done' | 'needed';
  imageDownload: 'done' | 'needed' | 'partial';
  imageSetup: 'done' | 'needed';
  currentTier: 'core' | 'full' | null;
}

let dmWindow: BrowserWindow | null = null;
let continueResolve: (() => void) | null = null;

// Track which step failed so retryStep knows where to resume
let lastFailedStep: StepName | null = null;

// Track active child processes so we can kill them on shutdown
const activeChildren = new Set<import('child_process').ChildProcess>();

function killActiveChildren(): void {
  if (activeChildren.size === 0) return;
  log.info(`[DownloadManager] Killing ${activeChildren.size} active child process(es)`);
  for (const proc of activeChildren) {
    try {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 3000);
    } catch { /* already dead */ }
  }
  activeChildren.clear();
}

// ─── Runtime State Detection ─────────────────────────────────────

function getRequiredBinaries(): string[] {
  const binDir = getBundledPodmanBinDir();
  if (IS_WINDOWS) {
    return ['podman.exe', 'gvproxy-windows.exe', 'win-sshproxy.exe'].map(b => path.join(binDir, b));
  }
  return ['podman', 'gvproxy', 'vfkit'].map(b => path.join(binDir, b));
}

function checkBinariesDownloaded(): 'done' | 'needed' | 'partial' {
  const binaries = getRequiredBinaries();
  const existing = binaries.filter(b => fs.existsSync(b));
  if (existing.length === binaries.length) return 'done';
  if (existing.length === 0) return 'needed';
  return 'partial';
}

function checkBinariesSigned(): 'done' | 'needed' {
  if (IS_WINDOWS) {
    return checkBinariesDownloaded() === 'done' ? 'done' : 'needed';
  }
  const binaries = getRequiredBinaries();
  if (!binaries.every(b => fs.existsSync(b))) return 'needed';
  for (const bin of binaries) {
    try {
      execFileSync('/usr/bin/codesign', ['--verify', bin], { stdio: 'ignore' });
    } catch {
      return 'needed';
    }
  }
  return 'done';
}

async function checkMachineState(): Promise<'done' | 'needed'> {
  const podmanBin = getBundledPodmanBinIfExists();
  if (!podmanBin) return 'needed';
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'done';

  try {
    const env = getBundledPodmanEnv();
    const { stdout } = await execAsync(podmanBin, ['machine', 'list', '--format', 'json'], env);
    const machines = JSON.parse(stdout.trim() || '[]');
    if (!Array.isArray(machines) || machines.length === 0) return 'needed';
    return 'done';
  } catch {
    return 'needed';
  }
}

function checkImageDownloaded(tier: 'core' | 'full'): 'done' | 'needed' | 'partial' {
  const cacheDir = getImageCacheDir();
  if (!fs.existsSync(cacheDir)) return 'needed';

  const files = fs.readdirSync(cacheDir);
  const hasTarGz = files.some(f => f.endsWith('.tar.gz'));
  const hasTar = files.some(f => {
    if (!f.endsWith('.tar') || f.endsWith('.tar.gz')) return false;
    if (tier === 'core') return f.startsWith('cobuilding-base-core');
    return f.startsWith('cobuilding-base-') && !f.startsWith('cobuilding-base-core');
  });

  if (hasTar) return 'done';
  if (hasTarGz) return 'partial';
  return 'needed';
}

function checkImageSetup(tier: 'core' | 'full'): 'done' | 'needed' {
  const version = readLoadedImageVersion(tier);
  if (version && checkImageDownloaded(tier) === 'done') return 'done';
  return 'needed';
}

async function detectSetupState(): Promise<SetupStatus> {
  const tier = getImageTier();
  const podmanDownload = checkBinariesDownloaded();
  const podmanSetup = podmanDownload === 'done' ? checkBinariesSigned() : 'needed';
  const machine = podmanSetup === 'done' ? await checkMachineState() : 'needed';
  const imageDownload = checkImageDownloaded(tier);
  const imageSetup = imageDownload === 'done' ? checkImageSetup(tier) : 'needed';

  const currentTier: 'core' | 'full' | null = (() => {
    try {
      const data = JSON.parse(fs.readFileSync(
        path.join(app.getPath('userData'), 'cobuilding-settings.json'), 'utf-8',
      ));
      if (data.imageTier === 'core' || data.imageTier === 'full') return data.imageTier;
    } catch { /* no settings yet */ }
    return null;
  })();

  log.info(`[DownloadManager] State check: podmanDownload=${podmanDownload}, podmanSetup=${podmanSetup}, machine=${machine}, imageDownload=${imageDownload}, imageSetup=${imageSetup}, tier=${currentTier}`);
  return { podmanDownload, podmanSetup, machine, imageDownload, imageSetup, currentTier };
}

function isAllDone(status: SetupStatus): boolean {
  return status.podmanDownload === 'done'
    && status.podmanSetup === 'done'
    && status.machine === 'done'
    && status.imageDownload === 'done'
    && status.imageSetup === 'done';
}

// ─── Partial Download Cleanup ────────────────────────────────────

function cleanupPartialDownloads(): void {
  const binStatus = checkBinariesDownloaded();
  if (binStatus === 'partial') {
    const binDir = getBundledPodmanBinDir();
    log.info(`[DownloadManager] Cleaning up partial binary download: deleting ${binDir}`);
    fs.rmSync(binDir, { recursive: true, force: true });
  }

  const cacheDir = getImageCacheDir();
  if (fs.existsSync(cacheDir)) {
    for (const file of fs.readdirSync(cacheDir)) {
      if (file.endsWith('.tar.gz')) {
        const fullPath = path.join(cacheDir, file);
        log.info(`[DownloadManager] Cleaning up partial image download: deleting ${fullPath}`);
        fs.unlinkSync(fullPath);
      }
    }
  }
}

// ─── Download Orchestration ──────────────────────────────────────

function sendProgress(step: StepName, status: StepStatus, message: string, percent?: number): void {
  const payload: StepProgress = { step, status, message, percent };
  if (dmWindow && !dmWindow.isDestroyed()) {
    dmWindow.webContents.send('dm:progress', payload);
  }
  if (status === 'active' && percent != null && percent % 25 === 0 && percent > 0) {
    log.info(`[DownloadManager] ${step}: ${percent}% — ${message}`);
  }
}

function sendError(step: StepName, message: string): void {
  if (dmWindow && !dmWindow.isDestroyed()) {
    dmWindow.webContents.send('dm:error', { step, message });
  }
  log.error(`[DownloadManager] Step ${step} failed: ${message}`);
}

async function runStep(step: StepName, tier: 'core' | 'full'): Promise<void> {
  const startTime = Date.now();
  log.info(`[DownloadManager] Step ${step} started`);
  sendProgress(step, 'active', 'Starting...', 0);

  try {
    switch (step) {
      case 'podman-download':
        await runPodmanDownload();
        break;
      case 'podman-setup':
        await runPodmanSetup();
        break;
      case 'machine':
        await runMachineSetup();
        break;
      case 'image-download':
        await runImageDownload(tier);
        break;
      case 'image-setup':
        await runImageSetup(tier);
        break;
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info(`[DownloadManager] Step ${step} completed in ${elapsed}s`);
    sendProgress(step, 'done', 'Complete', 100);
  } catch (err) {
    const message = (err as Error).message || String(err);
    const stack = (err as Error).stack;
    log.error(`[DownloadManager] Step ${step} failed: ${message}`);
    if (stack) log.error(`[DownloadManager] Stack: ${stack}`);
    sendProgress(step, 'error', message);
    sendError(step, message);
    lastFailedStep = step;
    throw err;
  }
}

async function runPodmanDownload(): Promise<void> {
  await ensureBinariesDownloaded((stage, message) => {
    if (stage === 'download-percent') {
      const pct = Math.min(100, parseInt(message, 10) || 0);
      sendProgress('podman-download', 'active', 'Downloading Podman binaries...', pct);
    } else if (stage === 'download') {
      sendProgress('podman-download', 'active', message);
    }
  });
}

async function runPodmanSetup(): Promise<void> {
  if (IS_WINDOWS) {
    sendProgress('podman-setup', 'active', 'Binaries ready', 100);
    return;
  }
  const binaries = getRequiredBinaries();
  const names = ['podman', 'gvproxy', 'vfkit'];
  for (let i = 0; i < binaries.length; i++) {
    const name = names[i];
    const bin = binaries[i];
    if (!fs.existsSync(bin)) continue;

    sendProgress('podman-setup', 'active', `Verifying ${name}...`, Math.round((i / binaries.length) * 100));

    try {
      await execAsync('/usr/bin/codesign', ['--verify', bin], process.env);
    } catch {
      sendProgress('podman-setup', 'active', `Signing ${name}...`, Math.round((i / binaries.length) * 100));
      await stripQuarantine(bin);
      await signBinary(bin, name === 'vfkit' ? getVfkitEntitlementsPath() : undefined);
    }
  }
  sendProgress('podman-setup', 'active', 'All binaries verified', 100);
}

async function runMachineSetup(): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    sendProgress('machine', 'active', 'No VM needed on this platform', 100);
    return;
  }

  const podmanBin = getBundledPodmanBin();
  const env = getBundledPodmanEnv();

  // Check if machine is already initialized
  const initialized = await isMachineInitialized(podmanBin, env);
  if (!initialized) {
    sendProgress('machine', 'active', 'Initializing Podman VM (this may take a few minutes)...', 10);
    await spawnAndWait(podmanBin, [
      'machine', 'init', '--user-mode-networking', '--memory', '2048', '--cpus', '2',
    ], env, 'machine init');
  }

  // Check if machine is running
  const running = await isMachineRunning(podmanBin, env);
  if (!running) {
    sendProgress('machine', 'active', 'Starting Podman VM...', 60);
    await spawnAndWait(podmanBin, ['machine', 'start'], env, 'machine start');
  }

  // Verify the API socket is responsive. After a fresh init the VM needs
  // time to boot — use more retries. The connection config can also go stale
  // after restarts, so if the first check fails we do a stop+start cycle
  // (same recovery as containerService.ensureMachineRunning).
  sendProgress('machine', 'active', 'Verifying VM connection...', 80);
  const wasAlreadyRunning = initialized && running;
  const socketReady = await waitForSocket(podmanBin, env, wasAlreadyRunning ? 5 : 15, 3000);

  if (!socketReady) {
    log.warn('[DownloadManager] Podman socket unresponsive, restarting machine to refresh connection config...');
    sendProgress('machine', 'active', 'VM unresponsive, restarting...', 85);

    try {
      await spawnAndWait(podmanBin, ['machine', 'stop'], env, 'machine stop (recovery)');
    } catch (stopErr) {
      log.warn(`[DownloadManager] Machine stop during recovery failed: ${(stopErr as Error).message}`);
    }

    sendProgress('machine', 'active', 'Restarting Podman VM...', 88);
    await spawnAndWait(podmanBin, ['machine', 'start'], env, 'machine start (recovery)');

    const readyAfterRestart = await waitForSocket(podmanBin, env, 15, 3000);
    if (!readyAfterRestart) {
      throw new Error(
        'Podman VM started but API socket is not responding. '
        + 'Try "Clear and Retry All" or restart the application.',
      );
    }
    log.info('[DownloadManager] Machine recovered after restart');
  }
}

async function runImageDownload(tier: 'core' | 'full'): Promise<void> {
  // ensureImageTarDownloaded handles download + verify + decompress.
  // We intercept progress to split into image-download and image-setup steps.
  // For this step, we only care about the download portion.
  // We'll store the result for the setup step to use.
  await ensureImageTarDownloaded(tier, (stage, message) => {
    if (stage === 'image-manifest') {
      sendProgress('image-download', 'active', 'Checking for image updates...', 0);
    } else if (stage === 'image-download') {
      const pctMatch = message.match(/(\d+)%/);
      const pct = pctMatch ? parseInt(pctMatch[1], 10) : undefined;
      sendProgress('image-download', 'active', message, pct);
    } else if (stage === 'image-verify') {
      // Transition to image-setup step
      sendProgress('image-download', 'done', 'Download complete', 100);
      sendProgress('image-setup', 'active', 'Verifying download...', 30);
    } else if (stage === 'image-decompress') {
      sendProgress('image-setup', 'active', 'Decompressing image...', 60);
    }
  });
  // If ensureImageTarDownloaded completed, both download and setup are done
  sendProgress('image-setup', 'done', 'Complete', 100);
}

// image-setup is handled within runImageDownload since ensureImageTarDownloaded
// does download + verify + decompress atomically. This step is only used for retry.
async function runImageSetup(tier: 'core' | 'full'): Promise<void> {
  // On retry, re-run the full ensureImageTarDownloaded — it will skip download
  // if the .tar.gz exists and re-verify + decompress
  await ensureImageTarDownloaded(tier, (stage, message) => {
    if (stage === 'image-verify') {
      sendProgress('image-setup', 'active', 'Verifying download...', 30);
    } else if (stage === 'image-decompress') {
      sendProgress('image-setup', 'active', 'Decompressing image...', 60);
    }
  });
}

const ALL_STEPS: StepName[] = ['podman-download', 'podman-setup', 'machine', 'image-download', 'image-setup'];

// Chain A: podman-download → podman-setup → machine
const CHAIN_A: StepName[] = ['podman-download', 'podman-setup', 'machine'];
// Chain B: image-download → image-setup
const CHAIN_B: StepName[] = ['image-download', 'image-setup'];

function isStepDone(step: StepName, status: SetupStatus): boolean {
  switch (step) {
    case 'podman-download': return status.podmanDownload === 'done';
    case 'podman-setup': return status.podmanSetup === 'done';
    case 'machine': return status.machine === 'done';
    case 'image-download': return status.imageDownload === 'done';
    case 'image-setup': return status.imageSetup === 'done';
  }
}

async function runChain(chain: StepName[], tier: 'core' | 'full', status: SetupStatus): Promise<void> {
  for (const step of chain) {
    if (isStepDone(step, status)) {
      log.info(`[DownloadManager] Step ${step} already done, skipping`);
      sendProgress(step, 'done', 'Already complete', 100);
      continue;
    }

    // image-download handles both download and setup atomically via ensureImageTarDownloaded
    if (step === 'image-setup') {
      sendProgress(step, 'done', 'Complete', 100);
      continue;
    }

    await runStep(step, tier);
  }
}

async function runAllDownloads(tier: 'core' | 'full'): Promise<void> {
  lastFailedStep = null;
  writeImageTier(tier);

  const status = await detectSetupState();

  log.info('[DownloadManager] Running Chain A (podman→setup→machine) and Chain B (image→setup) in parallel');

  const results = await Promise.allSettled([
    runChain(CHAIN_A, tier, status),
    runChain(CHAIN_B, tier, status),
  ]);

  // If either chain failed, throw the first error
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }

  log.info('[DownloadManager] All downloads complete, user can continue');
}

// ─── Subprocess Helpers ──────────────────────────────────────────

function execAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

function spawnAndWait(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log.debug(`[DownloadManager] Spawning: ${label} — ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { env, stdio: 'pipe' });
    activeChildren.add(proc);
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      log.debug(`[DownloadManager] ${label} stdout: ${data.toString().trim()}`);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      log.debug(`[DownloadManager] ${label} stderr: ${data.toString().trim()}`);
    });

    proc.on('error', (err) => {
      activeChildren.delete(proc);
      reject(new Error(`${label} failed to start: ${err.message}`));
    });
    proc.on('close', (code, signal) => {
      activeChildren.delete(proc);
      if (signal) {
        reject(new Error(`${label} was terminated by ${signal}`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function isMachineInitialized(podmanBin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout } = await execAsync(podmanBin, ['machine', 'list', '--format', 'json'], env);
    const machines = JSON.parse(stdout.trim() || '[]');
    return Array.isArray(machines) && machines.length > 0;
  } catch {
    return false;
  }
}

async function isMachineRunning(podmanBin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout } = await execAsync(podmanBin, ['machine', 'list', '--format', 'json'], env);
    const machines = JSON.parse(stdout.trim() || '[]');
    return Array.isArray(machines) && machines.some((m: any) => m.Running === true);
  } catch {
    return false;
  }
}

async function waitForSocket(podmanBin: string, env: NodeJS.ProcessEnv, maxRetries: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await execAsync(podmanBin, ['info', '--format', '{{.Host.RemoteSocket.Exists}}'], env);
      return true;
    } catch {
      log.debug(`[DownloadManager] Socket not ready (attempt ${i + 1}/${maxRetries}), retrying in ${intervalMs}ms...`);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
  }
  return false;
}

function stripQuarantine(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', filePath], (error) => {
      if (error) {
        log.warn(`[DownloadManager] Could not strip quarantine from ${path.basename(filePath)}: ${error.message}`);
      }
      resolve();
    });
  });
}

function signBinary(filePath: string, entitlementsPath?: string): Promise<void> {
  const args = ['--force', '--sign', '-'];
  if (entitlementsPath) {
    args.push('--entitlements', entitlementsPath);
  }
  args.push(filePath);

  return new Promise((resolve, reject) => {
    execFile('/usr/bin/codesign', args, (error) => {
      if (error) {
        reject(new Error(`Could not sign ${path.basename(filePath)}: ${error.message}`));
      } else {
        log.debug(`[DownloadManager] Signed ${path.basename(filePath)}${entitlementsPath ? ' with entitlements' : ''}`);
        resolve();
      }
    });
  });
}

function getVfkitEntitlementsPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'vfkit-entitlements.plist');
  }
  return path.join(app.getAppPath(), 'src', 'cobuilding', 'assets', 'vfkit-entitlements.plist');
}

// ─── Clear and Retry (mirrors scripts/reset-downloads.sh) ────────

function rmPathIfExists(target: string, label: string): void {
  if (!fs.existsSync(target)) return;
  log.info(`[DownloadManager] ${label}: removing ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

/** Remove loadedImageVersion and imageTier from cobuilding-settings.json (same keys as reset-downloads.sh). */
function clearDownloadManagerSettingsKeys(): void {
  const settingsPath = path.join(app.getPath('userData'), 'cobuilding-settings.json');
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    delete data.loadedImageVersion;
    delete data.imageTier;
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
    log.info('[DownloadManager] Cleared loadedImageVersion and imageTier from settings');
  } catch {
    /* no settings file or invalid JSON */
  }
}

/**
 * Same sequence as scripts/reset-downloads.sh: stop + rm machine, remove bundled
 * podman binaries, image cache, isolated Podman HOME + runtime dirs, app-local
 * podman XDG data, then clear download-related settings keys.
 *
 * Call after the Podman machine is stopped so file locks are released; extra
 * `machine stop` here is best-effort (no-op if already stopped).
 */
export function clearAllDownloadStateOnDisk(): void {
  log.info('[DownloadManager] clearAllDownloadStateOnDisk (reset-downloads.sh parity)');

  const podmanBin = getBundledPodmanBinIfExists();
  if (podmanBin) {
    const env = getBundledPodmanEnv();
    try {
      execFileSync(podmanBin, ['machine', 'stop'], { env, timeout: 120_000, stdio: 'ignore' });
    } catch (err) {
      log.debug(`[DownloadManager] machine stop (best-effort): ${(err as Error).message}`);
    }
    try {
      execFileSync(podmanBin, ['machine', 'rm', '-f'], { env, timeout: 120_000, stdio: 'ignore' });
      log.info('[DownloadManager] podman machine rm -f complete');
    } catch (err) {
      log.warn(`[DownloadManager] podman machine rm -f: ${(err as Error).message}`);
    }
  } else {
    log.warn('[DownloadManager] No bundled podman binary; skipping machine stop/rm');
  }

  rmPathIfExists(getBundledPodmanBinDir(), 'bundled podman binaries');
  rmPathIfExists(path.join(app.getPath('userData'), 'cobuilding-podman-data'), 'podman XDG data under userData');
  rmPathIfExists(getImageCacheDir(), 'image tar cache');

  const suffix = app.isPackaged ? '' : '-dev';
  rmPathIfExists(path.join(os.homedir(), `.cobuild-podman${suffix}`), 'Podman HOME');
  rmPathIfExists(path.join(os.tmpdir(), `cobuild-podman-run${suffix}`), 'Podman runtime dir');

  clearDownloadManagerSettingsKeys();
}

function clearAllState(): void {
  log.info('[DownloadManager] Clear and retry all requested');
  clearAllDownloadStateOnDisk();
}

// ─── Window Lifecycle ────────────────────────────────────────────

function createDownloadManagerWindow(): BrowserWindow {
  log.info('[DownloadManager] Creating download manager window');

  const win = new BrowserWindow({
    width: 520,
    height: 600,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Academia Coscientist — Setup',
    show: false,
    webPreferences: {
      preload: DOWNLOAD_MANAGER_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL(DOWNLOAD_MANAGER_WINDOW_WEBPACK_ENTRY);

  win.once('ready-to-show', () => {
    log.info('[DownloadManager] Window ready-to-show');
    win.show();
  });

  win.on('closed', () => {
    log.info('[DownloadManager] Window closed');
    killActiveChildren();
    dmWindow = null;
    if (continueResolve) {
      continueResolve();
      continueResolve = null;
    }
  });

  return win;
}

// ─── IPC Registration ────────────────────────────────────────────

export function registerDownloadManagerIpc(): void {
  app.on('before-quit', () => {
    log.info('[DownloadManager] App quitting, cleaning up child processes');
    killActiveChildren();
  });

  ipcMain.handle('dm:getStatus', async () => {
    return detectSetupState();
  });

  ipcMain.handle('dm:startDownloads', async (_event, tier: 'core' | 'full') => {
    log.info(`[DownloadManager] Starting downloads for tier: ${tier}`);
    await runAllDownloads(tier);
  });

  ipcMain.handle('dm:retryStep', async (_event, step: StepName) => {
    log.info(`[DownloadManager] Retrying step: ${step}`);
    const tier = getImageTier();
    lastFailedStep = null;

    // Determine which chain this step belongs to and run remaining steps in that chain
    const chain = CHAIN_A.includes(step) ? CHAIN_A : CHAIN_B;
    const stepIdx = chain.indexOf(step);
    const remainingSteps = chain.slice(stepIdx);

    const status = await detectSetupState();
    for (const s of remainingSteps) {
      if (s === 'image-setup' && s !== step) {
        sendProgress(s, 'done', 'Complete', 100);
        continue;
      }
      await runStep(s, tier);
    }
    log.info('[DownloadManager] Chain complete after retry, user can continue');
  });

  ipcMain.handle('dm:clearAndRetryAll', async () => {
    const tier = getImageTier();
    clearAllState();
    await runAllDownloads(tier);
  });

  ipcMain.handle('dm:clearImageDownloadState', () => {
    clearAllDownloadStateOnDisk();
  });

  ipcMain.handle('dm:continue', () => {
    log.info('[DownloadManager] User clicked Continue');
    if (dmWindow && !dmWindow.isDestroyed()) {
      dmWindow.close();
    }
    if (continueResolve) {
      continueResolve();
      continueResolve = null;
    }
  });
}

// ─── Public Entry Point ──────────────────────────────────────────

export async function showDownloadManagerIfNeeded(createMainWindow: () => void): Promise<void> {
  cleanupPartialDownloads();

  const status = await detectSetupState();

  if (isAllDone(status)) {
    log.info('[DownloadManager] Setup already complete, skipping download manager');
    createMainWindow();
    return;
  }

  log.info('[DownloadManager] Setup incomplete, showing download manager');
  dmWindow = createDownloadManagerWindow();

  return new Promise<void>((resolve) => {
    continueResolve = () => {
      createMainWindow();
      resolve();
    };
  });
}
