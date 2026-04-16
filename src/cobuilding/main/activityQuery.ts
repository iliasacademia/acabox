import * as path from 'path';
import * as fs from 'fs';
import { DateTime } from 'luxon';
import { getBrowserSessionsByTimeRange } from './browserMonitor/repository';
import { getFileSessionsByTimeRange } from './fileMonitor/repository';
import { getSessionFilesBySessionIds } from './db/sessionFilesRepository';
import { utcToLocal, toUtcIso, getLocalTimezone } from '../../shared/utils';

let getWorkspacePath: () => string | null = () => null;

export function initActivityQuery(workspacePathGetter: () => string | null): void {
  getWorkspacePath = workspacePathGetter;
}

export interface ActivityQueryParams {
  since?: string;
  until?: string;
  period?: 'today' | 'last_2h' | 'last_24h' | 'this_week';
  search?: string;
  source?: string; // Comma-separated: 'browser', 'file', 'notes', 'all', or combos like 'browser,notes'
}

export interface NotesSession {
  file_path: string;
  date: string;
  time_blocks: string[];
}

export interface ActivityQueryResult {
  query: { since: string; until: string; timezone: string };
  browser_sessions?: { domain: string; sessions: unknown[] }[];
  file_sessions?: unknown[];
  notes_sessions?: NotesSession[];
}

function parseSources(source?: string): Set<string> {
  if (!source || source === 'all') return new Set(['browser', 'file', 'notes']);
  return new Set(source.split(',').map(s => s.trim()));
}

const AUTH_PATH_PATTERN = /\/(auth|login|signin|sign-in|logout|signup|sign-up|oauth|sso|callback|saml|cas)\b/i;
const AUTH_HOST_PATTERN = /\b(auth|login|signin|signup|oauth|sso|accounts|id)\./i;
const LOCAL_HOST_PATTERN = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

function isFilteredUrl(url: string): boolean {
  if (AUTH_PATH_PATTERN.test(url) || AUTH_HOST_PATTERN.test(url)) return true;
  try {
    return LOCAL_HOST_PATTERN.test(new URL(url).host);
  } catch {
    return false;
  }
}

export function periodToSince(period?: string): string | null {
  const now = DateTime.now();
  switch (period) {
    case 'today':
      return now.startOf('day').toUTC().toISO();
    case 'last_2h':
      return now.minus({ hours: 2 }).toUTC().toISO();
    case 'last_24h':
      return now.minus({ hours: 24 }).toUTC().toISO();
    case 'this_week':
      return now.startOf('week', { useLocaleWeeks: true }).toUTC().toISO();
    default:
      return null;
  }
}

export function queryActivity(params: ActivityQueryParams): ActivityQueryResult | { error: string } {
  const { search } = params;
  const sources = parseSources(params.source);

  const rawSince = params.since ?? periodToSince(params.period) ?? undefined;
  if (!rawSince) {
    return { error: 'Either "since" or "period" is required' };
  }

  const since = toUtcIso(rawSince);
  const until = toUtcIso(params.until || new Date().toISOString());

  const result: ActivityQueryResult = {
    query: { since: utcToLocal(since), until: utcToLocal(until), timezone: getLocalTimezone() },
  };

  if (sources.has('browser')) {
    const rawSessions = getBrowserSessionsByTimeRange(since, until, search)
      .filter((s) => !isFilteredUrl(s.url) && s.snapshot_count > 1);

    const sessions = rawSessions.map((s) => ({
      ...s,
      first_seen: utcToLocal(s.first_seen),
      last_snapshot: utcToLocal(s.last_snapshot),
    }));

    // Always look up full_text_path
    const browserSessionIds = sessions.map((s) => s.id);
    const browserSessionFiles = getSessionFilesBySessionIds('browser', browserSessionIds);

    const enrichedSessions = sessions
      .map((session) => {
        const sessionFiles = browserSessionFiles.get(session.id);
        const fullTextFile = sessionFiles?.find((f) => f.file_type === 'full_text');
        return { ...session, full_text_path: fullTextFile?.file_path ?? null };
      })
      .filter((s) => s.full_text_path !== null);

    // Group by domain
    const grouped: Record<string, unknown[]> = {};
    for (const session of enrichedSessions) {
      try {
        const domain = new URL(session.url).hostname;
        if (!grouped[domain]) grouped[domain] = [];
        grouped[domain].push(session);
      } catch {
        const key = 'unknown';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(session);
      }
    }
    result.browser_sessions = Object.entries(grouped).map(([domain, sessions]) => ({ domain, sessions }));
  }

  if (sources.has('file')) {
    const workspacePath = getWorkspacePath();
    const fileSessions = getFileSessionsByTimeRange(since, until, search).map((s) => ({
      ...s,
      first_seen: utcToLocal(s.first_seen),
      last_seen: utcToLocal(s.last_seen),
    }));

    const fileSessionIds = fileSessions.map((s) => s.id);
    const fileSessionFiles = getSessionFilesBySessionIds('file', fileSessionIds);

    result.file_sessions = fileSessions.map((session) => {
      const snapshotPath = session.snapshot_ulid && workspacePath
        ? path.join(workspacePath, '.academia', 'temp_files', `${session.snapshot_ulid}${path.extname(session.document_url)}`)
        : null;

      const sessionFiles = fileSessionFiles.get(session.id);
      const fullTextFile = sessionFiles?.find((f) => f.file_type === 'full_text');

      const diffPath = session.diff_ulid && workspacePath
        ? path.join(workspacePath, '.academia', 'temp_files', `${session.diff_ulid}.txt`)
        : null;

      return { ...session, snapshot_path: snapshotPath, full_text_path: fullTextFile?.file_path ?? null, diff_path: diffPath };
    });
  }

  if (sources.has('notes')) {
    const workspacePath = getWorkspacePath();
    if (workspacePath) {
      result.notes_sessions = queryNotesSessions(workspacePath, since, until);
    } else {
      result.notes_sessions = [];
    }
  }

  return result;
}

function queryNotesSessions(workspacePath: string, sinceUtc: string, untilUtc: string): NotesSession[] {
  const notesDir = path.join(workspacePath, '.notes');
  let entries: string[];
  try {
    entries = fs.readdirSync(notesDir).filter(e => e.endsWith('.md'));
  } catch {
    return [];
  }

  const sinceLocal = DateTime.fromISO(sinceUtc, { zone: 'utc' }).toLocal();
  const untilLocal = DateTime.fromISO(untilUtc, { zone: 'utc' }).toLocal();
  const sinceDate = sinceLocal.toFormat('yyyy-MM-dd');
  const untilDate = untilLocal.toFormat('yyyy-MM-dd');

  const sessions: NotesSession[] = [];

  for (const entry of entries) {
    const date = entry.replace(/\.md$/, '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < sinceDate || date > untilDate) continue;

    const filePath = path.join(notesDir, entry);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Parse ## HH:MM headings
    const headingPattern = /^## (\d{2}:\d{2})$/gm;
    const timeBlocks: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(content)) !== null) {
      const blockTime = match[1];
      const blockDt = DateTime.fromISO(`${date}T${blockTime}`, { zone: 'local' });
      if (blockDt >= sinceLocal && blockDt <= untilLocal) {
        timeBlocks.push(blockTime);
      }
    }

    if (timeBlocks.length > 0) {
      sessions.push({
        file_path: `.notes/${entry}`,
        date,
        time_blocks: timeBlocks,
      });
    }
  }

  return sessions;
}
