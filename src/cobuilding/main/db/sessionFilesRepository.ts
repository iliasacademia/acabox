import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import { ulid } from 'ulid';
import { getObservationsDatabase } from './observationsDatabase';

let getWorkspacePath: () => string | null = () => null;

export function initSessionFiles(workspacePathGetter: () => string | null): void {
  getWorkspacePath = workspacePathGetter;
}

export interface SessionFile {
  id: number;
  ulid: string;
  session_type: string;
  session_id: number;
  file_type: string;
  file_ext: string;
  created_at: string;
}

export interface SessionFileWithPath extends SessionFile {
  file_path: string | null;
}

let stmts: ReturnType<typeof prepareStatements> | null = null;

function prepareStatements() {
  const db = getObservationsDatabase();
  return {
    insert: db.prepare(`
      INSERT INTO session_files (ulid, session_type, session_id, file_type, file_ext, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getBySession: db.prepare(`
      SELECT * FROM session_files WHERE session_type = ? AND session_id = ?
    `),
    getBySessionIds: db.prepare(`
      SELECT * FROM session_files WHERE session_type = ? AND session_id IN (SELECT value FROM json_each(?))
    `),
  };
}

function getStmts() {
  if (!stmts) stmts = prepareStatements();
  return stmts;
}

function getSessionFilesDir(): string | null {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return null;
  return path.join(workspacePath, 'session-files');
}

function resolveFilePath(fileUlid: string, fileExt: string): string | null {
  const dir = getSessionFilesDir();
  if (!dir) return null;
  return path.join(dir, `${fileUlid}${fileExt}`);
}

export function createSessionFile(
  sessionType: string,
  sessionId: number,
  fileType: string,
  content: string,
  ext: string = '.txt',
): string | null {
  const dir = getSessionFilesDir();
  if (!dir) {
    log.warn('[SessionFiles] No workspace path available');
    return null;
  }

  const fileUlid = ulid();
  const filePath = path.join(dir, `${fileUlid}${ext}`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');

    getStmts().insert.run(
      fileUlid,
      sessionType,
      sessionId,
      fileType,
      ext,
      new Date().toISOString(),
    );

    log.info('[SessionFiles] Created:', filePath);
    return fileUlid;
  } catch (err) {
    log.warn('[SessionFiles] Failed to create session file:', err);
    return null;
  }
}

export function getSessionFiles(sessionType: string, sessionId: number): SessionFileWithPath[] {
  const rows = getStmts().getBySession.all(sessionType, sessionId) as SessionFile[];
  return rows.map((row) => ({
    ...row,
    file_path: resolveFilePath(row.ulid, row.file_ext),
  }));
}

export function getSessionFilesBySessionIds(
  sessionType: string,
  sessionIds: number[],
): Map<number, SessionFileWithPath[]> {
  if (sessionIds.length === 0) return new Map();

  const rows = getStmts().getBySessionIds.all(
    sessionType,
    JSON.stringify(sessionIds),
  ) as SessionFile[];

  const result = new Map<number, SessionFileWithPath[]>();
  for (const row of rows) {
    const withPath: SessionFileWithPath = {
      ...row,
      file_path: resolveFilePath(row.ulid, row.file_ext),
    };
    const existing = result.get(row.session_id);
    if (existing) {
      existing.push(withPath);
    } else {
      result.set(row.session_id, [withPath]);
    }
  }
  return result;
}
