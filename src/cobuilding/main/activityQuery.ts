import * as path from 'path';
import { DateTime } from 'luxon';
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
  source?: string; // Comma-separated: 'browser', 'file', 'all', or combos like 'browser,file'
}

export interface ActivityQueryResult {
  query: { since: string; until: string; timezone: string };
  file_sessions?: unknown[];
}

function parseSources(source?: string): Set<string> {
  if (!source || source === 'all') return new Set(['file']);
  return new Set(source.split(',').map(s => s.trim()));
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

  return result;
}
