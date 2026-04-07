import * as path from 'path';
import { getBrowserSessionsByTimeRange } from './browserMonitor/repository';
import { getFileSessionsByTimeRange } from './fileMonitor/repository';

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
  query: { since: string; until: string };
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
    query: { since, until },
  };

  if (source === 'all' || source === 'browser') {
    result.browser_sessions = getBrowserSessionsByTimeRange(since, until, search, include_content);
  }

  if (source === 'all' || source === 'file') {
    const fileSessions = getFileSessionsByTimeRange(since, until, search);
    if (include_content) {
      const workspacePath = getWorkspacePath();
      result.file_sessions = fileSessions.map((session) => {
        if (!session.snapshot_ulid || !workspacePath) {
          return { ...session, snapshot_path: null };
        }
        const ext = path.extname(session.document_url);
        const snapshotPath = path.join(workspacePath, 'file-snapshots', `${session.snapshot_ulid}${ext}`);
        return { ...session, snapshot_path: snapshotPath };
      });
    } else {
      result.file_sessions = fileSessions;
    }
  }

  return result;
}
