import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FilesTab } from '../FilesTab';

const mockOpenFile = jest.fn();
const mockReadDirectory = jest.fn().mockResolvedValue([]);
const mockGetAll = jest.fn().mockResolvedValue([]);

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (window as any).filesAPI = {
    readDirectory: mockReadDirectory,
    revealInFinder: jest.fn(),
    deleteFile: jest.fn(),
    renameFile: jest.fn(),
    copyToWorkspace: jest.fn(),
    moveFile: jest.fn(),
    createFile: jest.fn(),
    createDirectory: jest.fn(),
    selectFile: jest.fn(),
    getPathForFile: jest.fn(),
    onCopyProgress: jest.fn(() => () => {}),
    onWorkspaceChanged: jest.fn(() => () => {}),
  };
  (window as any).fileMonitorAPI = {
    openFile: mockOpenFile,
  };
  (window as any).scannedFilesAPI = {
    getAll: mockGetAll,
  };
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  jest.clearAllMocks();
});

afterAll(() => {
  delete (window as any).filesAPI;
  delete (window as any).fileMonitorAPI;
  delete (window as any).scannedFilesAPI;
});

function flushPromises() {
  return act(() => new Promise((r) => setTimeout(r, 0)));
}

describe('FilesTab – Open in Word button', () => {
  it('shows "Open in Word" button for .docx files tagged as manuscript', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Paper.docx', path: '/workspace/Paper.docx', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([
      { file_path: 'Paper.docx', file_type: 'manuscript' },
    ]);

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    const btn = container.querySelector('[title="Open in Word"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    act(() => { btn.click(); });

    expect(mockOpenFile).toHaveBeenCalledWith(
      'file:///workspace/Paper.docx',
      'com.microsoft.Word',
    );
  });

  it('does not show "Open in Word" for non-docx manuscript files', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Paper.pdf', path: '/workspace/Paper.pdf', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([
      { file_path: 'Paper.pdf', file_type: 'manuscript' },
    ]);

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    expect(container.querySelector('[title="Open in Word"]')).toBeNull();
  });

  it('does not show "Open in Word" for .docx files not tagged as manuscript', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Notes.docx', path: '/workspace/Notes.docx', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    expect(container.querySelector('[title="Open in Word"]')).toBeNull();
  });

  it('does not show "Open in Word" for .docx files tagged as grant', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Proposal.docx', path: '/workspace/Proposal.docx', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([
      { file_path: 'Proposal.docx', file_type: 'grant' },
    ]);

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    expect(container.querySelector('[title="Open in Word"]')).toBeNull();
  });
});
