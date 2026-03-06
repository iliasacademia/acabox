import { refreshManuscriptPaths } from '../manuscriptPathsService';

// Mock dependencies
jest.mock('../../../apiClient', () => ({
  APIclient: jest.fn(),
  checkLogin: jest.fn(),
}));

jest.mock('../../../wordIntegrationDataStoreV2', () => ({
  wordIntegrationDataStoreV2: {
    setProjectFileCache: jest.fn(),
  },
  ProjectFileInfo: {},
}));

jest.mock('../../../shared/types', () => ({
  FEATURES: {
    MS_WORD_INTEGRATION_ENABLED: true,
    MS_WORD_V2_ENABLED: true,
  },
}));

jest.mock('../../../utils/logger', () => ({
  defaultLogger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../../../remoteFeatureFlags', () => ({
  remoteFeatureFlags: {
    getFlag: jest.fn().mockReturnValue(false),
  },
  REMOTE_FLAGS: {
    VERBOSE_WINDOW_MONITOR_LOGGING: 'verbose_window_monitor_logging',
  },
}));

import { APIclient, checkLogin } from '../../../apiClient';
import { wordIntegrationDataStoreV2 } from '../../../wordIntegrationDataStoreV2';
import { FEATURES } from '../../../shared/types';

const mockCheckLogin = checkLogin as jest.MockedFunction<typeof checkLogin>;
const mockAPIclient = APIclient as jest.MockedFunction<typeof APIclient>;

describe('refreshManuscriptPaths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should populate cache with manuscript files from all projects', async () => {
    mockCheckLogin.mockResolvedValue(true);

    const mockClient = {
      get: jest.fn().mockResolvedValueOnce({
        data: {
          files: [
            { id: 10, file_path: '/path/to/doc1.docx', is_primary_manuscript: true, project_id: 1 },
            { id: 20, file_path: '/path/to/doc2.docx', is_primary_manuscript: true, project_id: 2 },
          ],
          pagination: { has_more: false },
        },
      }),
    };
    mockAPIclient.mockResolvedValue(mockClient as any);

    await refreshManuscriptPaths();

    expect(mockClient.get).toHaveBeenCalledWith('/v0/co_scientist/files', {
      params: { is_primary_manuscript: true, limit: 50, page: 1 },
    });
    expect(wordIntegrationDataStoreV2.setProjectFileCache).toHaveBeenCalledTimes(1);
    const cache = (wordIntegrationDataStoreV2.setProjectFileCache as jest.Mock).mock.calls[0][0] as Map<string, any>;
    expect(cache.size).toBe(2);
    expect(cache.get('/path/to/doc1.docx')).toEqual({ project_id: 1, project_file_id: 10 });
    expect(cache.get('/path/to/doc2.docx')).toEqual({ project_id: 2, project_file_id: 20 });
  });

  it('should paginate through all results', async () => {
    mockCheckLogin.mockResolvedValue(true);

    const mockClient = {
      get: jest.fn()
        .mockResolvedValueOnce({
          data: {
            files: [
              { id: 10, file_path: '/path/to/doc1.docx', is_primary_manuscript: true, project_id: 1 },
            ],
            pagination: { has_more: true },
          },
        })
        .mockResolvedValueOnce({
          data: {
            files: [
              { id: 20, file_path: '/path/to/doc2.docx', is_primary_manuscript: true, project_id: 2 },
            ],
            pagination: { has_more: false },
          },
        }),
    };
    mockAPIclient.mockResolvedValue(mockClient as any);

    await refreshManuscriptPaths();

    expect(mockClient.get).toHaveBeenCalledTimes(2);
    expect(mockClient.get).toHaveBeenNthCalledWith(1, '/v0/co_scientist/files', {
      params: { is_primary_manuscript: true, limit: 50, page: 1 },
    });
    expect(mockClient.get).toHaveBeenNthCalledWith(2, '/v0/co_scientist/files', {
      params: { is_primary_manuscript: true, limit: 50, page: 2 },
    });
    const cache = (wordIntegrationDataStoreV2.setProjectFileCache as jest.Mock).mock.calls[0][0] as Map<string, any>;
    expect(cache.size).toBe(2);
  });

  it('should skip files missing file_path or project_id', async () => {
    mockCheckLogin.mockResolvedValue(true);

    const mockClient = {
      get: jest.fn().mockResolvedValueOnce({
        data: {
          files: [
            { id: 10, file_path: '/path/to/doc1.docx', is_primary_manuscript: true, project_id: 1 },
            { id: 11, file_path: null, is_primary_manuscript: true, project_id: 2 },
            { id: 12, file_path: '/path/to/doc3.docx', is_primary_manuscript: true, project_id: null },
          ],
          pagination: { has_more: false },
        },
      }),
    };
    mockAPIclient.mockResolvedValue(mockClient as any);

    await refreshManuscriptPaths();

    const cache = (wordIntegrationDataStoreV2.setProjectFileCache as jest.Mock).mock.calls[0][0] as Map<string, any>;
    expect(cache.size).toBe(1);
    expect(cache.get('/path/to/doc1.docx')).toEqual({ project_id: 1, project_file_id: 10 });
  });

  it('should clear cache when user is logged out', async () => {
    mockCheckLogin.mockResolvedValue(false);

    await refreshManuscriptPaths();

    expect(wordIntegrationDataStoreV2.setProjectFileCache).toHaveBeenCalledWith(new Map());
    expect(mockAPIclient).not.toHaveBeenCalled();
  });

  it('should set empty cache when no manuscript files exist', async () => {
    mockCheckLogin.mockResolvedValue(true);
    const mockClient = {
      get: jest.fn().mockResolvedValueOnce({
        data: { files: [], pagination: { has_more: false } },
      }),
    };
    mockAPIclient.mockResolvedValue(mockClient as any);

    await refreshManuscriptPaths();

    expect(wordIntegrationDataStoreV2.setProjectFileCache).toHaveBeenCalledWith(new Map());
  });

  it('should skip when features are disabled', async () => {
    (FEATURES as any).MS_WORD_INTEGRATION_ENABLED = false;

    await refreshManuscriptPaths();

    expect(mockCheckLogin).not.toHaveBeenCalled();
    expect(wordIntegrationDataStoreV2.setProjectFileCache).not.toHaveBeenCalled();

    // Restore
    (FEATURES as any).MS_WORD_INTEGRATION_ENABLED = true;
  });

  it('should throw when the API call fails', async () => {
    mockCheckLogin.mockResolvedValue(true);
    const mockClient = {
      get: jest.fn().mockRejectedValueOnce(new Error('Network error')),
    };
    mockAPIclient.mockResolvedValue(mockClient as any);

    await expect(refreshManuscriptPaths()).rejects.toThrow('Network error');
    expect(wordIntegrationDataStoreV2.setProjectFileCache).not.toHaveBeenCalled();
  });
});
