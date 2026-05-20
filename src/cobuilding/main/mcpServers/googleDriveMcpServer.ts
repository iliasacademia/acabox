import * as path from 'path';
import { app } from 'electron';
import { isConnected, hasDriveScope } from '../googleDocsService';
import { listFiles, searchFiles, getFileMetadata, downloadFile } from '../googleDriveService';
import { getCacheEntry, upsertCacheEntry } from '../db/googleDriveCacheRepository';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(text: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

function checkAuth() {
  if (!isConnected()) {
    return ok(JSON.stringify({
      success: false,
      error: 'Not connected to Google. Connect your Google account in Settings to use Google Drive.',
      reason: 'oauth-required',
    }));
  }
  if (!hasDriveScope()) {
    return ok(JSON.stringify({
      success: false,
      error: 'Your Google connection does not include Drive access. Reconnect in Settings to grant Drive (read-only) scope.',
      reason: 'scope-missing',
    }));
  }
  return null;
}

export interface GoogleDriveMcpDeps {
  getAllowedFolders: () => Array<{ driveId: string; name: string }>;
  getWorkspaceId: () => string | null;
}

export function createGoogleDriveHandlers(deps: GoogleDriveMcpDeps) {
  const { getAllowedFolders, getWorkspaceId } = deps;

  return {
    list_files: async (args: {
      folder_id?: string;
      page_size?: number;
      page_token?: string;
      order_by?: string;
    }) => {
      const authErr = checkAuth();
      if (authErr) return authErr;

      const allowed = getAllowedFolders();
      if (allowed.length === 0) {
        return ok(JSON.stringify({
          success: false,
          error: 'No Google Drive folders are connected to this workspace. Add folders via Settings or onboarding.',
        }));
      }

      try {
        if (!args.folder_id) {
          const cap = args.page_size ?? 100;
          const allFiles: any[] = [];
          const folderTokens: Record<string, string> = {};
          for (const folder of allowed) {
            if (allFiles.length >= cap) break;
            const result = await listFiles({
              folderId: folder.driveId,
              pageSize: Math.min(cap - allFiles.length, 100),
              orderBy: args.order_by,
            });
            if (result.success && result.data) {
              allFiles.push(...result.data.files.map(f => ({ ...f, _folderName: folder.name })));
              if (result.data.nextPageToken) {
                folderTokens[folder.driveId] = result.data.nextPageToken;
              }
            }
          }
          return ok(JSON.stringify({
            success: true,
            data: {
              files: allFiles.slice(0, cap),
              hasMore: allFiles.length > cap || Object.keys(folderTokens).length > 0,
            },
            connectedFolders: allowed.map(f => ({ id: f.driveId, name: f.name })),
          }));
        }

        const allowedIds = new Set(allowed.map(f => f.driveId));
        if (!allowedIds.has(args.folder_id)) {
          const isChild = await isDescendantOfAllowed(args.folder_id, allowedIds);
          if (!isChild) {
            return ok(JSON.stringify({
              success: false,
              error: 'This folder is not within any of the Google Drive folders connected to this workspace.',
            }));
          }
        }

        const result = await listFiles({
          folderId: args.folder_id,
          pageSize: args.page_size,
          pageToken: args.page_token,
          orderBy: args.order_by,
        });
        return ok(JSON.stringify(result));
      } catch (err) {
        return fail(String(err));
      }
    },

    search_files: async (args: {
      query: string;
      page_size?: number;
      page_token?: string;
    }) => {
      const authErr = checkAuth();
      if (authErr) return authErr;

      const allowed = getAllowedFolders();
      if (allowed.length === 0) {
        return ok(JSON.stringify({
          success: false,
          error: 'No Google Drive folders are connected to this workspace.',
        }));
      }

      try {
        const cap = args.page_size ?? 100;
        const allowedIds = new Set(allowed.map(f => f.driveId));
        const ancestryCache = new Map<string, boolean>();
        const filtered: any[] = [];
        let pageToken = args.page_token;

        while (filtered.length < cap) {
          const result = await searchFiles({
            query: args.query,
            pageSize: 100,
            pageToken,
          });
          if (!result.success || !result.data || result.data.files.length === 0) break;

          for (const file of result.data.files) {
            const parentId = file.parents?.[0];
            if (!parentId) continue;
            let isAllowed: boolean | undefined;
            if (allowedIds.has(parentId)) {
              isAllowed = true;
            } else {
              isAllowed = ancestryCache.get(parentId);
              if (isAllowed === undefined) {
                isAllowed = await isDescendantOfAllowed(parentId, allowedIds);
                ancestryCache.set(parentId, isAllowed);
              }
            }
            if (isAllowed) {
              filtered.push(file);
              if (filtered.length >= cap) break;
            }
          }

          pageToken = result.data.nextPageToken;
          if (!pageToken) break;
        }

        return ok(JSON.stringify({
          success: true,
          data: {
            files: filtered,
            hasMore: !!pageToken,
          },
        }));
      } catch (err) {
        return fail(String(err));
      }
    },

    get_file_metadata: async (args: { file_id: string }) => {
      const authErr = checkAuth();
      if (authErr) return authErr;

      try {
        const result = await getFileMetadata(args.file_id);
        return ok(JSON.stringify(result));
      } catch (err) {
        return fail(String(err));
      }
    },

    download_file: async (args: { file_id: string }) => {
      const authErr = checkAuth();
      if (authErr) return authErr;

      const allowed = getAllowedFolders();
      if (allowed.length === 0) {
        return ok(JSON.stringify({
          success: false,
          error: 'No Google Drive folders are connected to this workspace.',
        }));
      }

      try {
        const cacheBase = path.join(app.getPath('userData'), 'google-drive-cache');
        const allowedIds = new Set(allowed.map(f => f.driveId));
        const allowedIdToName = new Map(allowed.map(f => [f.driveId, f.name]));
        const wsId = getWorkspaceId() ?? '';

        // Try DB cache index first
        const cached = getCacheEntry(args.file_id);
        let relativePath: string | null = null;
        let relativeWithinFolder: string | null = null;

        if (cached) {
          const rootParent = await findAllowedRoot(cached.parent_id ?? '', allowedIds);
          if (rootParent) {
            const folderName = allowedIdToName.get(rootParent) ?? rootParent;
            relativeWithinFolder = cached.relative_path;
            relativePath = `${folderName}/${relativeWithinFolder}`;
          }
        }

        // Fall back to walking parents
        if (!relativePath) {
          const resolved = await resolvePathToAllowedRoot(args.file_id, allowedIds, allowedIdToName);
          if (!resolved) {
            return ok(JSON.stringify({
              success: false,
              error: 'This file is not within any of the Google Drive folders connected to this workspace.',
            }));
          }
          relativePath = resolved.relativePath;
          relativeWithinFolder = resolved.relativeWithinFolder;
        }

        const result = await downloadFile(args.file_id, cacheBase, relativePath);
        if (!result.success || !result.data) {
          return ok(JSON.stringify(result));
        }

        // Store/update DB entry with the folder-relative path (not the full path)
        upsertCacheEntry({
          fileId: args.file_id,
          workspaceId: wsId,
          relativePath: relativeWithinFolder ?? relativePath,
          parentId: (await getFileMetadata(args.file_id)).data?.parents?.[0],
          name: result.data.name,
          mimeType: cached?.mime_type ?? '',
          modifiedTime: result.data.modifiedTime,
          md5Checksum: result.data.md5Checksum,
          downloadedAt: result.data.cached ? cached?.downloaded_at : new Date().toISOString(),
        });

        const containerPath = `/data/google-drive/${relativePath}`;
        return ok(JSON.stringify({
          success: true,
          data: {
            containerPath,
            name: result.data.name,
            cached: result.data.cached,
          },
        }));
      } catch (err) {
        return fail(String(err));
      }
    },
  };
}

async function isDescendantOfAllowed(folderId: string, allowedIds: Set<string>): Promise<boolean> {
  return (await findAllowedRoot(folderId, allowedIds)) !== null;
}

async function findAllowedRoot(fileOrFolderId: string, allowedIds: Set<string>): Promise<string | null> {
  let currentId = fileOrFolderId;
  for (let i = 0; i < 20; i++) {
    if (allowedIds.has(currentId)) return currentId;
    const result = await getFileMetadata(currentId);
    if (!result.success || !result.data) return null;
    const parentId = result.data.parents?.[0];
    if (!parentId) return null;
    if (allowedIds.has(parentId)) return parentId;
    currentId = parentId;
  }
  return null;
}

async function resolvePathToAllowedRoot(
  fileId: string,
  allowedIds: Set<string>,
  allowedIdToName: Map<string, string>,
): Promise<{ relativePath: string; relativeWithinFolder: string } | null> {
  const segments: string[] = [];
  let currentId = fileId;
  for (let i = 0; i < 20; i++) {
    const result = await getFileMetadata(currentId);
    if (!result.success || !result.data) return null;
    segments.unshift(result.data.name);
    const parentId = result.data.parents?.[0];
    if (!parentId) return null;
    if (allowedIds.has(parentId)) {
      const folderName = allowedIdToName.get(parentId) ?? parentId;
      const relativeWithinFolder = segments.join('/');
      return {
        relativePath: `${folderName}/${relativeWithinFolder}`,
        relativeWithinFolder,
      };
    }
    currentId = parentId;
  }
  return null;
}
