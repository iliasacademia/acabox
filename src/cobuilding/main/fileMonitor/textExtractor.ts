import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

// pdfjs-dist (used by pdf-parse) expects DOMMatrix which doesn't exist
// in the Electron main process. Provide a minimal polyfill.
if (typeof (globalThis as any).DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(init?: number[]) {
      if (init && init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    }
  };
}

const PLAIN_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.py', '.js', '.ts', '.tsx', '.jsx',
  '.json', '.csv', '.html', '.xml', '.yaml', '.yml', '.toml',
  '.cfg', '.ini', '.sh', '.bash', '.zsh', '.c', '.cpp', '.h',
  '.java', '.go', '.rs', '.rb', '.swift', '.kt', '.r', '.sql',
  '.css', '.scss', '.less', '.log', '.env', '.gitignore',
  '.dockerfile', '.tex', '.bib', '.rtf',
]);

export async function extractText(filePath: string): Promise<string | null> {
  try {
    const ext = path.extname(filePath).toLowerCase();

    if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
      return await fs.promises.readFile(filePath, 'utf-8');
    }

    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.convertToHtml({ path: filePath });
      return result.value;
    }

    if (ext === '.pdf') {
      const { PDFParse } = await import('pdf-parse');
      const buffer = await fs.promises.readFile(filePath);
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      await parser.destroy();
      return result.text;
    }

    return null;
  } catch (err) {
    log.warn('[TextExtractor] Failed to extract text from', filePath, err);
    return null;
  }
}
