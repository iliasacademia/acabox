import { resolveFileId } from '../resolveFileId';
import * as fs from 'fs';

jest.mock('fs');
const mockStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

describe('resolveFileId', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  // --- null / undefined / empty ---

  it('returns null for null input', () => {
    expect(resolveFileId(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(resolveFileId(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveFileId('')).toBeNull();
  });

  // --- Google Docs ---

  it('extracts doc ID from gdocs:// path', () => {
    expect(resolveFileId('gdocs://1Eh17RmtEpMDt4oFn-EufDoWSkxPCT9uw16yxAZGyCcw'))
      .toBe('1Eh17RmtEpMDt4oFn-EufDoWSkxPCT9uw16yxAZGyCcw');
  });

  it('extracts short doc ID from gdocs:// path', () => {
    expect(resolveFileId('gdocs://abc_123-XYZ')).toBe('abc_123-XYZ');
  });

  it('returns null for gdocs:// with no ID', () => {
    expect(resolveFileId('gdocs://')).toBeNull();
  });

  it('returns null for gdocs:// with invalid characters in ID', () => {
    expect(resolveFileId('gdocs://abc def')).toBeNull();
  });

  // --- Apple Notes ---

  it('extracts note ID from applenotes:// path', () => {
    expect(resolveFileId('applenotes://x-coredata://UUID-HERE/ICNote/p123'))
      .toBe('x-coredata://UUID-HERE/ICNote/p123');
  });

  it('returns null for applenotes:// with empty ID', () => {
    expect(resolveFileId('applenotes://')).toBeNull();
  });

  // --- Other synthetic schemes ---

  it('returns full path for unknown synthetic scheme', () => {
    expect(resolveFileId('obsidian://vault/note.md')).toBe('obsidian://vault/note.md');
  });

  // --- Local files (inode) ---

  it('returns inode as string for local file path', () => {
    mockStatSync.mockReturnValue({ ino: 97045348 } as any);
    expect(resolveFileId('/Users/user/Documents/paper.docx')).toBe('97045348');
    expect(mockStatSync).toHaveBeenCalledWith('/Users/user/Documents/paper.docx');
  });

  it('strips file:// prefix before stat', () => {
    mockStatSync.mockReturnValue({ ino: 12345 } as any);
    expect(resolveFileId('file:///Users/user/doc.docx')).toBe('12345');
    expect(mockStatSync).toHaveBeenCalledWith('/Users/user/doc.docx');
  });

  it('decodes percent-encoded file:// paths', () => {
    mockStatSync.mockReturnValue({ ino: 99999 } as any);
    expect(resolveFileId('file:///Users/user/My%20Documents/paper.docx')).toBe('99999');
    expect(mockStatSync).toHaveBeenCalledWith('/Users/user/My Documents/paper.docx');
  });

  it('returns null when file does not exist', () => {
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(resolveFileId('/Users/user/missing.docx')).toBeNull();
  });

  it('returns null when stat throws permission error', () => {
    mockStatSync.mockImplementation(() => { throw new Error('EACCES'); });
    expect(resolveFileId('/Users/user/protected.docx')).toBeNull();
  });

  // --- Same inode after rename/move (the core use case) ---

  it('returns same ID for a file regardless of path (simulating rename)', () => {
    mockStatSync.mockReturnValue({ ino: 97045348 } as any);
    const idBefore = resolveFileId('/Users/user/Documents/draft.docx');
    const idAfter = resolveFileId('/Users/user/Documents/final.docx');
    expect(idBefore).toBe(idAfter);
    expect(idBefore).toBe('97045348');
  });

  it('returns different IDs for different files', () => {
    mockStatSync
      .mockReturnValueOnce({ ino: 111 } as any)
      .mockReturnValueOnce({ ino: 222 } as any);
    const id1 = resolveFileId('/Users/user/a.docx');
    const id2 = resolveFileId('/Users/user/b.docx');
    expect(id1).not.toBe(id2);
  });
});
