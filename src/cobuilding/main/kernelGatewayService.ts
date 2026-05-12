import http from 'http';
import log from 'electron-log';
import { containerService } from './containerService';

/**
 * Thin HTTP client over the Jupyter kernel gateway that runs inside the
 * cobuilding container. Container lifecycle (run, stop, port mapping) and
 * process supervision (start, stop, health watch) live on `containerService`
 * — this file is just the HTTP / IPC surface the renderer talks to.
 */
class KernelGatewayService {
  /** Start (or no-op confirm) the kernel gateway. Returns the host URL. */
  async start(_workspacePath?: string): Promise<{ url: string } | { error: string }> {
    try {
      await containerService.startKernelGateway();
    } catch (err) {
      const message = (err as Error).message;
      log.error('[KernelGateway] start failed:', message);
      return { error: message };
    }
    const url = containerService.getKernelGatewayUrl();
    if (!url) {
      return { error: 'Kernel gateway has no port assigned' };
    }
    return { url };
  }

  /** Stop only the kernel gateway process; container keeps running. */
  async stop(): Promise<void> {
    await containerService.stopKernelGateway();
  }

  /** Restart only the kernel gateway process; preserves the agent session. */
  async restart(): Promise<{ url: string } | { error: string }> {
    await containerService.stopKernelGateway();
    return this.start();
  }

  async getStatus(): Promise<{ running: boolean; url: string | null }> {
    const url = containerService.getKernelGatewayUrl();
    if (!url) return { running: false, url: null };
    const healthy = await this.probe(url);
    return { running: healthy, url: healthy ? url : null };
  }

  async listKernels(): Promise<{ id: string; name: string; execution_state: string; last_activity: string; connections: number }[]> {
    const url = containerService.getKernelGatewayUrl();
    if (!url) return [];
    return new Promise((resolve) => {
      const req = http.get(`${url}/api/kernels`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(5000, () => { req.destroy(); resolve([]); });
      req.end();
    });
  }

  async shutdownKernel(kernelId: string): Promise<boolean> {
    const url = containerService.getKernelGatewayUrl();
    if (!url) return false;
    return new Promise((resolve) => {
      const parsed = new URL(`${url}/api/kernels/${kernelId}`);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'DELETE',
      }, (res) => {
        res.resume();
        resolve(res.statusCode === 204 || res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(5000, () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  private probe(url: string, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${url}/api/kernelspecs`, (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) < 500);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
      req.end();
    });
  }
}

export const kernelGatewayService = new KernelGatewayService();
