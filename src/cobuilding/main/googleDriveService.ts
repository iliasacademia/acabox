import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import log from 'electron-log';
import { getAuthedClient, type DocsApiResult } from './googleDocsService';
import { getCacheEntry, upsertPathIndexEntries } from './db/googleDriveCacheRepository';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
}

interface DriveListResult {
  files: DriveFile[];
  nextPageToken?: string;
}

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const STANDARD_FIELDS = 'files(id,name,mimeType,modifiedTime,size,parents,webViewLink),nextPageToken';
const DETAIL_FIELDS = 'id,name,mimeType,modifiedTime,size,parents,webViewLink,description,createdTime,owners(displayName,emailAddress)';

function isRateLimited(err: any): boolean {
  const status = err?.response?.status ?? err?.code;
  if (status === 429) return true;
  if (status === 403) {
    const reason = err?.response?.data?.error?.errors?.[0]?.reason;
    return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (isRateLimited(err) && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        log.warn(`[GoogleDrive] Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error('withRetry: unreachable');
}

function handleDriveError(err: any): DocsApiResult<never> {
  const status = err?.response?.status ?? err?.code;
  if (status === 401) {
    return { success: false, error: 'Google session expired. Please reconnect in Settings.', authExpired: true };
  }
  if (status === 429 || isRateLimited(err)) {
    return { success: false, error: 'Google Drive rate limit exceeded. Please try again in a moment.' };
  }
  if (status === 403) {
    return { success: false, error: 'Google denied access. The Drive scope may be missing — try reconnecting.' };
  }
  if (status === 404) {
    return { success: false, error: 'File not found. The id may be wrong, or you may not have access.' };
  }
  return { success: false, error: `Drive API error${status ? ' ' + status : ''}: ${err?.message ?? String(err)}` };
}

export async function listFiles(args: {
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
}): Promise<DocsApiResult<DriveListResult>> {
  const client = await getAuthedClient();
  if (!client) return { success: false, error: 'Not connected to Google' };

  const params = new URLSearchParams();
  params.set('fields', STANDARD_FIELDS);
  params.set('pageSize', String(Math.min(args.pageSize ?? 50, 100)));
  params.set('orderBy', args.orderBy ?? 'folder,name');
  if (args.pageToken) params.set('pageToken', args.pageToken);

  const qParts: string[] = ['trashed = false'];
  qParts.push(`'${args.folderId ?? 'root'}' in parents`);
  params.set('q', qParts.join(' and '));

  try {
    const resp = await withRetry(() => client.request<any>({ url: `${DRIVE_FILES_URL}?${params}`, method: 'GET' }));
    return {
      success: true,
      data: {
        files: resp.data.files ?? [],
        nextPageToken: resp.data.nextPageToken,
      },
    };
  } catch (err: any) {
    return handleDriveError(err);
  }
}

export async function searchFiles(args: {
  query: string;
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
}): Promise<DocsApiResult<DriveListResult>> {
  const client = await getAuthedClient();
  if (!client) return { success: false, error: 'Not connected to Google' };

  const params = new URLSearchParams();
  params.set('fields', STANDARD_FIELDS);
  params.set('pageSize', String(Math.min(args.pageSize ?? 20, 100)));
  if (args.pageToken) params.set('pageToken', args.pageToken);

  const escaped = args.query.replace(/'/g, "\\'");
  const qParts = [`name contains '${escaped}'`, 'trashed = false'];
  if (args.folderId) {
    qParts.push(`'${args.folderId}' in parents`);
  }
  params.set('q', qParts.join(' and '));

  try {
    const resp = await withRetry(() => client.request<any>({ url: `${DRIVE_FILES_URL}?${params}`, method: 'GET' }));
    return {
      success: true,
      data: {
        files: resp.data.files ?? [],
        nextPageToken: resp.data.nextPageToken,
      },
    };
  } catch (err: any) {
    return handleDriveError(err);
  }
}

export async function getFileMetadata(fileId: string): Promise<DocsApiResult<DriveFile & { description?: string; createdTime?: string; md5Checksum?: string; owners?: Array<{ displayName?: string; emailAddress?: string }> }>> {
  const client = await getAuthedClient();
  if (!client) return { success: false, error: 'Not connected to Google' };

  const params = new URLSearchParams();
  params.set('fields', DETAIL_FIELDS + ',md5Checksum');

  try {
    const resp = await withRetry(() => client.request<any>({ url: `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?${params}`, method: 'GET' }));
    return { success: true, data: resp.data };
  } catch (err: any) {
    return handleDriveError(err);
  }
}

// --- Directory tree generation for scanner ---

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface PathIndexEntry {
  relativePath: string;
  parentId: string;
  name: string;
  mimeType: string;
}

export type PathIndex = Record<string, PathIndexEntry>;

async function listAllFiles(folderId: string): Promise<DriveFile[]> {
  const all: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const result = await listFiles({ folderId, pageSize: 100, pageToken });
    if (!result.success || !result.data) break;
    all.push(...result.data.files);
    pageToken = result.data.nextPageToken;
  } while (pageToken);
  return all;
}

async function buildTreeLines(
  folderId: string,
  prefix: string,
  relativePath: string,
  pathIndex: PathIndex,
  maxDepth: number,
  depth: number,
): Promise<string[]> {
  if (depth >= maxDepth) return [];
  const files = await listAllFiles(folderId);
  const lines: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const isLast = i === files.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const date = file.modifiedTime ? `[${file.modifiedTime.slice(0, 10)}]` : '';
    lines.push(`${prefix}${connector}${date} ${file.name}`);
    const fileRelPath = relativePath ? `${relativePath}/${file.name}` : file.name;
    pathIndex[file.id] = {
      relativePath: fileRelPath,
      parentId: folderId,
      name: file.name,
      mimeType: file.mimeType,
    };
    if (file.mimeType === FOLDER_MIME) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      const children = await buildTreeLines(file.id, childPrefix, fileRelPath, pathIndex, maxDepth, depth + 1);
      lines.push(...children);
    }
  }
  return lines;
}

export async function generateDriveDirectoryTree(
  folderId: string,
  folderName: string,
  workspaceId?: string,
): Promise<{ tree: string; pathIndex: PathIndex }> {
  const pathIndex: PathIndex = {};
  try {
    const lines = [folderName];
    const children = await buildTreeLines(folderId, '', '', pathIndex, 3, 0);
    lines.push(...children);
    let tree: string;
    if (lines.length > 500) {
      log.info(`[GoogleDrive] Tree generated (${lines.length} lines, truncated to 500)`);
      tree = lines.slice(0, 500).join('\n') + `\n... (truncated, ${lines.length - 500} more entries)`;
    } else {
      log.info(`[GoogleDrive] Tree generated (${lines.length} lines)`);
      tree = lines.join('\n');
    }

    if (workspaceId && Object.keys(pathIndex).length > 0) {
      try {
        upsertPathIndexEntries(workspaceId, pathIndex);
      } catch (err) {
        log.error('[GoogleDrive] Failed to write path index to DB:', err);
      }
    }

    return { tree, pathIndex };
  } catch (err) {
    log.error('[GoogleDrive] Failed to generate tree:', err);
    return { tree: `${folderName}\n  (failed to list contents)`, pathIndex };
  }
}

// --- File download with cache ---

const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024; // 50 MB

const GOOGLE_WORKSPACE_EXPORT_MAP: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': { mimeType: 'text/plain', extension: '.txt' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', extension: '.csv' },
  'application/vnd.google-apps.presentation': { mimeType: 'text/plain', extension: '.txt' },
  'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: '.png' },
};

export async function downloadFile(
  fileId: string,
  cacheBaseDir: string,
  relativePath: string,
): Promise<DocsApiResult<{ filePath: string; cached: boolean; name: string; modifiedTime?: string; md5Checksum?: string }>> {
  const client = await getAuthedClient();
  if (!client) return { success: false, error: 'Not connected to Google' };

  const metaResult = await getFileMetadata(fileId);
  if (!metaResult.success || !metaResult.data) {
    return { success: false, error: metaResult.error ?? 'Failed to get file metadata' };
  }
  const fileMeta = metaResult.data;
  const isWorkspaceFile = fileMeta.mimeType.startsWith('application/vnd.google-apps.');
  const exportInfo = GOOGLE_WORKSPACE_EXPORT_MAP[fileMeta.mimeType];

  if (isWorkspaceFile && !exportInfo) {
    return { success: false, error: `Cannot download Google Workspace file of type "${fileMeta.mimeType}". Only Docs, Sheets, Slides, and Drawings can be exported.` };
  }

  if (!isWorkspaceFile && fileMeta.size && parseInt(fileMeta.size, 10) > MAX_DOWNLOAD_SIZE) {
    const sizeMB = Math.round(parseInt(fileMeta.size, 10) / 1024 / 1024);
    return { success: false, error: `File is ${sizeMB} MB which exceeds the ${MAX_DOWNLOAD_SIZE / 1024 / 1024} MB download limit.` };
  }

  const fileName = isWorkspaceFile && exportInfo
    ? fileMeta.name + exportInfo.extension
    : fileMeta.name;

  const adjustedRelPath = isWorkspaceFile && exportInfo && !relativePath.endsWith(exportInfo.extension)
    ? relativePath + exportInfo.extension
    : relativePath;
  const filePath = path.resolve(cacheBaseDir, adjustedRelPath);
  if (!filePath.startsWith(path.resolve(cacheBaseDir) + path.sep)) {
    return { success: false, error: 'Invalid file path' };
  }

  // Check staleness via DB
  const cached = getCacheEntry(fileId);
  if (cached?.downloaded_at && fs.existsSync(filePath)) {
    const stale = cached.modified_time !== fileMeta.modifiedTime
      || (fileMeta.md5Checksum && cached.md5_checksum && cached.md5_checksum !== fileMeta.md5Checksum);
    if (!stale) {
      return { success: true, data: { filePath, cached: true, name: fileName } };
    }
  }

  try {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    let content: Buffer;
    if (isWorkspaceFile && exportInfo) {
      const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportInfo.mimeType)}`;
      const resp = await withRetry(() => client.request<any>({ url, method: 'GET', responseType: 'arraybuffer' }));
      content = Buffer.from(resp.data);
    } else {
      const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`;
      const resp = await withRetry(() => client.request<any>({ url, method: 'GET', responseType: 'arraybuffer' }));
      content = Buffer.from(resp.data);
    }

    await fsPromises.writeFile(filePath, content);

    return {
      success: true,
      data: {
        filePath, cached: false, name: fileName,
        modifiedTime: fileMeta.modifiedTime,
        md5Checksum: fileMeta.md5Checksum,
      },
    };
  } catch (err: any) {
    return handleDriveError(err);
  }
}
