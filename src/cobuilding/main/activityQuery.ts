import * as path from 'path';
import { DateTime } from 'luxon';
import { getBrowserSessionsByTimeRange } from './browserMonitor/repository';
import { getFileSessionsByTimeRange } from './fileMonitor/repository';
import { getSessionFilesBySessionIds } from './db/sessionFilesRepository';
import { utcToLocal, getLocalTimezone } from '../../shared/utils';

let getWorkspacePath: () => string | null = () => null;

export function initActivityQuery(workspacePathGetter: () => string | null): void {
  getWorkspacePath = workspacePathGetter;
}

export interface ActivityQueryParams {
  since?: string;
  until?: string;
  period?: 'today' | 'last_2h' | 'last_24h' | 'this_week';
  search?: string;
  source?: 'browser' | 'file' | 'all';
  include_content?: boolean;
}

export interface ActivityQueryResult {
  query: { since: string; until: string; timezone: string };
  browser_sessions?: unknown[];
  file_sessions?: unknown[];
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
  const { search, source = 'all', include_content = false } = params;

  const since = params.since ?? periodToSince(params.period) ?? undefined;
  if (!since) {
    return { error: 'Either "since" or "period" is required' };
  }

  const until = params.until || new Date().toISOString();

  const result: ActivityQueryResult = {
    query: { since: utcToLocal(since), until: utcToLocal(until), timezone: getLocalTimezone() },
  };

  if (source === 'all' || source === 'browser') {
    const rawSessions = getBrowserSessionsByTimeRange(since, until, search);
    result.browser_sessions = rawSessions.map((s) => ({
      ...s,
      first_seen: utcToLocal(s.first_seen),
      last_snapshot: utcToLocal(s.last_snapshot),
    }));
  }

  if (source === 'all' || source === 'file') {
    const fileSessions = getFileSessionsByTimeRange(since, until, search).map((s) => ({
      ...s,
      first_seen: utcToLocal(s.first_seen),
      last_seen: utcToLocal(s.last_seen),
    }));
    if (include_content) {
      const workspacePath = getWorkspacePath();
      const fileSessionIds = fileSessions.map((s) => s.id);
      const fileSessionFiles = getSessionFilesBySessionIds('file', fileSessionIds);

      result.file_sessions = fileSessions.map((session) => {
        const snapshotPath = session.snapshot_ulid && workspacePath
          ? path.join(workspacePath, 'file-snapshots', `${session.snapshot_ulid}${path.extname(session.document_url)}`)
          : null;

        const sessionFiles = fileSessionFiles.get(session.id);
        const fullTextFile = sessionFiles?.find((f) => f.file_type === 'full_text');

        const diffPath = session.diff_ulid && workspacePath
          ? path.join(workspacePath, 'session-files', `${session.diff_ulid}.txt`)
          : null;

        return { ...session, snapshot_path: snapshotPath, full_text_path: fullTextFile?.file_path ?? null, diff_path: diffPath };
      });
    } else {
      result.file_sessions = fileSessions;
    }
  }

  if (include_content && result.browser_sessions) {
    const browserSessionIds = (result.browser_sessions as any[]).map((s) => s.id);
    const browserSessionFiles = getSessionFilesBySessionIds('browser', browserSessionIds);

    result.browser_sessions = (result.browser_sessions as any[]).map((session) => {
      const sessionFiles = browserSessionFiles.get(session.id);
      const fullTextFile = sessionFiles?.find((f: any) => f.file_type === 'full_text');
      return { ...session, full_text_path: fullTextFile?.file_path ?? null };
    });
  }

  return result;
}
