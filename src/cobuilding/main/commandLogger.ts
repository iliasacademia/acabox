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

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
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
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
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
  }
}

export const commandLogger = new CommandLogger();
