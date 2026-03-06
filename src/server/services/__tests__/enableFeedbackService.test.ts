import { enableFeedback } from '../enableFeedbackService';

// Mock dependencies
jest.mock('../../../apiClient', () => ({
  APIclient: jest.fn(),
  getCsrfToken: jest.fn().mockResolvedValue('mock-csrf-token'),
}));

jest.mock('../../../windowMonitorService', () => ({
  windowMonitorService: {
    getDocumentPathForWindow: jest.fn(),
    setSelectedTextReviewState: jest.fn(),
    closePopupForWindow: jest.fn(),
  },
}));

jest.mock('../../../projectSyncService', () => ({
  projectSyncService: {
    startWatchingFile: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../manuscriptPathsService', () => ({
  refreshManuscriptPaths: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../utils/logger', () => ({
  defaultLogger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

import { APIclient } from '../../../apiClient';
import { windowMonitorService } from '../../../windowMonitorService';
import { projectSyncService } from '../../../projectSyncService';
import { refreshManuscriptPaths } from '../manuscriptPathsService';

const mockAPIclient = APIclient as jest.MockedFunction<typeof APIclient>;
const mockGetDocPath = windowMonitorService.getDocumentPathForWindow as jest.Mock;

describe('enableFeedback', () => {
  let mockClient: { post: jest.Mock; get: jest.Mock };
  let mockNavigationHandler: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      post: jest.fn(),
      get: jest.fn(),
    };
    mockAPIclient.mockResolvedValue(mockClient as any);
    mockNavigationHandler = jest.fn().mockResolvedValue(undefined);
  });

  it('should orchestrate the full enable feedback flow', async () => {
    mockGetDocPath.mockReturnValue('/Users/test/Documents/My Paper.docx');

    // Create project response
    mockClient.post
      .mockResolvedValueOnce({
        data: { project: { id: 42, name: 'My Paper' } },
      })
      // Trigger full review response
      .mockResolvedValueOnce({
        data: { agent_run_id: 1, status: 'started' },
      });

    // Get files response
    mockClient.get.mockResolvedValueOnce({
      data: { files: [
        { id: 100, file_path: '/Users/test/Documents/My Paper.docx', is_primary_manuscript: true },
      ]},
    });

    const result = await enableFeedback('wid-123', mockNavigationHandler);

    expect(result).toEqual({ success: true, projectId: 42, projectFileId: 100 });

    // Verify project creation
    expect(mockClient.post).toHaveBeenCalledWith(
      'v0/co_scientist/projects',
      { project: { name: 'My Paper', file_path: '/Users/test/Documents/My Paper.docx' } },
      expect.objectContaining({ headers: expect.any(Object) }),
    );

    // Verify file sync
    expect(projectSyncService.startWatchingFile).toHaveBeenCalledWith(42, '/Users/test/Documents/My Paper.docx');

    // Verify manuscript paths refresh
    expect(refreshManuscriptPaths).toHaveBeenCalled();

    // Verify full review trigger
    expect(mockClient.post).toHaveBeenCalledWith(
      'v0/co_scientist/projects/42/files/100/trigger_full_review',
      {},
      expect.objectContaining({ headers: expect.any(Object) }),
    );

    // Verify review state set
    expect(windowMonitorService.setSelectedTextReviewState).toHaveBeenCalledWith(
      'wid-123', 42, 100, 'full-paper',
    );

    // Verify navigation
    expect(mockNavigationHandler).toHaveBeenCalledWith({ page: 'conversations', projectId: 42 });

    // Verify popup closed
    expect(windowMonitorService.closePopupForWindow).toHaveBeenCalledWith('wid-123', false);
  });

  it('should return error when no document path found', async () => {
    mockGetDocPath.mockReturnValue(null);

    const result = await enableFeedback('wid-123');

    expect(result).toEqual({ success: false, error: 'No document path found for this window' });
    expect(mockAPIclient).not.toHaveBeenCalled();
  });

  it('should return error when project creation fails', async () => {
    mockGetDocPath.mockReturnValue('/Users/test/Documents/Paper.docx');
    mockClient.post.mockResolvedValueOnce({ data: {} });

    const result = await enableFeedback('wid-123');

    expect(result).toEqual({
      success: false,
      error: 'Project creation failed: no project ID returned',
    });
  });

  it('should return error when project file ID cannot be found', async () => {
    mockGetDocPath.mockReturnValue('/Users/test/Documents/Paper.docx');
    mockClient.post.mockResolvedValueOnce({
      data: { project: { id: 42 } },
    });
    mockClient.get.mockResolvedValueOnce({ data: { files: [] } });

    const result = await enableFeedback('wid-123');

    expect(result).toEqual({
      success: false,
      error: 'Could not find project file ID after creation',
      projectId: 42,
    });
  });

  it('should derive project name correctly from various filenames', async () => {
    const testCases = [
      { path: '/Users/test/My Paper.docx', expectedName: 'My Paper' },
      { path: '/Users/test/paper.doc', expectedName: 'paper' },
      { path: '/Users/test/no-extension', expectedName: 'no-extension' },
      { path: '/Users/test/file.name.with.dots.docx', expectedName: 'file.name.with.dots' },
    ];

    for (const tc of testCases) {
      jest.clearAllMocks();
      mockAPIclient.mockResolvedValue(mockClient as any);
      mockGetDocPath.mockReturnValue(tc.path);
      mockClient.post.mockResolvedValueOnce({ data: { project: { id: 1 } } });
      mockClient.get.mockResolvedValueOnce({
        data: { files: [{ id: 10, is_primary_manuscript: true }] },
      });
      mockClient.post.mockResolvedValueOnce({ data: {} });

      await enableFeedback('wid-test');

      expect(mockClient.post).toHaveBeenCalledWith(
        'v0/co_scientist/projects',
        expect.objectContaining({
          project: expect.objectContaining({ name: tc.expectedName }),
        }),
        expect.any(Object),
      );
    }
  });

  it('should handle API error gracefully', async () => {
    mockGetDocPath.mockReturnValue('/Users/test/Paper.docx');
    mockClient.post.mockRejectedValueOnce(new Error('Network failure'));

    const result = await enableFeedback('wid-123');

    expect(result).toEqual({ success: false, error: 'Network failure' });
  });

  it('should continue even if navigation fails', async () => {
    mockGetDocPath.mockReturnValue('/Users/test/Paper.docx');
    mockClient.post
      .mockResolvedValueOnce({ data: { project: { id: 42 } } })
      .mockResolvedValueOnce({ data: {} });
    mockClient.get.mockResolvedValueOnce({
      data: { files: [{ id: 100, is_primary_manuscript: true }] },
    });

    const failingNavHandler = jest.fn().mockRejectedValue(new Error('Nav failed'));

    const result = await enableFeedback('wid-123', failingNavHandler);

    expect(result).toEqual({ success: true, projectId: 42, projectFileId: 100 });
    expect(windowMonitorService.closePopupForWindow).toHaveBeenCalled();
  });

  it('should work without navigation handler', async () => {
    mockGetDocPath.mockReturnValue('/Users/test/Paper.docx');
    mockClient.post
      .mockResolvedValueOnce({ data: { project: { id: 42 } } })
      .mockResolvedValueOnce({ data: {} });
    mockClient.get.mockResolvedValueOnce({
      data: { files: [{ id: 100, is_primary_manuscript: true }] },
    });

    const result = await enableFeedback('wid-123', null);

    expect(result).toEqual({ success: true, projectId: 42, projectFileId: 100 });
  });
});
