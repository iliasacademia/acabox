import { ipcMain } from 'electron';
import * as os from 'os';
import { promises as fsPromises } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Host stats for the renderer status bar (`stats:get`). */
export interface SystemStats {
  /** System-wide CPU busy % since the previous stats:get call. */
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  /** null when statfs is unavailable — the UI hides the segment. */
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  appUptimeSec: number;
}

let lastCpuSample: { idle: number; total: number } | null = null;

function sampleCpu(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  return { idle, total };
}

/**
 * Activity Monitor's "Memory Used": App Memory (anonymous − purgeable)
 * + wired + compressed. Plain total-free is useless on macOS: the kernel
 * keeps file cache resident, so freemem() makes memory read ~full at all
 * times.
 */
async function memUsedBytesDarwin(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/vm_stat');
    const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 16384);
    const pages = (label: string) =>
      Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
    const used =
      pages('Anonymous pages') -
      pages('Pages purgeable') +
      pages('Pages wired down') +
      pages('Pages occupied by compressor');
    return used > 0 ? used * pageSize : null;
  } catch {
    return null;
  }
}

export function registerSystemStatsHandlers(): void {
  ipcMain.handle('stats:get', async (): Promise<SystemStats> => {
    // CPU% over the window since the last call (first call: since boot).
    const sample = sampleCpu();
    const prev = lastCpuSample ?? { idle: 0, total: 0 };
    lastCpuSample = sample;
    const totalDelta = sample.total - prev.total;
    const idleDelta = sample.idle - prev.idle;
    const cpuPercent =
      totalDelta > 0 ? Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100))) : 0;

    const memTotalBytes = os.totalmem();
    const memUsedBytes =
      (process.platform === 'darwin' ? await memUsedBytesDarwin() : null) ??
      memTotalBytes - os.freemem();

    let diskUsedBytes: number | null = null;
    let diskTotalBytes: number | null = null;
    try {
      // homedir, not '/': on APFS the root is the sealed system volume; the
      // user's data volume is what "disk" means to them.
      const st = await fsPromises.statfs(os.homedir());
      diskTotalBytes = st.blocks * st.bsize;
      diskUsedBytes = (st.blocks - st.bfree) * st.bsize;
    } catch {
      // statfs unavailable on this platform/Node — segment stays hidden.
    }

    return {
      cpuPercent,
      memUsedBytes,
      memTotalBytes,
      diskUsedBytes,
      diskTotalBytes,
      appUptimeSec: Math.floor(process.uptime()),
    };
  });
}
