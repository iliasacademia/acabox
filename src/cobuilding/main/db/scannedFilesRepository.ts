import { randomUUID } from 'crypto';
import { getDatabase } from './database';

export interface ScannedFile {
  id: string;
  workspace_id: string;
  report_id: string | null;
  file_path: string;
  file_name: string;
  file_type: 'manuscript' | 'grant' | 'presentation' | 'reference';
  created_at: string;
}

const VALID_TYPES = new Set(['manuscript', 'grant', 'presentation', 'reference']);

export function upsertScannedFiles(
  workspaceId: string,
  reportId: string,
  files: Array<{ file_path: string; file_name: string; file_type: string }>,
): void {
  const db = getDatabase();
  const del = db.prepare('DELETE FROM scanned_files WHERE workspace_id = ?');
  const ins = db.prepare(
    `INSERT INTO scanned_files (id, workspace_id, report_id, file_path, file_name, file_type)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    del.run(workspaceId);
    for (const f of files) {
      if (!VALID_TYPES.has(f.file_type)) continue;
      if (!f.file_path || !f.file_name) continue;
      ins.run(randomUUID(), workspaceId, reportId, f.file_path, f.file_name, f.file_type);
    }
  })();
}

export function getScannedFilesByType(workspaceId: string, fileType: string): ScannedFile[] {
  const db = getDatabase();
  return db
    .prepare(
      'SELECT * FROM scanned_files WHERE workspace_id = ? AND file_type = ? ORDER BY file_name ASC',
    )
    .all(workspaceId, fileType) as ScannedFile[];
}

export function getScannedFiles(workspaceId: string): ScannedFile[] {
  const db = getDatabase();
  return db
    .prepare(
      'SELECT * FROM scanned_files WHERE workspace_id = ? ORDER BY file_type ASC, file_name ASC',
    )
    .all(workspaceId) as ScannedFile[];
}

export function updateFileTag(
  workspaceId: string,
  filePath: string,
  fileName: string,
  fileType: string,
): void {
  if (!VALID_TYPES.has(fileType)) return;
  const db = getDatabase();
  const existing = db
    .prepare('SELECT id FROM scanned_files WHERE workspace_id = ? AND file_path = ?')
    .get(workspaceId, filePath) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE scanned_files SET file_type = ? WHERE id = ?').run(fileType, existing.id);
  } else {
    db.prepare(
      `INSERT INTO scanned_files (id, workspace_id, report_id, file_path, file_name, file_type)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    ).run(randomUUID(), workspaceId, filePath, fileName, fileType);
  }
}

export function removeFileTag(workspaceId: string, filePath: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM scanned_files WHERE workspace_id = ? AND file_path = ?').run(
    workspaceId,
    filePath,
  );
}
