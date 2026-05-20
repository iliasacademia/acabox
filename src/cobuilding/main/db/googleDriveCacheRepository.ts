import { getDatabase } from './database';

export interface GoogleDriveCacheEntry {
  file_id: string;
  workspace_id: string;
  relative_path: string;
  parent_id: string | null;
  name: string;
  mime_type: string;
  modified_time: string | null;
  md5_checksum: string | null;
  downloaded_at: string | null;
}

export function getCacheEntry(fileId: string): GoogleDriveCacheEntry | undefined {
  return getDatabase()
    .prepare('SELECT * FROM google_drive_cache WHERE file_id = ?')
    .get(fileId) as GoogleDriveCacheEntry | undefined;
}

export function upsertCacheEntry(entry: {
  fileId: string;
  workspaceId: string;
  relativePath?: string;
  parentId?: string | null;
  name: string;
  mimeType: string;
  modifiedTime?: string | null;
  md5Checksum?: string | null;
  downloadedAt?: string | null;
}): void {
  getDatabase()
    .prepare(`
      INSERT INTO google_drive_cache (file_id, workspace_id, relative_path, parent_id, name, mime_type, modified_time, md5_checksum, downloaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        relative_path = excluded.relative_path,
        parent_id = excluded.parent_id,
        name = excluded.name,
        mime_type = excluded.mime_type,
        modified_time = excluded.modified_time,
        md5_checksum = excluded.md5_checksum,
        downloaded_at = excluded.downloaded_at
    `)
    .run(
      entry.fileId, entry.workspaceId, entry.relativePath ?? '',
      entry.parentId ?? null, entry.name, entry.mimeType,
      entry.modifiedTime ?? null, entry.md5Checksum ?? null, entry.downloadedAt ?? null,
    );
}

export function upsertPathIndexEntries(workspaceId: string, entries: Record<string, { relativePath: string; parentId: string; name: string; mimeType: string }>): void {
  const stmt = getDatabase().prepare(`
    INSERT INTO google_drive_cache (file_id, workspace_id, relative_path, parent_id, name, mime_type)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET
      relative_path = excluded.relative_path,
      parent_id = excluded.parent_id,
      name = excluded.name,
      mime_type = excluded.mime_type
  `);
  const tx = getDatabase().transaction(() => {
    for (const [fileId, entry] of Object.entries(entries)) {
      stmt.run(fileId, workspaceId, entry.relativePath, entry.parentId, entry.name, entry.mimeType);
    }
  });
  tx();
}

export function upsertSingleFileEntry(
  workspaceId: string,
  fileId: string,
  name: string,
  mimeType: string,
  parentId?: string | null,
): void {
  upsertCacheEntry({
    fileId,
    workspaceId,
    relativePath: '',
    parentId: parentId ?? null,
    name,
    mimeType,
  });
}

export function deleteCacheEntry(fileId: string): void {
  getDatabase()
    .prepare('DELETE FROM google_drive_cache WHERE file_id = ?')
    .run(fileId);
}

export function listChildEntries(workspaceId: string, parentId: string): GoogleDriveCacheEntry[] {
  return getDatabase()
    .prepare('SELECT * FROM google_drive_cache WHERE workspace_id = ? AND parent_id = ? ORDER BY mime_type = ? DESC, name COLLATE NOCASE ASC')
    .all(workspaceId, parentId, 'application/vnd.google-apps.folder') as GoogleDriveCacheEntry[];
}

export function clearWorkspaceCache(workspaceId: string): void {
  getDatabase()
    .prepare('DELETE FROM google_drive_cache WHERE workspace_id = ?')
    .run(workspaceId);
}
