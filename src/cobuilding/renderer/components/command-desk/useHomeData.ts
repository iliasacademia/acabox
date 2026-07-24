import { useState, useEffect, useCallback } from 'react';

export interface DriveFile {
  /** Path relative to its shared directory — what the drive list displays. */
  relPath: string;
  /** Absolute path, for opening in the file viewer. */
  path: string;
  mtimeMs: number;
  size: number;
}

/** Extensions surfaced in the home "Drive" card (recent research artifacts). */
const DRIVE_EXTENSIONS = [
  'csv', 'tsv', 'json', 'md', 'txt', 'pdf', 'db', 'sqlite', 'xlsx', 'xls',
  'ipynb', 'py', 'r', 'docx', 'pptx', 'tex', 'bib', 'yaml', 'yml',
];

/**
 * All live data the Command Desk home + rail need: chat sessions, mini-apps,
 * and recently-modified files across the shared directories. Sessions refresh
 * on `sessions:changed`; apps/drive refresh via the returned callbacks (the
 * host has no change events for those yet).
 */
export function useHomeData() {
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [apps, setApps] = useState<MiniAppEntry[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);

  useEffect(() => {
    const refresh = () => {
      window.sessionsAPI
        .list()
        .then((rows) => {
          const chats = rows
            .filter((r) => r.source !== 'reactions' && r.source !== 'reactions-system')
            .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
          setSessions(chats);
        })
        .catch((err) => console.error('[useHomeData] sessions list failed:', err));
    };
    refresh();
    return window.sessionsAPI.onSessionsChanged(refresh);
  }, []);

  const refreshApps = useCallback(() => {
    window.miniAppsAPI
      .list()
      .then(setApps)
      .catch((err) => console.error('[useHomeData] miniApps list failed:', err));
  }, []);

  const refreshDrive = useCallback(() => {
    window.filesAPI
      .findByExtension(DRIVE_EXTENSIONS)
      .then((rows) => {
        setDriveFiles(
          rows.slice(0, 4).map((r) => ({
            relPath: r.relPath,
            path: r.path,
            mtimeMs: r.mtimeMs,
            size: r.size,
          })),
        );
      })
      .catch(() => setDriveFiles([]));
  }, []);

  useEffect(() => {
    refreshApps();
    refreshDrive();
  }, [refreshApps, refreshDrive]);

  return { sessions, apps, driveFiles, refreshApps, refreshDrive };
}
