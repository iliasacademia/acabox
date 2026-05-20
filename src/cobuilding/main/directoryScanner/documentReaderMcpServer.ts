import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import * as path from 'path';
import * as fs from 'fs/promises';
import { z } from 'zod';
import { downloadFileForDocumentReader } from '../googleDriveService';

const DEFAULT_MAX_CHARS = 10000;
const SUPPORTED_EXTENSIONS = new Set(['.docx', '.pdf']);

export function createDocumentReaderMcpServer(directoryPaths: string[], driveEnabled?: boolean) {
  const roots = directoryPaths.map((dp) => path.resolve(dp));

  return createSdkMcpServer({
    name: 'document-reader',
    tools: [
      tool(
        'read_document',
        'Extract text content from a .docx (Word) or .pdf file. Returns plain text. ' +
        'Use this for local files (pass file_path) or Google Drive files (pass drive_file_id). ' +
        'For Google Drive, only Google Docs, .pdf, and .docx files are supported.',
        {
          file_path: z.string().optional().describe('Absolute path to a local .docx or .pdf file.'),
          drive_file_id: z.string().optional().describe(
            'Google Drive file ID (from the tree output, e.g. id:abc123). Use this for files in Google Drive directories.'
          ),
          max_chars: z.number().optional().describe(
            `Maximum characters to return (default ${DEFAULT_MAX_CHARS}). Use a smaller value to save tokens when you only need a preview.`
          ),
        },
        async (args) => {
          const hasFilePath = args.file_path && args.file_path.trim();
          const hasDriveId = args.drive_file_id && args.drive_file_id.trim();

          if (hasFilePath && hasDriveId) {
            return {
              content: [{ type: 'text' as const, text: 'Provide either file_path or drive_file_id, not both.' }],
              isError: true,
            };
          }

          if (!hasFilePath && !hasDriveId) {
            return {
              content: [{ type: 'text' as const, text: 'Provide either file_path (for local files) or drive_file_id (for Google Drive files).' }],
              isError: true,
            };
          }

          const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;

          if (hasDriveId) {
            return handleDriveFile(args.drive_file_id!.trim(), maxChars, driveEnabled);
          }

          return handleLocalFile(args.file_path!.trim(), maxChars, roots);
        },
      ),
    ],
  });
}

async function handleDriveFile(driveFileId: string, maxChars: number, driveEnabled?: boolean) {
  if (!driveEnabled) {
    return {
      content: [{ type: 'text' as const, text: 'Google Drive reading is not available in this scan.' }],
      isError: true,
    };
  }

  try {
    const result = await downloadFileForDocumentReader(driveFileId);
    if (!result.success || !result.data) {
      return {
        content: [{ type: 'text' as const, text: result.error ?? 'Failed to download file from Google Drive.' }],
        isError: true,
      };
    }

    const { buffer, name, effectiveExtension } = result.data;
    const rawText = await extractTextFromBuffer(buffer, effectiveExtension);

    const text = rawText.slice(0, maxChars);
    const truncated = rawText.length > maxChars;
    const header = `[${name}] ${text.length} chars${truncated ? ` (truncated from ${rawText.length})` : ''} (Google Drive)`;
    return {
      content: [{ type: 'text' as const, text: `${header}\n\n${text}` }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Failed to read Google Drive document: ${message}` }],
      isError: true,
    };
  }
}

async function handleLocalFile(filePath: string, maxChars: number, roots: string[]) {
  try {
    const resolved = path.resolve(filePath);

    const withinRoots = roots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!withinRoots) {
      return {
        content: [{ type: 'text' as const, text: `Access denied: path is outside the scan directories.` }],
        isError: true,
      };
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        content: [{ type: 'text' as const, text: `Unsupported file type "${ext}". This tool reads .docx and .pdf files.` }],
        isError: true,
      };
    }

    await fs.access(resolved);

    let rawText: string;
    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ path: resolved });
      rawText = result.value;
    } else {
      const { PDFParse } = await import('pdf-parse');
      const buffer = await fs.readFile(resolved);
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      await parser.destroy();
      rawText = result.text;
    }

    const text = rawText.slice(0, maxChars);
    const truncated = rawText.length > maxChars;

    const header = `[${path.basename(resolved)}] ${text.length} chars${truncated ? ` (truncated from ${rawText.length})` : ''}`;
    return {
      content: [{ type: 'text' as const, text: `${header}\n\n${text}` }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Failed to read document: ${message}` }],
      isError: true,
    };
  }
}

async function extractTextFromBuffer(buffer: Buffer, extension: '.docx' | '.pdf'): Promise<string> {
  if (extension === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } else {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    return result.text;
  }
}
