/**
 * Host process service — replaces the previous Podman-based containerService.
 *
 * The agent server, kernel gateway, and any agent tool invocations all run
 * directly as host child processes. The public surface stays the same as the
 * old `containerService` singleton so call sites elsewhere keep working
 * without modification.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as http from 'http';
import log from 'electron-log';
import { commandLogger, parseAppDirFromArgs, type CommandSource } from './commandLogger';
import { captureError } from '../shared/telemetry';
import { ensurePythonVenv, getVenvDir as getPythonVenvDir } from './pythonSetup';
import { getNpmPrefix, getNpmNodeModulesPath } from './nodeSetup';
import { getLoginShellPath, prewarmLoginShellPath } from './shellPath';

const execFileAsync = promisify(execFile);

function findFreePort(start: number, end: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryNext = () => {
      if (port > end) {
        reject(new Error(`No free port in range ${start}-${end}`));
        return;
      }
      const server = net.createServer();
      server.listen(port, '0.0.0.0', () => {
        server.close(() => resolve(port));
      });
      server.on('error', () => {
        port++;
        tryNext();
      });
    };
    tryNext();
  });
}

type ProgressCallback = (stage: string, message: string, percent?: number) => void;

/**
 * Resolve the host Python venv that backs the agent's `python`/`jupyter`
 * invocations. Created on first kernel-gateway start by `ensurePythonVenv`.
 */
function getVenvBin(name: 'python' | 'jupyter' | 'pip'): string {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidate = path.join(getPythonVenvDir(), binDir, `${name}${ext}`);
  if (fs.existsSync(candidate)) return candidate;
  return name;
}

function getAgentServerBundle(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-server.js');
  }
  return path.join(app.getAppPath(), 'dist', 'agent-server.js');
}

/**
 * Build the environment we hand to every host subprocess we spawn (agent
 * server, kernel gateway, esbuild, the agent's Bash tool, the install wrapper,
 * etc). Surfaces the bundled venv + shared npm prefix in three ways:
 *   - COSCIENTIST_VENV_DIR / COSCIENTIST_NPM_PREFIX env vars the install
 *     wrapper reads explicitly
 *   - NODE_PATH so esbuild bundles can resolve modules installed via npm -g
 *   - PATH prepend with the venv bin + npm prefix bin so installed CLIs
 *     (pytest, tsx, etc.) are invocable without a fully-qualified path
 */
function buildSubprocessEnv(): NodeJS.ProcessEnv {
  const venvDir = getPythonVenvDir();
  const npmPrefix = getNpmPrefix();
  const binSep = process.platform === 'win32' ? ';' : ':';
  const venvBinDir = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  const npmBinDir = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  // Use the resolved login-shell PATH (Homebrew/nvm/etc.), not the minimal
  // launchd PATH a Finder/Dock launch inherits, so subprocesses can find
  // user-installed npm/node. Warm on a cache hit; see prewarm in start().
  const existingPath = getLoginShellPath();
  return {
    ...process.env,
    COSCIENTIST_VENV_DIR: venvDir,
    COSCIENTIST_NPM_PREFIX: npmPrefix,
    NODE_PATH: getNpmNodeModulesPath(),
    PATH: [venvBinDir, npmBinDir, existingPath].filter(Boolean).join(binSep),
  };
}

const NODE_HEAP_MB = 1536;

class HostProcessService {
  private startedFlag = false;
  private isStarting = false;
  private currentAgentDir: string | null = null;

  private kernelGatewayProc: ChildProcess | null = null;
  private agentServerProc: ChildProcess | null = null;

  private agentPort: number | null = null;
  private kernelPort: number | null = null;
  private kernelStartPromise: Promise<void> | null = null;

  private lastAgentServerConfig: string | null = null;
  private lastAgentServerWorkspacePath: string | null = null;
  private lastKernelGatewayError: string | null = null;

  // Crash recovery: when the agent server dies unexpectedly we try to bring
  // it back up. Track recent crash timestamps so an immediate respawn loop
  // gives up rather than spinning forever.
  private agentRestartTimestamps: number[] = [];
  private static readonly MAX_RESTARTS_IN_WINDOW = 3;
  private static readonly RESTART_WINDOW_MS = 60_000;

  async start(mountMap: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>, onProgress?: ProgressCallback): Promise<void> {
    if (this.isStarting) return;
    this.isStarting = true;
    try {
      // Resolve the login-shell PATH off the event loop before start()
      // returns, so the synchronous getLoginShellPath() in buildSubprocessEnv
      // (main thread, reached via agentInfrastructure.start → startAgentServer)
      // is guaranteed a warm cache. Overlapped with the symlink sync since
      // neither depends on the other.
      await Promise.all([
        prewarmLoginShellPath(),
        this.syncWorkspaceSymlinks(mountMap),
      ]);
      onProgress?.('ready', 'Host process service ready', 100);
      this.startedFlag = true;
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Make each user-shared directory visible to the agent under the workspace
   * root via a symlink (e.g. ${workspace}/MyResearch → /Users/x/data/MyResearch).
   * This replaces the bind-mounts the container used to do at /data/<name>, so
   * the agent — whose cwd is the workspace — can address shared directories
   * with relative paths the way the workspace guidance describes.
   *
   * Idempotent: existing correct symlinks are left alone; stale symlinks
   * pointing outside the workspace are removed. Real (non-symlink) entries
   * with the same name are never touched.
   */
  private async syncWorkspaceSymlinks(mountMap: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>): Promise<void> {
    const workspaceEntry = mountMap.find((m) => m.containerPath === '/data');
    if (!workspaceEntry) return;
    const workspacePath = workspaceEntry.hostPath;

    const expected = new Map<string, string>();
    for (const m of mountMap) {
      if (!m.containerPath.startsWith('/data/')) continue;
      const name = m.containerPath.slice('/data/'.length);
      // Only top-level mounts become workspace-level symlinks. The drive
      // cache used to live at /data/google-drive/ — we no longer ship that
      // integration, so skip nested paths.
      if (!name || name.includes('/')) continue;
      expected.set(name, m.hostPath);
    }

    for (const [name, target] of expected) {
      const linkPath = path.join(workspacePath, name);
      try {
        const stats = await fs.promises.lstat(linkPath);
        if (stats.isSymbolicLink()) {
          const existing = await fs.promises.readlink(linkPath);
          if (existing === target) continue;
          await fs.promises.unlink(linkPath);
        } else {
          // Something else (real dir/file) already occupies the name — leave
          // it alone so we don't risk losing user data.
          log.warn(`[HostProcess] ${linkPath} exists and is not a symlink; skipping ${target}`);
          continue;
        }
      } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
          log.warn(`[HostProcess] lstat failed for ${linkPath}: ${err.message}`);
          continue;
        }
      }
      try {
        await fs.promises.symlink(target, linkPath, 'dir');
        log.info(`[HostProcess] Linked ${linkPath} → ${target}`);
      } catch (err) {
        log.warn(`[HostProcess] symlink failed ${linkPath} → ${target}: ${(err as Error).message}`);
      }
    }

    // Reap symlinks that point outside the workspace but no longer correspond
    // to a current user directory. Only touch symlinks; never delete real
    // entries.
    try {
      const entries = await fs.promises.readdir(workspacePath, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isSymbolicLink()) continue;
        if (e.name.startsWith('.')) continue;
        if (expected.has(e.name)) continue;
        const linkPath = path.join(workspacePath, e.name);
        let target = '';
        try { target = await fs.promises.readlink(linkPath); } catch { continue; }
        const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(workspacePath, target);
        if (resolvedTarget.startsWith(workspacePath + path.sep) || resolvedTarget === workspacePath) continue;
        try {
          await fs.promises.unlink(linkPath);
          log.info(`[HostProcess] Removed stale workspace symlink ${linkPath}`);
        } catch (err) {
          log.warn(`[HostProcess] Failed to remove stale symlink ${linkPath}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      log.warn(`[HostProcess] Symlink cleanup failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.killProc('kernelGatewayProc');
    this.killProc('agentServerProc');
    this.startedFlag = false;
    this.currentAgentDir = null;
    this.lastAgentServerConfig = null;
    this.lastAgentServerWorkspacePath = null;
  }

  private killProc(field: 'kernelGatewayProc' | 'agentServerProc'): void {
    const proc = this[field];
    if (!proc) return;
    try {
      proc.kill('SIGTERM');
    } catch { /* already dead */ }
    this[field] = null;
  }

  isRunning(): boolean {
    return this.startedFlag;
  }

  isOverlayEnabled(): boolean {
    return false;
  }

  // ─── Command exec ──────────────────────────────────────────────────

  async exec(command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const [bin, ...args] = command;
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        cwd: this.currentAgentDir ?? undefined,
        env: this.getExecEnv(),
        timeout: 600_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  }

  execStreaming(command: string[], onLine: (line: string) => void): Promise<{ exitCode: number }> {
    const [bin, ...args] = command;
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: this.currentAgentDir ?? undefined,
        env: this.getExecEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const handleData = (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      };

      proc.stdout?.on('data', handleData);
      proc.stderr?.on('data', handleData);

      proc.on('close', (code, signal) => {
        if (code === null) {
          log.warn(`[HostProcess] execStreaming killed by signal ${signal}: ${command.join(' ')}`);
          resolve({ exitCode: 1 });
          return;
        }
        resolve({ exitCode: code });
      });

      proc.on('error', (error) => {
        reject(new Error(`exec failed: ${error.message}`));
      });
    });
  }

  async execLogged(
    command: string[],
    meta?: { source?: CommandSource; appDirName?: string | null },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.exec(command);
    commandLogger.log({
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      appDirName: meta?.appDirName ?? parseAppDirFromArgs(command),
      source: meta?.source ?? 'agent',
    });
    return result;
  }

  getAgentPort(): number | null { return this.agentPort; }
  getKernelPort(): number | null { return this.kernelPort; }
  getKernelGatewayUrl(): string | null {
    return this.kernelPort ? `http://localhost:${this.kernelPort}` : null;
  }
  getLastKernelGatewayError(): string | null { return this.lastKernelGatewayError; }

  private getExecEnv(): NodeJS.ProcessEnv {
    return buildSubprocessEnv();
  }

  // ─── Agent server (host child process) ─────────────────────────────

  async ensureAgentFilesInWorkspace(agentDir: string): Promise<void> {
    const academiaDir = path.join(agentDir, '.academia');
    await fs.promises.mkdir(academiaDir, { recursive: true });
    const dest = path.join(academiaDir, 'agent-server.js');
    const src = getAgentServerBundle();
    try {
      await fs.promises.copyFile(src, dest);
    } catch (err) {
      log.error(`[HostProcess] Failed to copy agent server bundle from ${src} → ${dest}: ${(err as Error).message}`);
      throw err;
    }
  }

  async startAgentServer(configJson: string, agentDir: string): Promise<void> {
    this.lastAgentServerConfig = configJson;
    this.lastAgentServerWorkspacePath = agentDir;
    this.currentAgentDir = agentDir;

    if (!this.agentPort) {
      this.agentPort = await findFreePort(23200, 23299);
    }

    if (await this.isAgentServerHealthy()) {
      log.debug('[HostProcess] Agent server already healthy');
      return;
    }

    await this.stopAgentServer({ preserveCache: true });

    const configPath = path.join(agentDir, '.academia', 'agent.json');
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, configJson, 'utf-8');

    const bundlePath = path.join(agentDir, '.academia', 'agent-server.js');
    // The install wrapper and the agent's Bash tool both inherit these.
    // Setting them here means the agent's subprocesses can find the bundled
    // Python venv and the shared npm prefix without guessing.
    const env = {
      ...buildSubprocessEnv(),
      // Required: spawning process.execPath (Electron) without this flag
      // launches a full Electron runtime in the child. The flag makes
      // Electron behave as a plain Node interpreter, which is what the
      // agent-server bundle expects.
      ELECTRON_RUN_AS_NODE: '1',
      COSCIENTIST_AGENT_PORT: String(this.agentPort),
      COSCIENTIST_AGENT_CONFIG: configPath,
      COSCIENTIST_WORKSPACE: agentDir,
    };

    const proc = spawn(process.execPath, [
      `--max-old-space-size=${NODE_HEAP_MB}`,
      bundlePath,
    ], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    (proc.stdin as NodeJS.WritableStream | null)?.end();
    this.agentServerProc = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.info(`[AgentServer] ${line}`);
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.error(`[AgentServer] ${line}`);
      }
    });
    proc.on('exit', (code, signal) => {
      log.warn(`[AgentServer] exited (code=${code}, signal=${signal})`);
      if (this.agentServerProc !== proc) return;
      this.agentServerProc = null;
      // Unexpected exit (we didn't call stop): attempt a restart so an
      // OOM or crashed subprocess doesn't strand the renderer's "waiting
      // for agent" spinner. Throttled to avoid a crash-loop.
      const stoppedByUs = code === 0 || signal === 'SIGTERM';
      if (stoppedByUs) return;
      if (!this.lastAgentServerConfig || !this.lastAgentServerWorkspacePath) return;
      const now = Date.now();
      this.agentRestartTimestamps = this.agentRestartTimestamps.filter(
        t => now - t < HostProcessService.RESTART_WINDOW_MS,
      );
      if (this.agentRestartTimestamps.length >= HostProcessService.MAX_RESTARTS_IN_WINDOW) {
        log.error(`[AgentServer] Crashed ${this.agentRestartTimestamps.length} times in ${HostProcessService.RESTART_WINDOW_MS / 1000}s — giving up`);
        return;
      }
      this.agentRestartTimestamps.push(now);
      const cfg = this.lastAgentServerConfig;
      const dir = this.lastAgentServerWorkspacePath;
      log.warn('[AgentServer] Restarting after unexpected exit');
      // Restart in a microtask so the exit handler doesn't recurse.
      setImmediate(() => {
        this.startAgentServer(cfg, dir).catch((err) => {
          log.error(`[AgentServer] Restart failed: ${(err as Error).message}`);
        });
      });
    });

    const startTime = Date.now();
    while (Date.now() - startTime < 15_000) {
      if (await this.isAgentServerHealthy(2000)) {
        log.info('[HostProcess] Agent server healthy');
        return;
      }
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`Agent server exited before becoming healthy (code=${proc.exitCode}, signal=${proc.signalCode})`);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    this.killProc('agentServerProc');
    throw new Error('Agent server failed to become healthy within 15s');
  }

  private async isAgentServerHealthy(timeoutMs = 1500): Promise<boolean> {
    const port = this.agentPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/health',
        method: 'GET',
        timeout: timeoutMs,
      }, (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  async updateAgentCredentials(apiKey: string, baseURL?: string): Promise<boolean> {
    const port = this.agentPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      // Field names must match the agent-server's /credentials handler —
      // it reads `anthropicApiKey` / `anthropicBaseURL`. Send baseURL as null
      // (not undefined) when absent so the field survives JSON.stringify and the
      // agent's `'anthropicBaseURL' in body` check clears a previously-set URL.
      const body = JSON.stringify({ anthropicApiKey: apiKey, anthropicBaseURL: baseURL ?? null });
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/credentials',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 2000,
      }, (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        res.resume();
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  }

  async stopAgentServer(options?: { preserveCache?: boolean }): Promise<void> {
    this.killProc('agentServerProc');
    if (!options?.preserveCache) {
      this.lastAgentServerConfig = null;
      this.lastAgentServerWorkspacePath = null;
    }
  }

  // ─── Jupyter kernel gateway (host process) ─────────────────────────

  async startKernelGateway(): Promise<void> {
    if (this.kernelStartPromise) return this.kernelStartPromise;
    if (await this.isKernelGatewayHealthy()) {
      this.lastKernelGatewayError = null;
      return;
    }

    this.kernelStartPromise = this._startKernelGateway();
    try {
      await this.kernelStartPromise;
      this.lastKernelGatewayError = null;
    } catch (err) {
      this.lastKernelGatewayError = (err as Error).message;
      throw err;
    } finally {
      this.kernelStartPromise = null;
    }
  }

  private async _startKernelGateway(): Promise<void> {
    await this.stopKernelGateway();

    // Bootstrap the per-app Python venv on first use. Idempotent and fast
    // when already set up. Surfaces a PythonSetupError with installation
    // guidance when the user has no system Python 3.
    await ensurePythonVenv((stage, message) => {
      log.info(`[PythonSetup] ${stage}: ${message}`);
    });

    if (!this.kernelPort) {
      // 23400-23499, disjoint from the original container-era app's host port
      // window (agent 23300-23320, kernel 23330-23350), so both apps running
      // at once don't contend for the same kernel-gateway port.
      this.kernelPort = await findFreePort(23400, 23499);
    }

    const jupyterBin = getVenvBin('jupyter');
    const proc = spawn(jupyterBin, [
      'kernelgateway',
      '--KernelGatewayApp.api=kernel_gateway.jupyter_websocket',
      '--KernelGatewayApp.ip=127.0.0.1',
      `--KernelGatewayApp.port=${this.kernelPort}`,
      '--KernelGatewayApp.allow_origin=*',
      '--KernelGatewayApp.log_level=WARN',
      '--KernelGatewayApp.auth_token=',
      '--ServerApp.token=',
      '--ServerApp.password=',
      '--ServerApp.disable_check_xsrf=True',
    ], {
      env: this.getExecEnv(),
      cwd: this.currentAgentDir ?? undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.kernelGatewayProc = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.info(`[KernelGateway] ${line}`);
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.warn(`[KernelGateway] ${line}`);
      }
    });
    proc.on('exit', (code, signal) => {
      log.warn(`[KernelGateway] exited (code=${code}, signal=${signal})`);
      if (this.kernelGatewayProc === proc) this.kernelGatewayProc = null;
    });

    const startTime = Date.now();
    while (Date.now() - startTime < 15_000) {
      if (await this.isKernelGatewayHealthy(2000)) {
        log.info(`[HostProcess] Kernel gateway healthy at http://localhost:${this.kernelPort}`);
        return;
      }
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(
          `Kernel gateway exited before becoming healthy (code=${proc.exitCode}, signal=${proc.signalCode}). ` +
          `Is jupyter installed in ${getPythonVenvDir()}?`,
        );
      }
      await new Promise(r => setTimeout(r, 250));
    }

    this.killProc('kernelGatewayProc');
    throw new Error('Kernel gateway failed to become healthy within 15s');
  }

  private async isKernelGatewayHealthy(timeoutMs = 1500): Promise<boolean> {
    const port = this.kernelPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/api/kernelspecs',
        method: 'GET',
        timeout: timeoutMs,
      }, (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  async stopKernelGateway(): Promise<void> {
    this.killProc('kernelGatewayProc');
  }

  // ─── Workspace-rooted file write (used by agent-side academiaFile IPC) ─

  async writeContentToContainer(content: string, targetPath: string): Promise<void> {
    const dest = path.isAbsolute(targetPath)
      ? targetPath
      : path.join(this.currentAgentDir ?? app.getPath('userData'), targetPath);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, content, 'utf-8');
  }

  async ensureSetup(_onProgress?: ProgressCallback, _workspacePath?: string): Promise<void> {
    // No container to set up — process service is always ready.
    this.startedFlag = true;
  }
}

export const containerService = new HostProcessService();
export type ContainerService = HostProcessService;
