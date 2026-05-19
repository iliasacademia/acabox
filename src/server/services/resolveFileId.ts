import * as fs from 'fs';

const GDOCS_SCHEME = 'gdocs://';
const APPLENOTES_SCHEME = 'applenotes://';
const GDOCS_ID_RE = /^gdocs:\/\/([a-zA-Z0-9_-]+)$/;
const SYNTHETIC_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Resolve a stable file identifier from a document path.
 *
 * - Local files: inode number via fs.statSync (stable across rename/move)
 * - gdocs:// : Google Doc ID embedded in the path
 * - applenotes:// : note ID embedded in the path
 * - Other synthetic schemes: the full path (already a stable ID)
 * - null/undefined/missing file: null
 */
export function resolveFileId(documentPath: string | null | undefined): string | null {
  if (!documentPath) return null;

  if (documentPath.startsWith(GDOCS_SCHEME)) {
    const m = GDOCS_ID_RE.exec(documentPath);
    return m ? m[1] : null;
  }

  if (documentPath.startsWith(APPLENOTES_SCHEME)) {
    const id = documentPath.slice(APPLENOTES_SCHEME.length);
    return id || null;
  }

  // Other synthetic schemes (e.g. obsidian://) — the path itself is stable
  if (SYNTHETIC_SCHEME_RE.test(documentPath) && !documentPath.startsWith('file://')) {
    return documentPath;
  }

  // Local file — use inode as stable identity
  const filePath = documentPath.startsWith('file://')
    ? decodeURIComponent(documentPath.slice(7))
    : documentPath;

  try {
    return fs.statSync(filePath).ino.toString();
  } catch {
    return null;
  }
}
