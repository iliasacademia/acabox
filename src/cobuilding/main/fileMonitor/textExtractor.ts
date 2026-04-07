import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

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
      const result = await mammoth.extractRawText({ path: filePath });
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
