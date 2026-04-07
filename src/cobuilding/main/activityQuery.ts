import * as path from 'path';
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
  const now = new Date();
  switch (period) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
    case 'last_2h':
      return new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    case 'last_24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case 'this_week': {
      const start = new Date(now);
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
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

        return { ...session, snapshot_path: snapshotPath, full_text_path: fullTextFile?.file_path ?? null };
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
