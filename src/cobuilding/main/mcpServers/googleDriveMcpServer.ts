import * as path from 'path';
import { app } from 'electron';
import { isConnected, hasDriveScope } from '../googleDocsService';
import { listFiles, searchFiles, getFileMetadata, downloadFile, generateContextualDriveTree } from '../googleDriveService';
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

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface GoogleDriveMcpDeps {
  getAllowedItems: () => Array<{ driveId: string; name: string; mimeType: string }>;
  getWorkspaceId: () => string | null;
}

export function createGoogleDriveHandlers(deps: GoogleDriveMcpDeps) {
  const { getAllowedItems, getWorkspaceId } = deps;

  return {
    get_drive_tree: async () => {
      const authErr = checkAuth();
      if (authErr) return authErr;

      const allowed = getAllowedItems();
      if (allowed.length === 0) {
        return ok('No Google Drive items are connected to this workspace. Add files or folders via Settings.');
      }

      try {
        const tree = await generateContextualDriveTree(allowed);
        return ok(tree);
      } catch (err) {
        return fail(String(err));
      }
    },

    list_files: async (args: {
      folder_id?: string;
      page_size?: number;
      page_token?: string;
      order_by?: string;
    }) => {
      const authErr = checkAuth();
      if (authErr) return authErr;

      try {
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

      try {
        const result = await searchFiles({
          query: args.query,
          pageSize: args.page_size,
          pageToken: args.page_token,
        });
        return ok(JSON.stringify(result));
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

      const allowed = getAllowedItems();
      if (allowed.length === 0) {
        return ok(JSON.stringify({
          success: false,
          error: 'No Google Drive items are connected to this workspace. Add files or folders via Settings.',
        }));
      }

      try {
        const isAllowed = await isDownloadAllowed(args.file_id, allowed);
        if (!isAllowed) {
          return ok(JSON.stringify({
            success: false,
            error: 'This file is not within any of the Google Drive items connected to this workspace.',
          }));
        }

        const cacheBase = path.join(app.getPath('userData'), 'google-drive-cache');
        const wsId = getWorkspaceId() ?? '';

        const result = await downloadFile(args.file_id, cacheBase);
        if (!result.success || !result.data) {
          return ok(JSON.stringify(result));
        }

        upsertCacheEntry({
          fileId: args.file_id,
          workspaceId: wsId,
          name: result.data.name,
          mimeType: (await getFileMetadata(args.file_id)).data?.mimeType ?? '',
          modifiedTime: result.data.modifiedTime,
          md5Checksum: result.data.md5Checksum,
          downloadedAt: result.data.cached ? getCacheEntry(args.file_id)?.downloaded_at : new Date().toISOString(),
        });

        const containerPath = `/data/google-drive/${args.file_id}/${result.data.name}`;
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

async function isDownloadAllowed(
  fileId: string,
  allowedItems: Array<{ driveId: string; mimeType: string }>,
): Promise<boolean> {
  if (allowedItems.some(a => a.driveId === fileId)) return true;

  const allowedFolderIds = new Set(
    allowedItems
      .filter(a => a.mimeType === FOLDER_MIME)
      .map(a => a.driveId),
  );
  if (allowedFolderIds.size === 0) return false;
  return isDescendantOfAllowed(fileId, allowedFolderIds);
}

async function isDescendantOfAllowed(fileOrFolderId: string, allowedIds: Set<string>): Promise<boolean> {
  let currentId = fileOrFolderId;
  for (let i = 0; i < 20; i++) {
    if (allowedIds.has(currentId)) return true;
    const result = await getFileMetadata(currentId);
    if (!result.success || !result.data) return false;
    const parentId = result.data.parents?.[0];
    if (!parentId) return false;
    if (allowedIds.has(parentId)) return true;
    currentId = parentId;
  }
  return false;
}
