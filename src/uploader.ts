import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'fs/promises';
import { APIclient, getCsrfToken } from './apiClient';
import { GetLatestResponse } from './types/api';
import { defaultLogger as logger } from './utils/logger';

const getTitle = async (filePath: string): Promise<string | undefined> => {
  const arrayBuffer = await readFile(filePath);
  const pdf = await PDFDocument.load(arrayBuffer);
  return pdf.getTitle();
};

// Some PDFs have newlines and multiple spaces in the title, as well as control characters.
const normalizeTitle = async (filePath: string, basePath: string): Promise<string> => {
  let title = (await getTitle(filePath)) || filePath.replace(basePath, '');
  // normalize newlines, paragraph-, & line-endings into spaces
  title = title.replace(/\n/g, ' ');
  title = title.replace(/\p{Zl}/gu, ' ');
  title = title.replace(/\p{Zp}/gu, ' ');

  // strip control characters, but not surrogates or formats
  title = title.replace(/\p{Cc}/gu, '');
  title = title.replace(/\p{Co}/gu, '');
  title = title.replace(/\p{Cn}/gu, '');

  // normalize whitespace
  title = title.replace(/\p{Zs}+/gu, ' ');

  return title.trim();
};

export const uploadFile = async (filePath: string, basePath: string) => {
  const client = await APIclient();
  const formData = new FormData();
  const title = await normalizeTitle(filePath, basePath);
  const csrfToken = await getCsrfToken();
  formData.append('title', title);
  formData.append('file', fs.createReadStream(filePath));
  const response = await client.post('/v0/private_papers', formData, {
    headers: { 'x-csrf-token': csrfToken, ...formData.getHeaders() },
    validateStatus: () => {
      // Allow everything so we can give the user feedback on the error
      return true;
    },
  });
  return response;
};

export const searchFiles = async (searchTerm: string) => {
  const client = await APIclient();
  const response = await client.get('/v0/private_papers/', {
    params: { search: searchTerm },
  });
  return response.data;
};

export const downloadFileFromS3 = async (folderName: string, fileKey: string): Promise<Buffer> => {
  const client = await APIclient();
  const response = await client.get(
    '/v0/sync_agent/download',
    {
      params: {
        folder_name: folderName,
        file_key: fileKey,
      },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(response.data);
};

export const getLatestFiles = async (): Promise<GetLatestResponse> => {
  const client = await APIclient();
  const response = await client.get('/v0/sync_agent/get_latest');
  return response.data;
};

export const syncFile = async (
  actionType: 'add' | 'update' | 'remove',
  folderName: string,
  relativePath: string,
  filePath?: string
): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();

  if (actionType === 'remove') {
    const response = await client.post(
      '/v0/sync_agent/sync',
      {
        action_type: actionType,
        folder_name: folderName,
        relative_path: relativePath,
      },
      {
        headers: { 'x-csrf-token': csrfToken },
        validateStatus: () => true,
      }
    );
    return response;
  } else {
    // For add/update, we need to send the file
    if (!filePath) {
      throw new Error('filePath is required for add/update operations');
    }

    const formData = new FormData();
    formData.append('action_type', actionType);
    formData.append('folder_name', folderName);
    formData.append('relative_path', relativePath);
    formData.append('file', fs.createReadStream(filePath));

    const response = await client.post(
      '/v0/sync_agent/sync',
      formData,
      {
        headers: {
          'x-csrf-token': csrfToken,
          ...formData.getHeaders(),
        },
        validateStatus: () => true,
      }
    );
    return response;
  }
};

export const addSyncAgentFolder = async (folderPath: string): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();
  const folderName = path.basename(folderPath);

  const response = await client.post(
    '/v0/sync_agent/add_folder',
    {
      path: folderPath,
      folder_name: folderName,
    },
    {
      headers: {
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );

  return response;
};

export const removeSyncAgentFolder = async (folderName: string): Promise<void> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();
  await client.delete('/v0/sync_agent/remove_folder', {
    headers: { 'x-csrf-token': csrfToken },
    data: { folder_name: folderName },
  });
};

// New Sync Agent API (aligned with STATUS.md plan)

/**
 * Get complete sync status for user (startup endpoint)
 */
export const getStatus = async (): Promise<any> => {
  const client = await APIclient();
  logger.debug('[API] Calling GET /v0/sync_agent/status');
  const response = await client.get('/v0/sync_agent/status');
  logger.debug('[API] Response status:', response.status);
  // logger.debug('[API] Response data:', JSON.stringify(response.data, null, 2));
  return response.data;
};

/**
 * Add new folder to sync
 */
export const addFolder = async (folderName: string, folderPath: string): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();

  const response = await client.post(
    '/v0/sync_agent/folders',
    {
      folder_name: folderName,
      path: folderPath,
    },
    {
      headers: {
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );

  return response;
};

/**
 * Remove folder from sync
 */
export const removeFolder = async (folderName: string): Promise<void> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();
  await client.delete(`/v0/sync_agent/folders/${folderName}`, {
    headers: { 'x-csrf-token': csrfToken },
  });
};

/**
 * Upload or update a file with checksum support
 */
export const createFile = async (
  folderName: string,
  relativePath: string,
  filePath: string,
  checksum: string,
  mtime: string
): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();

  const formData = new FormData();
  formData.append('folder_name', folderName);
  formData.append('relative_path', relativePath);
  formData.append('checksum', checksum);
  formData.append('mtime', mtime);
  formData.append('file', fs.createReadStream(filePath));

  const response = await client.post(
    '/v0/sync_agent/files',
    formData,
    {
      headers: {
        'x-csrf-token': csrfToken,
        ...formData.getHeaders(),
      },
      validateStatus: () => true,
    }
  );
  return response;
};

/**
 * Delete a file from sync
 */
export const deleteFile = async (
  folderName: string,
  relativePath: string
): Promise<any> => {
  const client = await APIclient();
  const csrfToken = await getCsrfToken();

  const response = await client.delete(
    '/v0/sync_agent/files',
    {
      headers: { 'x-csrf-token': csrfToken },
      data: {
        folder_name: folderName,
        relative_path: relativePath,
      },
      validateStatus: () => true,
    }
  );
  return response;
};

/**
 * List files in a folder
 */
export const listFiles = async (folderName: string): Promise<any> => {
  const client = await APIclient();
  logger.debug('[API] Calling GET /v0/sync_agent/files?folder_name=' + folderName);
  const response = await client.get('/v0/sync_agent/files', {
    params: { folder_name: folderName },
    validateStatus: () => true,
  });
  logger.debug('[API] Response status:', response.status);
  logger.debug('[API] Response data:', JSON.stringify(response.data, null, 2));
  return response.data;
};
