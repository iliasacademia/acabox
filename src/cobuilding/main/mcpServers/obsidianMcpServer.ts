import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { shell } from 'electron';
import { defaultLogger as logger } from '../../../utils/logger';

/** Walk `root` recursively, yielding relative paths of files matching `predicate`. */
async function walkRelative(
  root: string,
  predicate: (relPath: string) => boolean,
  shouldDescend: (relDir: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  async function visit(absDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldDescend(relPath)) {
          await visit(path.join(absDir, entry.name), relPath);
        }
      } else if (entry.isFile() && predicate(relPath)) {
        out.push(relPath);
      }
    }
  }
  await visit(root, '');
  return out;
}

const DEFAULT_GET_TEXT_LIMIT = 8000;

/** Normalize a path: resolve, decode file://, follow symlinks if possible. */
async function normalizePath(p: string): Promise<string> {
  let raw = p.startsWith('file://') ? decodeURIComponent(p.slice(7)) : p;
  raw = path.resolve(raw);
  try {
    return await fs.realpath(raw);
  } catch {
    return raw;
  }
}

/** Verify that `target` is contained within `root` after realpath normalization. */
async function isWithinRoot(target: string, root: string): Promise<boolean> {
  const normTarget = await normalizePath(target);
  const normRoot = await normalizePath(root);
  return normTarget === normRoot || normTarget.startsWith(normRoot + path.sep);
}

export interface ObsidianMcpServerDeps {
  /** Vault directory == workspace directory. */
  workspaceDir: string;
  /** Function returning the path of the currently active Obsidian note, or null. */
  getActiveNotePath: () => string | null;
}

/**
 * Build the per-deps tool handler map. Used by both the SDK MCP server (below)
 * and the in-container agent's SSE relay (registerHostMcpServers in
 * cobuilding/main/index.ts) so the two paths can't drift.
 */
export function createObsidianHandlers(deps: ObsidianMcpServerDeps) {
  const { workspaceDir, getActiveNotePath } = deps;

  return {
    get_active_note: async (_args: any = {}) => {
      const active = getActiveNotePath();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, path: active }),
          },
        ],
      };
    },

    get_text: async (args: { path?: string; offset?: number; limit?: number } = {}) => {
      try {
        const target = args.path ?? getActiveNotePath();
        if (!target) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No active note' }) }],
          };
        }
        if (!(await isWithinRoot(target, workspaceDir))) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Path is outside the workspace/vault' }) }],
          };
        }
        const content = await fs.readFile(target, 'utf-8');
        const offset = args.offset ?? 0;
        const limit = args.limit ?? DEFAULT_GET_TEXT_LIMIT;
        const sliced = content.substring(offset, offset + limit);
        const hasMore = offset + limit < content.length;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                path: target,
                totalLength: content.length,
                offset,
                limit,
                content: sliced,
                hasMore,
              }),
            },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }] };
      }
    },

    list_notes: async (args: { subdir?: string } = {}) => {
      try {
        const root = args.subdir ? path.join(workspaceDir, args.subdir) : workspaceDir;
        if (!(await isWithinRoot(root, workspaceDir))) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'subdir is outside the workspace/vault' }) }],
          };
        }
        const matches = await walkRelative(
          root,
          (rel) => rel.toLowerCase().endsWith('.md'),
          (relDir) => !relDir.startsWith('.obsidian') && !relDir.split('/').some((s) => s.startsWith('.')),
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, count: matches.length, notes: matches }) }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }] };
      }
    },

    open_note: async (args: { path: string }) => {
      try {
        if (!(await isWithinRoot(args.path, workspaceDir))) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Path is outside the workspace/vault' }) }],
          };
        }
        const vaultName = path.basename(workspaceDir);
        const relFile = path.relative(workspaceDir, args.path).replace(/\\/g, '/').replace(/\.md$/, '');
        const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relFile)}`;
        await shell.openExternal(url);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, url }) }] };
      } catch (err) {
        logger.error('[Obsidian MCP] open_note error:', err);
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }] };
      }
    },

    find_and_replace: async (args: {
      search_text: string;
      replacement_text: string;
      replace_scope?: 'first' | 'all';
      match_case?: boolean;
      path?: string;
    }) => {
      const target = args.path ?? getActiveNotePath();
      if (!target) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No active note' }) }],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              proposed: true,
              document_path: target,
              search_text: args.search_text,
              replacement_text: args.replacement_text,
              replace_scope: args.replace_scope ?? 'first',
              match_case: args.match_case ?? true,
            }),
          },
        ],
      };
    },
  };
}

export function createObsidianMcpServer(deps: ObsidianMcpServerDeps) {
  const handlers = createObsidianHandlers(deps);

  return createSdkMcpServer({
    name: 'obsidian',
    tools: [
      tool(
        'get_active_note',
        'Get the path of the currently active note in Obsidian. Returns null if no markdown note is active (e.g. user is on a canvas, image preview, or untitled buffer).',
        {},
        handlers.get_active_note,
      ),

      tool(
        'get_text',
        'Read the contents of a markdown note in the workspace. Defaults to the active note. Supports pagination via offset/limit.',
        {
          path: z.string().optional().describe('Absolute path to the .md file to read. Defaults to the active note.'),
          offset: z.number().optional().describe('Character offset to start reading from (0-based, default 0)'),
          limit: z.number().optional().describe('Max characters to return (default 8000)'),
        },
        handlers.get_text,
      ),

      tool(
        'list_notes',
        'List all markdown notes in the workspace/vault. Returns relative paths.',
        {
          subdir: z.string().optional().describe('Optional subdirectory under the vault root to list (e.g. "daily").'),
        },
        handlers.list_notes,
      ),

      tool(
        'open_note',
        'Open (focus) a note in Obsidian by absolute path. Triggers Obsidian to bring its window forward and switch to that note.',
        {
          path: z.string().describe('Absolute path to the .md file inside the vault.'),
        },
        handlers.open_note,
      ),

      tool(
        'find_and_replace',
        `Propose a text edit in a markdown note. The edit is NOT applied immediately — the user sees a suggestion card in the UI and approves or denies each edit. Approved edits are written to disk and Obsidian auto-reloads the buffer.

Call this tool once per edit. Do NOT describe the edits in your text — the UI shows them automatically.`,
        {
          search_text: z.string().describe('The exact text to find in the note'),
          replacement_text: z.string().describe('The text to replace it with'),
          replace_scope: z.enum(['first', 'all']).default('first').describe('"first" replaces only the first occurrence, "all" replaces every occurrence'),
          match_case: z.boolean().default(true).describe('Whether the search is case-sensitive'),
          path: z.string().optional().describe('Absolute path to the .md file. Defaults to the active note.'),
        },
        handlers.find_and_replace,
      ),
    ],
  });
}
