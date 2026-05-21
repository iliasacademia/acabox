import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import * as path from 'path';
import * as fs from 'fs/promises';
import { z } from 'zod';

const DEFAULT_MAX_CHARS = 10000;
const SUPPORTED_EXTENSIONS = new Set(['.docx', '.pdf']);

export function createDocumentReaderMcpServer(directoryPaths: string[], _driveEnabled?: boolean) {
  const roots = directoryPaths.map((dp) => path.resolve(dp));

  return createSdkMcpServer({
    name: 'document-reader',
    tools: [
      tool(
        'read_document',
        'Extract text content from a .docx (Word) or .pdf file. Returns plain text.',
        {
          file_path: z.string().describe('Absolute path to a local .docx or .pdf file.'),
          max_chars: z.number().optional().describe(
            `Maximum characters to return (default ${DEFAULT_MAX_CHARS}). Use a smaller value to save tokens when you only need a preview.`
          ),
        },
        async (args) => {
          if (!args.file_path || !args.file_path.trim()) {
            return {
              content: [{ type: 'text' as const, text: 'file_path is required.' }],
              isError: true,
            };
          }
          const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;
          return handleLocalFile(args.file_path.trim(), maxChars, roots);
        },
      ),
    ],
  });
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
