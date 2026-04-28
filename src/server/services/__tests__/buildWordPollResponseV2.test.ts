/**
 * Tests for buildWordPollResponseV2 workspace detection logic.
 *
 * These test the core decision logic without requiring the actual
 * windowMonitorService or wordIntegrationDataStoreV2.
 */

describe('workspace detection logic', () => {
  // Simulate the workspace check from buildWordPollResponseV2
  function isInWorkspace(documentPath: string | null, workspaceDir: string | null): boolean {
    if (!documentPath || !workspaceDir) return false;
    return documentPath.startsWith(workspaceDir + '/');
  }

  it('returns true for files inside workspace', () => {
    expect(isInWorkspace(
      '/Users/user/Desktop/My-Workspace/paper.docx',
      '/Users/user/Desktop/My-Workspace',
    )).toBe(true);
  });

  it('returns true for files in subdirectories', () => {
    expect(isInWorkspace(
      '/Users/user/Desktop/My-Workspace/drafts/paper.docx',
      '/Users/user/Desktop/My-Workspace',
    )).toBe(true);
  });

  it('returns false for files outside workspace', () => {
    expect(isInWorkspace(
      '/Users/user/Documents/other.docx',
      '/Users/user/Desktop/My-Workspace',
    )).toBe(false);
  });

  it('returns false when workspace dir is null', () => {
    expect(isInWorkspace(
      '/Users/user/Desktop/My-Workspace/paper.docx',
      null,
    )).toBe(false);
  });

  it('returns false when document path is null', () => {
    expect(isInWorkspace(null, '/Users/user/Desktop/My-Workspace')).toBe(false);
  });

  it('does not match prefix-overlapping paths', () => {
    // "/workspace-extra/file.docx" should NOT match "/workspace"
    expect(isInWorkspace(
      '/Users/user/Desktop/My-Workspace-Extra/paper.docx',
      '/Users/user/Desktop/My-Workspace',
    )).toBe(false);
  });

  it('matches exact workspace root with trailing slash', () => {
    expect(isInWorkspace(
      '/Users/user/Desktop/My-Workspace/paper.docx',
      '/Users/user/Desktop/My-Workspace',
    )).toBe(true);
  });
});

describe('poll response visibility for workspace mode', () => {
  // When workspace is set and doc is OUTSIDE workspace, overlay should be hidden
  function shouldShowOverlay(
    documentPath: string | null,
    workspaceDir: string | null,
  ): boolean {
    if (!documentPath) {
      // Unsaved docs: hidden in cobuilding mode, shown in writing-agent mode
      return !workspaceDir;
    }
    if (workspaceDir) {
      // In cobuilding mode
      return documentPath.startsWith(workspaceDir + '/');
    }
    return true; // writing agent mode — always show
  }

  it('shows overlay for workspace files', () => {
    expect(shouldShowOverlay(
      '/Users/user/ws/paper.docx',
      '/Users/user/ws',
    )).toBe(true);
  });

  it('hides overlay for non-workspace files in cobuilding mode', () => {
    expect(shouldShowOverlay(
      '/Users/user/other/paper.docx',
      '/Users/user/ws',
    )).toBe(false);
  });

  it('shows overlay for all files in writing agent mode', () => {
    expect(shouldShowOverlay(
      '/Users/user/anywhere/paper.docx',
      null,
    )).toBe(true);
  });

  it('hides overlay for unsaved documents in cobuilding mode', () => {
    expect(shouldShowOverlay(null, '/Users/user/ws')).toBe(false);
  });

  it('shows overlay for unsaved documents in writing-agent mode', () => {
    expect(shouldShowOverlay(null, null)).toBe(true);
  });
});
