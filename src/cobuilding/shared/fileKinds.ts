/**
 * File-kind extension sets — one source of truth for how a file's extension
 * decides what `files:readFile` (main) hands back over IPC, and how the
 * viewer shim (V1, browser-side) must classify the same file when there is no
 * `files:readFile` to call. Both must agree exactly, hence this module lives
 * in `shared/` and stays pure: no Node or Electron imports, so a browser
 * shim can import it unmodified.
 *
 * Precedence matches `main/fileHandlers.ts`'s `files:readFile` handler
 * exactly: image, then pdf, then spreadsheet, then markdown, then csv, else
 * text. Do not reorder `classifyForBridge` without also reordering the
 * handler — a mismatch there is exactly the drift this module exists to
 * prevent.
 */

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
  'tiff',
  'tif',
]);

// PDFs are streamed via the local-file protocol, so the handler's 10 MB read
// limit does not apply to them.
export const PDF_EXTENSIONS: ReadonlySet<string> = new Set(['pdf']);

// Modern Excel formats parsed by ExcelJS in the renderer. Legacy .xls (binary)
// and .ods are not supported by ExcelJS and would fail at parse time.
export const SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xlsx', 'xlsm']);

export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'mdown',
  'mkdn',
  'mkd',
]);

export const CSV_EXTENSIONS: ReadonlySet<string> = new Set(['csv', 'tsv']);

export type BridgeFileKind = 'image' | 'pdf' | 'spreadsheet' | 'markdown' | 'csv' | 'text';

/**
 * Mirrors Node's `path.extname(filePath).slice(1).toLowerCase()` (what the
 * handler uses) without importing `path`, so this module stays Node-free.
 * A dotfile with no other dot (e.g. `.gitignore`) has no extension, matching
 * `path.extname`'s "no `.` other than the first character of the basename"
 * rule — `dot <= 0` catches both "no dot at all" (-1) and "only dot is the
 * leading character" (0).
 */
function extOf(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const base = filePath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Classifies a file by its (lowercase) extension, with the same precedence
 * `files:readFile` applies: image, then pdf, then spreadsheet, then
 * markdown, then csv, else text.
 */
export function classifyForBridge(filePath: string): BridgeFileKind {
  const ext = extOf(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (CSV_EXTENSIONS.has(ext)) return 'csv';
  return 'text';
}

/** A tab character for `.tsv`, the empty string otherwise (Papa Parse auto-detects). */
export function csvDelimiterFor(filePath: string): string {
  return extOf(filePath) === 'tsv' ? '\t' : '';
}
