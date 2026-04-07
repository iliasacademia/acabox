import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';

export type CommandSource = 'agent' | 'iframe';

export interface CommandLogEntry {
  id: number;
  timestamp: string;
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  appDirName: string | null;
  source: CommandSource;
}

const MAX_OUTPUT_BYTES = 10 * 1024; // 10KB per field

function truncate(str: string): string {
  if (str.length <= MAX_OUTPUT_BYTES) return str;
  return str.slice(0, MAX_OUTPUT_BYTES) + `\n... (truncated, ${str.length} bytes total)`;
}

export function parseAppDirFromArgs(args: string[]): string | null {
  const joined = args.join(' ');
  const match = joined.match(/\.applications\/([^/\s"']+)/);
  return match ? match[1] : null;
}

class CommandLogger {
  private entries: CommandLogEntry[] = [];
  private nextId = 1;
  private maxEntries: number;
  private listeners = new Set<(entry: CommandLogEntry) => void>();
  private logFilePath: string | null = null;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  init(): void {
    try {
      this.logFilePath = path.join(app.getPath('userData'), 'cobuilding-command-log.jsonl');
      this.loadFromDisk();
    } catch (err) {
      log.warn('[CommandLogger] Failed to load log from disk:', err);
    }
  }

  private loadFromDisk(): void {
    if (!this.logFilePath || !fs.existsSync(this.logFilePath)) return;
    try {
      const content = fs.readFileSync(this.logFilePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      // Keep only the last maxEntries lines
      const recent = lines.slice(-this.maxEntries);
      for (const line of recent) {
        try {
          const entry = JSON.parse(line) as CommandLogEntry;
          this.entries.push(entry);
          if (entry.id >= this.nextId) {
            this.nextId = entry.id + 1;
          }
        } catch {
          // skip malformed lines
        }
      }
      // If file had more than maxEntries, rewrite it trimmed
      if (lines.length > this.maxEntries) {
        this.rewriteDisk();
      }
      log.debug(`[CommandLogger] Loaded ${this.entries.length} entries from disk`);
    } catch (err) {
      log.warn('[CommandLogger] Failed to read log file:', err);
    }
  }

  private appendToDisk(entry: CommandLogEntry): void {
    if (!this.logFilePath) return;
    try {
      fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      log.warn('[CommandLogger] Failed to append to log file:', err);
    }
  }

  private rewriteDisk(): void {
    if (!this.logFilePath) return;
    try {
      const content = this.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(this.logFilePath, content, 'utf-8');
    } catch (err) {
      log.warn('[CommandLogger] Failed to rewrite log file:', err);
    }
  }

  log(entry: Omit<CommandLogEntry, 'id' | 'timestamp'>): CommandLogEntry {
    const full: CommandLogEntry = {
      ...entry,
      stdout: truncate(entry.stdout),
      stderr: truncate(entry.stderr),
      id: this.nextId++,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(full);
    this.appendToDisk(full);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
      this.rewriteDisk();
    }
    log.debug(`[CommandLogger] ${entry.source} command (app=${entry.appDirName ?? 'none'}): ${entry.command.join(' ').slice(0, 120)}`);
    for (const listener of this.listeners) {
      listener(full);
    }
    return full;
  }

  getAll(): CommandLogEntry[] {
    return [...this.entries];
  }

  getByApp(appDirName: string): CommandLogEntry[] {
    return this.entries.filter(e => e.appDirName === appDirName);
  }

  getAppNames(): string[] {
    const names = new Set<string>();
    for (const e of this.entries) {
      if (e.appDirName) names.add(e.appDirName);
    }
    return [...names].sort();
  }

  onEntry(listener: (entry: CommandLogEntry) => void): () => void {
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

export const commandLogger = new CommandLogger();
