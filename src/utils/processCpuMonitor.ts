import { execFile } from 'child_process';
import log from 'electron-log';

const POLL_INTERVAL_MS = 60_000;
const CPU_WARNING_THRESHOLD = 80;

const DISCOVERED_PROCESS_NAMES: Record<string, string> = {
  vfkit: 'vm:vfkit',
  gvproxy: 'vm:gvproxy',
  'com.apple.Virtualization.VirtualMachine': 'vm:apple-vz',
};

log.info('[ProcessCPU] Module loaded');

class ProcessCpuMonitor {
  private tracked = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  register(label: string, pid: number): void {
    log.info(`[ProcessCPU] register() called: ${label} (pid=${pid})`);
    this.tracked.set(label, pid);
    this.start();
  }

  unregister(label: string): void {
    log.info(`[ProcessCPU] unregister() called: ${label}`);
    this.tracked.delete(label);
  }

  start(): void {
    log.info(`[ProcessCPU] start() called, timer=${!!this.timer}, tracked=${this.tracked.size}`);
    if (this.timer) return;
    log.info('[ProcessCPU] Starting timer');
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  stop(): void {
    log.info('[ProcessCPU] stop() called');
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tracked.clear();
  }

  private poll(): void {
    execFile('ps', ['-eo', 'pid=,%cpu=,rss=,comm='], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        log.warn(`[ProcessCPU] ps error: ${(error as Error).message}`);
        return;
      }
      if (!stdout.trim()) {
        log.warn('[ProcessCPU] ps returned empty output');
        return;
      }

      const pidToLabel = new Map<number, string>();
      for (const [label, pid] of this.tracked) {
        pidToLabel.set(pid, label);
      }

      const seenPids = new Set<number>();
      const parts: string[] = [];
      let totalLines = 0;
      let matchedLines = 0;

      for (const line of stdout.trim().split('\n')) {
        totalLines++;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;

        const pid = parseInt(cols[0], 10);
        if (isNaN(pid)) continue;
        const cpu = parseFloat(cols[1]);
        const rssMB = Math.round(parseInt(cols[2], 10) / 1024);
        const comm = cols.slice(3).join(' ');

        const commBasename = comm.split('/').pop() || comm;
        const label = pidToLabel.get(pid) || DISCOVERED_PROCESS_NAMES[commBasename];
        if (!label) continue;

        matchedLines++;
        seenPids.add(pid);
        parts.push(`${label}=${cpu}%(${rssMB}MB)`);

        if (cpu > CPU_WARNING_THRESHOLD) {
          log.warn(`[ProcessCPU] WARNING: ${label} using ${cpu}% CPU (pid=${pid})`);
        }
      }

      if (parts.length > 0) {
        log.info(`[ProcessCPU] ${parts.join(' ')} (${matchedLines}/${totalLines})`);
      } else {
        log.info(`[ProcessCPU] no matches (0/${totalLines})`);
      }

      for (const [label, pid] of this.tracked) {
        if (!seenPids.has(pid)) {
          log.info(`[ProcessCPU] ${label} (pid=${pid}) no longer running, removing`);
          this.tracked.delete(label);
        }
      }
    });
  }
}

export const processCpuMonitor = new ProcessCpuMonitor();
log.info('[ProcessCPU] Calling start() from module init');
processCpuMonitor.start();
