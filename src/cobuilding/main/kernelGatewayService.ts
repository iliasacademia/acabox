import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { app } from 'electron';
import http from 'http';
import log from 'electron-log';
import { getBundledPodmanBin, getBundledPodmanEnv } from './podmanBinaries';

const execFileAsync = promisify(execFile);

const CONTAINER_NAME = 'cobuilding-jupyter';
const IMAGE_NAME = 'cobuilding-container';
const CONTAINER_PORT = 8888;

type BinaryMode = 'system' | 'bundled';

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

function readBinaryMode(): BinaryMode {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.binaryMode === 'system' ? 'system' : 'bundled';
  } catch {
    return 'bundled';
  }
}

/** Convert a Windows path to a WSL mount path for Podman volume mounts. */
function toMountPath(hostPath: string): string {
  if (process.platform !== 'win32') return hostPath;
  const match = hostPath.match(/^([A-Za-z]):[/\\](.*)/);
  if (!match) return hostPath;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

/** Find a free port by binding to port 0 and reading the assigned port. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine free port')));
      }
    });
    server.on('error', reject);
  });
}

class KernelGatewayService {
  private cachedUrl: string | null = null;
  private containerRunning = false;

  private getPodmanBin(): string {
    if (readBinaryMode() === 'bundled') {
      return getBundledPodmanBin();
    }
    return 'podman';
  }

  private getExecEnv(): NodeJS.ProcessEnv {
    if (readBinaryMode() === 'bundled') {
      return getBundledPodmanEnv();
    }
    return process.env;
  }

  async start(workspacePath: string): Promise<{ url: string }> {
    // If already running, verify it's healthy
    const existing = await this.getRunningUrl();
    if (existing) {
      try {
        await this.waitForHttp(existing, 3000);
        return { url: existing };
      } catch {
        // Container exists but not responding; restart
        this.stop();
      }
    }

    const podmanBin = this.getPodmanBin();
    const env = this.getExecEnv();

    // Remove any stale container
    try {
      await execFileAsync(podmanBin, ['rm', '-f', CONTAINER_NAME], { env, timeout: 10000 });
    } catch {
      // Container didn't exist
    }

    const hostPort = await findFreePort();
    const mountPath = toMountPath(workspacePath);
    const args = [
      'run', '-d',
      '--name', CONTAINER_NAME,
      '-p', `${hostPort}:${CONTAINER_PORT}`,
      '-v', `${mountPath}:/data`,
      IMAGE_NAME,
      'jupyter', 'kernelgateway',
      '--KernelGatewayApp.api=kernel_gateway.jupyter_websocket',
      '--KernelGatewayApp.ip=0.0.0.0',
      `--KernelGatewayApp.port=${CONTAINER_PORT}`,
      '--KernelGatewayApp.allow_origin=*',
    ];

    log.debug(`[KernelGateway] Running: podman ${args.join(' ')}`);
    await execFileAsync(podmanBin, args, { env, timeout: 30000 });

    const url = `http://localhost:${hostPort}`;
    log.debug(`[KernelGateway] Gateway URL: ${url}`);

    // Wait for the gateway to be ready
    await this.waitForHttp(url);

    this.cachedUrl = url;
    this.containerRunning = true;
    log.debug('[KernelGateway] Gateway ready');
    return { url };
  }

  stop(): void {
    log.debug('[KernelGateway] Stopping...');
    const podmanBin = this.getPodmanBin();
    const env = this.getExecEnv();

    try {
      execFileSync(podmanBin, ['stop', '-t', '3', CONTAINER_NAME], { env, timeout: 10000 });
    } catch {
      // Already stopped
    }

    try {
      execFileSync(podmanBin, ['rm', '-f', CONTAINER_NAME], { env, timeout: 5000 });
    } catch {
      // Already removed
    }

    this.cachedUrl = null;
    this.containerRunning = false;
  }

  getStatus(): { running: boolean; url: string | null } {
    return { running: this.containerRunning, url: this.cachedUrl };
  }

  private async getRunningUrl(): Promise<string | null> {
    try {
      const podmanBin = this.getPodmanBin();
      const env = this.getExecEnv();
      const { stdout } = await execFileAsync(podmanBin, [
        'inspect', '--format', '{{.State.Running}}', CONTAINER_NAME,
      ], { env, timeout: 5000 });

      if (stdout.trim() !== 'true') {
        this.cachedUrl = null;
        this.containerRunning = false;
        return null;
      }

      if (this.cachedUrl) return this.cachedUrl;

      const portResult = await execFileAsync(podmanBin, [
        'port', CONTAINER_NAME, String(CONTAINER_PORT),
      ], { env, timeout: 5000 });

      const portMatch = portResult.stdout.trim().match(/:(\d+)$/m);
      if (!portMatch) return null;

      this.cachedUrl = `http://localhost:${portMatch[1]}`;
      this.containerRunning = true;
      return this.cachedUrl;
    } catch {
      this.cachedUrl = null;
      this.containerRunning = false;
      return null;
    }
  }

  private waitForHttp(url: string, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const req = http.get(`${url}/api/kernelspecs`, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) {
            resolve();
          } else if (Date.now() - start > timeoutMs) {
            reject(new Error('Kernel gateway did not become ready in time'));
          } else {
            setTimeout(attempt, 500);
          }
        });
        req.on('error', () => {
          if (Date.now() - start > timeoutMs) {
            reject(new Error('Kernel gateway did not become ready in time'));
          } else {
            setTimeout(attempt, 500);
          }
        });
        req.end();
      };
      attempt();
    });
  }
}

export const kernelGatewayService = new KernelGatewayService();
