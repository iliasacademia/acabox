import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import log from 'electron-log';
import { getAuthedClient, hasScopeFor, type DocsApiResult } from './googleDocsService';
import { getCacheEntry, upsertPathIndexEntries } from './db/googleDriveCacheRepository';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  shared?: boolean;
}

interface DriveListResult {
  files: DriveFile[];
  nextPageToken?: string;
}

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const STANDARD_FIELDS = 'files(id,name,mimeType,modifiedTime,size,parents,webViewLink,owners(displayName,emailAddress),shared),nextPageToken';
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
  sharedWithMe?: boolean;
}): Promise<DocsApiResult<DriveListResult>> {
  const client = await getAuthedClient();
  if (!client) return { success: false, error: 'Not connected to Google' };

  const params = new URLSearchParams();
  params.set('fields', STANDARD_FIELDS);
  params.set('pageSize', String(Math.min(args.pageSize ?? 50, 100)));
  params.set('orderBy', args.orderBy ?? 'folder,name');
  params.set('includeItemsFromAllDrives', 'true');
  params.set('supportsAllDrives', 'true');
  if (args.pageToken) params.set('pageToken', args.pageToken);

  const qParts: string[] = ['trashed = false'];
  if (args.sharedWithMe) {
    qParts.push('sharedWithMe = true');
  } else {
    qParts.push(`'${args.folderId ?? 'root'}' in parents`);
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
  params.set('includeItemsFromAllDrives', 'true');
  params.set('supportsAllDrives', 'true');
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
  params.set('supportsAllDrives', 'true');

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
  mimeType?: string,
): Promise<{ tree: string; pathIndex: PathIndex }> {
  const pathIndex: PathIndex = {};

  if (mimeType && mimeType !== FOLDER_MIME) {
    const tree = folderName;
    log.info(`[GoogleDrive] Non-folder item: ${folderName}`);
    return { tree, pathIndex };
  }

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

// --- Contextual Drive tree for agent ---

interface AncestorInfo {
  id: string;
  name: string;
  mimeType: string;
}

interface TreeNode {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  shared?: boolean;
  isSelected: boolean;
  fullyLoaded: boolean;
  children: Map<string, TreeNode>;
}

export interface DriveUITreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: DriveUITreeNode[];
  loaded?: boolean;
  driveFileId?: string;
  driveMimeType?: string;
}

function newTreeNode(id: string, name: string, mimeType: string, extra?: Partial<DriveFile>): TreeNode {
  return {
    id, name, mimeType,
    modifiedTime: extra?.modifiedTime,
    size: extra?.size,
    owners: extra?.owners,
    shared: extra?.shared,
    isSelected: false,
    fullyLoaded: false,
    children: new Map(),
  };
}

async function resolveAncestry(fileId: string): Promise<{ ancestors: AncestorInfo[]; isShared: boolean }> {
  const chain: AncestorInfo[] = [];
  let currentId = fileId;

  for (let i = 0; i < 20; i++) {
    const result = await getFileMetadata(currentId);
    if (!result.success || !result.data) break;
    const parentId = result.data.parents?.[0];
    if (!parentId) {
      // No parent at all — this item is shared (not in user's Drive hierarchy)
      return { ancestors: chain, isShared: true };
    }
    // Check if parent is the Drive root (root has no parents itself)
    const parentResult = await getFileMetadata(parentId);
    if (!parentResult.success || !parentResult.data) break;
    if (!parentResult.data.parents || parentResult.data.parents.length === 0) {
      // Parent is the root — we've reached My Drive. Don't include root in ancestors.
      return { ancestors: chain, isShared: false };
    }
    // Parent is a regular folder — add it and keep walking up
    chain.unshift({ id: parentId, name: parentResult.data.name, mimeType: parentResult.data.mimeType });
    currentId = parentId;
  }
  return { ancestors: chain, isShared: false };
}

function insertAncestryPath(root: TreeNode, ancestors: AncestorInfo[]): TreeNode {
  let current = root;
  for (const anc of ancestors) {
    if (!current.children.has(anc.id)) {
      current.children.set(anc.id, newTreeNode(anc.id, anc.name, anc.mimeType));
    }
    current = current.children.get(anc.id)!;
  }
  return current;
}

async function populateDescendants(node: TreeNode, maxDepth: number, depth: number): Promise<void> {
  if (depth >= maxDepth) return;
  if (node.mimeType !== FOLDER_MIME) return;
  const files = await listAllFiles(node.id);
  node.fullyLoaded = true;
  for (const file of files) {
    const child = newTreeNode(file.id, file.name, file.mimeType, file);
    node.children.set(file.id, child);
    if (file.mimeType === FOLDER_MIME) {
      await populateDescendants(child, maxDepth, depth + 1);
    }
  }
}

function formatSize(size?: string): string {
  if (!size) return '';
  const bytes = parseInt(size, 10);
  if (isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function renderTreeNode(node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): string[] {
  const lines: string[] = [];
  const connector = isRoot ? '' : (isLast ? '└── ' : '├── ');
  const isFolder = node.mimeType === FOLDER_MIME;
  const icon = isFolder ? '📁' : '📄';
  const marker = node.isSelected ? ' ⬇' : '';

  let meta = '';
  const parts: string[] = [];
  if (!isRoot) parts.push(`id:${node.id}`);
  if (node.modifiedTime) parts.push(node.modifiedTime.slice(0, 10));
  const sz = formatSize(node.size);
  if (sz) parts.push(sz);
  if (node.shared && node.owners?.[0]?.displayName) parts.push(`owner: ${node.owners[0].displayName}`);
  if (parts.length > 0) meta = ` (${parts.join(', ')})`;

  const label = `${prefix}${connector}${icon} ${node.name}${meta}${marker}`;
  lines.push(label);

  const children = Array.from(node.children.values());
  const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
  for (let i = 0; i < children.length; i++) {
    lines.push(...renderTreeNode(children[i], childPrefix, i === children.length - 1, false));
  }
  return lines;
}

async function buildContextualDriveTree(
  selectedItems: Array<{ driveId: string; name: string; mimeType: string }>,
): Promise<{ myDriveRoot: TreeNode; sharedRoot: TreeNode }> {
  const myDriveRoot = newTreeNode('my-drive', 'My Drive', FOLDER_MIME);
  myDriveRoot.fullyLoaded = true;
  const sharedRoot = newTreeNode('shared', 'Shared with me', FOLDER_MIME);
  sharedRoot.fullyLoaded = true;

  try {
    for (const item of selectedItems) {
      const meta = await getFileMetadata(item.driveId);
      const fileMeta = meta.success && meta.data ? meta.data : undefined;

      const { ancestors, isShared } = await resolveAncestry(item.driveId);
      const root = isShared ? sharedRoot : myDriveRoot;
      const parent = insertAncestryPath(root, ancestors);

      const node = newTreeNode(item.driveId, item.name, item.mimeType, fileMeta);
      node.isSelected = true;
      parent.children.set(item.driveId, node);

      if (item.mimeType === FOLDER_MIME) {
        await populateDescendants(node, 3, 0);
      }
    }
  } catch (err) {
    log.error('[GoogleDrive] Failed to generate contextual tree:', err);
  }

  return { myDriveRoot, sharedRoot };
}

function convertTreeNodeToUI(node: TreeNode): DriveUITreeNode {
  const isFolder = node.mimeType === FOLDER_MIME;
  const childNodes = Array.from(node.children.values());
  return {
    name: node.name,
    path: `gdrive://${node.id}`,
    isDirectory: isFolder,
    children: isFolder ? childNodes.map(convertTreeNodeToUI) : undefined,
    loaded: isFolder ? node.fullyLoaded : undefined,
    driveFileId: node.id,
    driveMimeType: node.mimeType,
  };
}

export async function generateContextualDriveTreeNodes(
  selectedItems: Array<{ driveId: string; name: string; mimeType: string }>,
): Promise<DriveUITreeNode[]> {
  if (selectedItems.length === 0) return [];

  const { myDriveRoot, sharedRoot } = await buildContextualDriveTree(selectedItems);
  const roots: DriveUITreeNode[] = [];

  if (myDriveRoot.children.size > 0) {
    roots.push(convertTreeNodeToUI(myDriveRoot));
  }
  if (sharedRoot.children.size > 0) {
    roots.push(convertTreeNodeToUI(sharedRoot));
  }
  return roots;
}

export async function generateContextualDriveTree(
  selectedItems: Array<{ driveId: string; name: string; mimeType: string }>,
): Promise<string> {
  if (selectedItems.length === 0) return '(No Google Drive items connected)';

  const { myDriveRoot, sharedRoot } = await buildContextualDriveTree(selectedItems);

  const lines: string[] = [];
  const hasMyDrive = myDriveRoot.children.size > 0;
  const hasShared = sharedRoot.children.size > 0;

  if (hasMyDrive) {
    lines.push(...renderTreeNode(myDriveRoot, '', false, true));
  }
  if (hasShared) {
    if (hasMyDrive) lines.push('');
    lines.push(...renderTreeNode(sharedRoot, '', false, true));
  }

  if (lines.length > 500) {
    return lines.slice(0, 500).join('\n') + `\n... (truncated, ${lines.length - 500} more entries)`;
  }
  lines.push('');
  lines.push('⬇ = selected (downloadable)');
  return lines.join('\n');
}

// --- Native Google Workspace API fetchers ---

const DOCS_API_URL = 'https://docs.googleapis.com/v1/documents';
const SHEETS_API_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const SLIDES_API_URL = 'https://slides.googleapis.com/v1/presentations';

async function fetchNativeJson(url: string): Promise<DocsApiResult<Buffer>> {
  const client = await getAuthedClient();
  if (!client) return { success: false, error: 'Not connected to Google' };
  try {
    const resp = await withRetry(() => client.request<any>({ url, method: 'GET' }));
    return { success: true, data: Buffer.from(JSON.stringify(resp.data, null, 2)) };
  } catch (err: any) {
    return handleDriveError(err);
  }
}

export async function fetchDocJson(fileId: string): Promise<DocsApiResult<Buffer>> {
  return fetchNativeJson(`${DOCS_API_URL}/${encodeURIComponent(fileId)}?includeTabsContent=true`);
}

export async function fetchSheetJson(fileId: string): Promise<DocsApiResult<Buffer>> {
  return fetchNativeJson(`${SHEETS_API_URL}/${encodeURIComponent(fileId)}?includeGridData=true`);
}

export async function fetchSlideJson(fileId: string): Promise<DocsApiResult<Buffer>> {
  return fetchNativeJson(`${SLIDES_API_URL}/${encodeURIComponent(fileId)}`);
}

// --- File download with cache ---

const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024; // 50 MB

const NATIVE_API_MAP: Partial<Record<string, (id: string) => Promise<DocsApiResult<Buffer>>>> = {
  'application/vnd.google-apps.document': fetchDocJson,
  'application/vnd.google-apps.spreadsheet': fetchSheetJson,
  'application/vnd.google-apps.presentation': fetchSlideJson,
};

const EXPORT_FALLBACK_MAP: Partial<Record<string, { mimeType: string; extension: string }>> = {
  'application/vnd.google-apps.document': { mimeType: 'text/plain', extension: '.txt' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', extension: '.csv' },
  'application/vnd.google-apps.presentation': { mimeType: 'text/plain', extension: '.txt' },
  'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: '.png' },
};

export async function downloadFile(
  fileId: string,
  cacheBaseDir: string,
): Promise<DocsApiResult<{ filePath: string; cached: boolean; name: string; mimeType: string; modifiedTime?: string; md5Checksum?: string }>> {
  const client = await getAuthedClient();
  if (!client) return { success: false, error: 'Not connected to Google' };

  const metaResult = await getFileMetadata(fileId);
  if (!metaResult.success || !metaResult.data) {
    return { success: false, error: metaResult.error ?? 'Failed to get file metadata' };
  }
  const fileMeta = metaResult.data;
  const isWorkspaceFile = fileMeta.mimeType.startsWith('application/vnd.google-apps.');
  const nativeFetcher = NATIVE_API_MAP[fileMeta.mimeType];
  const exportInfo = EXPORT_FALLBACK_MAP[fileMeta.mimeType];
  const useNativeApi = nativeFetcher && hasScopeFor(fileMeta.mimeType);

  if (isWorkspaceFile && !nativeFetcher && !exportInfo) {
    return { success: false, error: `Cannot download Google Workspace file of type "${fileMeta.mimeType}". Only Docs, Sheets, Slides, and Drawings can be exported.` };
  }

  if (!isWorkspaceFile && fileMeta.size && parseInt(fileMeta.size, 10) > MAX_DOWNLOAD_SIZE) {
    const sizeMB = Math.round(parseInt(fileMeta.size, 10) / 1024 / 1024);
    return { success: false, error: `File is ${sizeMB} MB which exceeds the ${MAX_DOWNLOAD_SIZE / 1024 / 1024} MB download limit.` };
  }

  let fileName: string;
  if (isWorkspaceFile) {
    fileName = useNativeApi
      ? fileMeta.name + '.json'
      : fileMeta.name + (exportInfo?.extension ?? '');
  } else {
    fileName = fileMeta.name;
  }

  const filePath = path.resolve(cacheBaseDir, fileId, fileName);
  if (!filePath.startsWith(path.resolve(cacheBaseDir) + path.sep)) {
    return { success: false, error: 'Invalid file path' };
  }

  const cached = getCacheEntry(fileId);
  if (cached?.downloaded_at && fs.existsSync(filePath)) {
    const stale = cached.modified_time !== fileMeta.modifiedTime
      || (fileMeta.md5Checksum && cached.md5_checksum && cached.md5_checksum !== fileMeta.md5Checksum);
    if (!stale) {
      return { success: true, data: { filePath, cached: true, name: fileName, mimeType: fileMeta.mimeType } };
    }
  }

  try {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    let content: Buffer;

    if (useNativeApi) {
      const result = await nativeFetcher(fileId);
      if (!result.success || !result.data) {
        return { success: false, error: result.error ?? 'Failed to fetch via native API' };
      }
      content = result.data;
    } else if (isWorkspaceFile && exportInfo) {
      const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportInfo.mimeType)}`;
      const resp = await withRetry(() => client.request<any>({ url, method: 'GET', responseType: 'arraybuffer' }));
      content = Buffer.from(resp.data);
    } else {
      const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
      const resp = await withRetry(() => client.request<any>({ url, method: 'GET', responseType: 'arraybuffer' }));
      content = Buffer.from(resp.data);
    }

    await fsPromises.writeFile(filePath, content);

    return {
      success: true,
      data: {
        filePath, cached: false, name: fileName, mimeType: fileMeta.mimeType,
        modifiedTime: fileMeta.modifiedTime,
        md5Checksum: fileMeta.md5Checksum,
      },
    };
  } catch (err: any) {
    return handleDriveError(err);
  }
}
