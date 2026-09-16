import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FilesTab } from '../FilesTab';

const mockOpenFile = jest.fn();
const mockSetDockRight = jest.fn();
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
    setDockRightForDocument: mockSetDockRight,
  };
  (window as any).scannedFilesAPI = {
    getAll: mockGetAll,
  };
  (window as any).electronAPI = {
    invoke: jest.fn().mockResolvedValue({ hasPermission: true, started: true }),
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
  delete (window as any).electronAPI;
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

    await act(async () => { btn.click(); });
    await flushPromises();

    expect(mockOpenFile).toHaveBeenCalledWith(
      'file:///workspace/Paper.docx',
      'com.microsoft.Word',
    );
    expect(mockSetDockRight).toHaveBeenCalledWith(
      '/workspace/Paper.docx',
      true,
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

  it('shows "Open in Word" for .docx files not tagged as manuscript', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Notes.docx', path: '/workspace/Notes.docx', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    expect(container.querySelector('[title="Open in Word"]')).not.toBeNull();
  });

  it('hides internal dot-dirs (.applications/.claude/.academia) but shows real files', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: '.applications', path: '/workspace/.applications', isDirectory: true },
      { name: '.claude', path: '/workspace/.claude', isDirectory: true },
      { name: '.academia', path: '/workspace/.academia', isDirectory: true },
      { name: 'Data.csv', path: '/workspace/Data.csv', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    const names = Array.from(container.querySelectorAll('.fileTreeName')).map((el) => el.textContent);
    expect(names).toContain('Data.csv');
    expect(names).not.toContain('.applications');
    expect(names).not.toContain('.claude');
    expect(names).not.toContain('.academia');
  });

  it('shows "Open in Word" for .docx files tagged as grant', async () => {
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

    expect(container.querySelector('[title="Open in Word"]')).not.toBeNull();
  });
});

describe('FilesTab – Share / Copy link / Unpublish (context menu)', () => {
  const mockStatusFile = jest.fn();
  const mockPublishFile = jest.fn();
  const mockUnpublishFile = jest.fn();

  beforeEach(() => {
    (window as any).shareAPI = {
      statusFile: mockStatusFile,
      publishFile: mockPublishFile,
      unpublishFile: mockUnpublishFile,
    };
  });

  afterEach(() => {
    delete (window as any).shareAPI;
  });

  function findRow(name: string): HTMLElement {
    const nameEl = Array.from(container.querySelectorAll('.fileTreeName')).find(
      (el) => el.textContent === name,
    );
    if (!nameEl) throw new Error(`row not found: ${name}`);
    const row = nameEl.closest('.fileTreeRow');
    if (!row) throw new Error(`row wrapper not found for: ${name}`);
    return row as HTMLElement;
  }

  function openContextMenu(row: HTMLElement) {
    return act(async () => {
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
    });
  }

  function menuItemLabels(): (string | null)[] {
    return Array.from(container.querySelectorAll('.fileTreeContextMenuItem')).map((b) => b.textContent);
  }

  function clickMenuItem(label: string) {
    const btn = Array.from(container.querySelectorAll('.fileTreeContextMenuItem')).find(
      (b) => b.textContent === label,
    ) as HTMLButtonElement | undefined;
    if (!btn) throw new Error(`menu item not found: ${label}`);
    return act(async () => { btn.click(); });
  }

  const publishedInfo = {
    id: 'abc123xyz0',
    kind: 'file' as const,
    url: 'https://acabox-share.acct.workers.dev/f/abc123xyz0/',
    hash: 'a'.repeat(64),
    publishedAt: '2026-09-15T00:00:00.000Z',
  };

  it('shows Share… only for an unpublished file', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Data.csv', path: '/workspace/Data.csv', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([]);
    mockStatusFile.mockResolvedValueOnce({ published: null, behind: false });

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    await openContextMenu(findRow('Data.csv'));
    await flushPromises();

    expect(mockStatusFile).toHaveBeenCalledWith('/workspace/Data.csv');
    const labels = menuItemLabels();
    expect(labels).toContain('Share…');
    expect(labels).not.toContain('Copy link');
    expect(labels).not.toContain('Unpublish');
    expect(labels).not.toContain('Refresh shared copy');
  });

  it('shows Copy link, Refresh shared copy and Unpublish for a published+behind file', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Data.csv', path: '/workspace/Data.csv', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([]);
    mockStatusFile.mockResolvedValueOnce({ published: publishedInfo, behind: true });

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    await openContextMenu(findRow('Data.csv'));
    await flushPromises();

    const labels = menuItemLabels();
    expect(labels).toContain('Copy link');
    expect(labels).toContain('Refresh shared copy');
    expect(labels).toContain('Unpublish');
    expect(labels).not.toContain('Share…');
  });

  it('shows Copy link and Unpublish but not Refresh for a published, up-to-date file', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Data.csv', path: '/workspace/Data.csv', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([]);
    mockStatusFile.mockResolvedValueOnce({ published: publishedInfo, behind: false });

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    await openContextMenu(findRow('Data.csv'));
    await flushPromises();

    const labels = menuItemLabels();
    expect(labels).toContain('Copy link');
    expect(labels).toContain('Unpublish');
    expect(labels).not.toContain('Refresh shared copy');
    expect(labels).not.toContain('Share…');
  });

  it('clicking Share… calls publishFile with the node path and renders the returned url', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Data.csv', path: '/workspace/Data.csv', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([]);
    mockStatusFile.mockResolvedValueOnce({ published: null, behind: false });
    mockPublishFile.mockResolvedValueOnce({ ok: true, unchanged: false, published: publishedInfo });

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    await openContextMenu(findRow('Data.csv'));
    await flushPromises();
    await clickMenuItem('Share…');
    await flushPromises();

    expect(mockPublishFile).toHaveBeenCalledWith('/workspace/Data.csv');
    expect(container.textContent).toContain(publishedInfo.url);
  });

  it('renders the error text on a { ok: false, error } publish result', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Data.csv', path: '/workspace/Data.csv', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([]);
    mockStatusFile.mockResolvedValueOnce({ published: null, behind: false });
    mockPublishFile.mockResolvedValueOnce({ ok: false, error: 'Settings are not configured' });

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    await openContextMenu(findRow('Data.csv'));
    await flushPromises();
    await clickMenuItem('Share…');
    await flushPromises();

    expect(container.textContent).toContain('Settings are not configured');
  });

  it('shows no share items and does not call statusFile for a directory node', async () => {
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'SubDir', path: '/workspace/SubDir', isDirectory: true },
    ]);
    mockGetAll.mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    await openContextMenu(findRow('SubDir'));
    await flushPromises();

    expect(mockStatusFile).not.toHaveBeenCalled();
    const labels = menuItemLabels();
    expect(labels).not.toContain('Share…');
    expect(labels).not.toContain('Copy link');
    expect(labels).not.toContain('Unpublish');
    expect(labels).not.toContain('Refresh shared copy');
  });

  it('renders no share items when window.shareAPI is undefined', async () => {
    delete (window as any).shareAPI;
    mockReadDirectory.mockResolvedValueOnce([
      { name: 'Data.csv', path: '/workspace/Data.csv', isDirectory: false },
    ]);
    mockGetAll.mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<FilesTab workspacePath="/workspace" onSelectFile={jest.fn()} />);
    });
    await flushPromises();

    await openContextMenu(findRow('Data.csv'));
    await flushPromises();

    expect(mockStatusFile).not.toHaveBeenCalled();
    const labels = menuItemLabels();
    expect(labels).not.toContain('Share…');
    expect(labels).not.toContain('Copy link');
    expect(labels).not.toContain('Unpublish');
  });
});
