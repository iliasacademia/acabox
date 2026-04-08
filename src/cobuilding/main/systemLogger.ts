import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';

export interface SystemLogEntry {
  id: number;
  timestamp: string;
  level: string;
  text: string;
}

class SystemLogger {
  private entries: SystemLogEntry[] = [];
  private nextId = 1;
  private maxEntries = 10_000;
  private listeners = new Set<(entry: SystemLogEntry) => void>();
  private logFilePath: string | null = null;

  init(): void {
    try {
      this.logFilePath = path.join(app.getPath('userData'), 'cobuilding-system-log.jsonl');
      this.loadFromDisk();
      this.installTransport();
    } catch (err) {
      // Can't use log here — would recurse
      console.error('[SystemLogger] Failed to init:', err);
    }
  }

  private loadFromDisk(): void {
    if (!this.logFilePath || !fs.existsSync(this.logFilePath)) return;
    try {
      const content = fs.readFileSync(this.logFilePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const recent = lines.slice(-this.maxEntries);
      for (const line of recent) {
        try {
          const entry = JSON.parse(line) as SystemLogEntry;
          this.entries.push(entry);
          if (entry.id >= this.nextId) {
            this.nextId = entry.id + 1;
          }
        } catch {
          // skip malformed
        }
      }
      if (lines.length > this.maxEntries) {
        this.rewriteDisk();
      }
    } catch {
      // ignore
    }
  }

  private appendToDisk(entry: SystemLogEntry): void {
    if (!this.logFilePath) return;
    try {
      fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // ignore
    }
  }

  private rewriteDisk(): void {
    if (!this.logFilePath) return;
    try {
      const content = this.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(this.logFilePath, content, 'utf-8');
    } catch {
      // ignore
    }
  }

  private installTransport(): void {
    // Add a custom electron-log transport that captures all log output
    const self = this;
    (log.transports as any).systemLogger = (message: any) => {
      const level: string = message.level ?? 'info';
      const text: string = message.data
        ?.map((d: any) => (typeof d === 'string' ? d : JSON.stringify(d)))
        .join(' ') ?? '';
      self.add(level, text);
    };
    (log.transports as any).systemLogger.level = 'debug';
  }

  private add(level: string, text: string): void {
    const entry: SystemLogEntry = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      level,
      text,
    };
    this.entries.push(entry);
    this.appendToDisk(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
      this.rewriteDisk();
    }
    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  getAll(): SystemLogEntry[] {
    return [...this.entries];
  }

  onEntry(listener: (entry: SystemLogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  clear(): void {
    this.entries = [];
    this.nextId = 1;
    if (this.logFilePath && fs.existsSync(this.logFilePath)) {
      fs.unlinkSync(this.logFilePath);
    }
  }
}

export const systemLogger = new SystemLogger();
