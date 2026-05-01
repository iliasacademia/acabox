import { promises as fs, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { defaultLogger as logger } from '../../../utils/logger';
import { createObsidianMcpServer } from '../mcpServers/obsidianMcpServer';
import type { HostApp, ApplyEditParams, ApplyEditResult, PreToolUseHook } from './types';

const OBSIDIAN_BUNDLE_ID = 'md.obsidian';

const OBSIDIAN_ALLOWED_TOOLS = [
  'mcp__obsidian__get_active_note',
  'mcp__obsidian__get_text',
  'mcp__obsidian__list_notes',
  'mcp__obsidian__open_note',
  'mcp__obsidian__find_and_replace',
];

const OBSIDIAN_SYSTEM_PROMPT_APPEND = `When the user wants to make edits or suggestions to a markdown note open in Obsidian:

IMPORTANT: NEVER edit .md files inside the workspace using Read/Write/Edit tools. ALWAYS use the obsidian MCP tools so the user can review each change with an Approve/Deny card.

1. Call mcp__obsidian__get_active_note to learn which note is in front of the user.
2. Call mcp__obsidian__get_text to read the note content.
3. Call mcp__obsidian__find_and_replace to propose edits. Call the tool once per edit. The UI automatically renders a suggestion card with the diff and approve/deny buttons — do NOT describe or preview the edits in your text.
4. After proposing edits, say something brief like "I've proposed N edits — please review above." Approved edits are written to disk and Obsidian auto-reloads the note.

The user sees edits appear live in Obsidian once they approve. Do NOT use any other method to edit markdown files in the vault.`;

/**
 * Walk an Obsidian workspace.json tree and return the file path referenced by
 * the leaf whose id matches `activeId`, or null if not found / not a markdown leaf.
 *
 * Tree shape (simplified):
 *   { main: { children: [{ children: [{ id, type: 'leaf', state: { type: 'markdown', state: { file: 'Sample.md' }}}]}]}, active: 'leaf-id' }
 */
function findActiveFileInWorkspace(node: any, activeId: string | null): string | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'leaf' && node.id === activeId) {
    const inner = node.state?.state;
    const file = typeof inner?.file === 'string' ? inner.file : null;
    const leafType = node.state?.type;
    if (file && leafType === 'markdown') return file;
    return null;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findActiveFileInWorkspace(child, activeId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Read .obsidian/workspace.json from `vaultDir` and return the relative path
 * (e.g. "Sample.md" or "subfolder/Note.md") of the active markdown leaf.
 *
 * Returns null when:
 * - workspace.json doesn't exist (vault was never opened, not an Obsidian vault)
 * - workspace.json is malformed
 * - the active leaf isn't a markdown file (e.g. canvas, search, file-explorer)
 */
export function readActiveNoteFromWorkspaceJson(vaultDir: string | null): string | null {
  if (!vaultDir) return null;
  const wsPath = path.join(vaultDir, '.obsidian', 'workspace.json');
  if (!existsSync(wsPath)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(wsPath, 'utf-8'));
  } catch (err) {
    logger.warn(`[ObsidianHostApp] Failed to parse workspace.json: ${(err as Error).message}`);
    return null;
  }
  const activeId: string | null = typeof parsed.active === 'string' ? parsed.active : null;
  if (!activeId) return null;
  const main = parsed.main;
  return findActiveFileInWorkspace(main, activeId);
}

/**
 * Resolve the absolute path of the currently active note in Obsidian.
 *
 * Reads `.obsidian/workspace.json` inside the workspace (which IS the vault),
 * walks the leaf tree to find the active markdown leaf, and joins its relative
 * path to the workspace root.
 *
 * Returns null when the active leaf isn't a markdown file or the file doesn't
 * exist on disk (e.g. user is on a canvas/PDF/image, or has Obsidian open on a
 * different vault than our workspace).
 */
export function resolveObsidianDocumentPath(workspaceDir: string | null): string | null {
  if (!workspaceDir) return null;
  const relFile = readActiveNoteFromWorkspaceJson(workspaceDir);
  if (!relFile) return null;
  const candidate = path.join(workspaceDir, relFile);
  if (!existsSync(candidate)) return null;
  if (!candidate.toLowerCase().endsWith('.md')) return null;
  return candidate;
}

/** Verify that this looks like an Obsidian vault directory. */
export function isObsidianVault(workspaceDir: string | null): boolean {
  if (!workspaceDir) return false;
  return existsSync(path.join(workspaceDir, '.obsidian'));
}

/**
 * Block direct .md file edits — force the agent to use mcp__obsidian__find_and_replace
 * so each change goes through the Approve/Deny card. Only active when the
 * workspace is an Obsidian vault.
 *
 * Allows: Read on .md, Write/Edit on non-.md files (e.g. mini-app code, SOUL.md
 * adjustments outside Obsidian's "live" notes are still permitted).
 */
const obsidianProtectionHook: PreToolUseHook = async (input: HookInput): Promise<SyncHookJSONOutput> => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const { tool_name, tool_input } = input;
  const toolInput = (tool_input ?? {}) as Record<string, unknown>;

  // Only block Edit/Write on .md files. Read is fine (the MCP get_text tool
  // also reads, but this lets the agent fall back if needed).
  if (tool_name !== 'Edit' && tool_name !== 'Write') return {};

  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
  if (!filePath) return {};
  if (!filePath.toLowerCase().endsWith('.md')) return {};

  return {
    decision: 'block',
    reason: 'Do not edit .md files directly. Use mcp__obsidian__find_and_replace so the user can approve each change in the overlay UI. The edit will be written to disk and Obsidian will auto-reload the note when approved.',
  } as any;
};

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

interface ApplyOpts {
  exactCase: boolean;
  scope: 'first' | 'all';
}

/** Apply find/replace to `original`. Returns {newContent, count} or {error}. */
function applyFindReplace(original: string, search: string, replacement: string, opts: ApplyOpts): { newContent?: string; count: number; error?: string } {
  const haystack = opts.exactCase ? original : original.toLowerCase();
  const needle = opts.exactCase ? search : search.toLowerCase();
  if (!needle) return { count: 0, error: 'search_text is empty' };

  const indices: number[] = [];
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    indices.push(i);
    from = i + needle.length;
    if (opts.scope === 'first') break;
  }

  if (indices.length === 0) return { count: 0, error: 'search_text not found' };

  // Apply from the back so earlier offsets stay valid.
  let result = original;
  for (let i = indices.length - 1; i >= 0; i--) {
    const start = indices[i];
    result = result.slice(0, start) + replacement + result.slice(start + needle.length);
  }
  return { newContent: result, count: indices.length };
}

async function obsidianApplyEdit(params: ApplyEditParams): Promise<ApplyEditResult> {
  const { document_path, search_text, replacement_text, replace_scope, match_case } = params;
  if (!document_path) {
    return { success: false, error: 'document_path is required for Obsidian edits', replacementsCount: 0 };
  }
  if (!document_path.toLowerCase().endsWith('.md')) {
    return { success: false, error: 'Obsidian apply-edit only supports markdown files', replacementsCount: 0 };
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(document_path);
  } catch (err) {
    return { success: false, error: `Cannot resolve path: ${(err as Error).message}`, replacementsCount: 0 };
  }

  let mtimeBefore: number;
  try {
    mtimeBefore = (await fs.stat(realPath)).mtimeMs;
  } catch (err) {
    return { success: false, error: `Cannot stat file: ${(err as Error).message}`, replacementsCount: 0 };
  }

  let original: string;
  try {
    original = await fs.readFile(realPath, 'utf-8');
  } catch (err) {
    return { success: false, error: `Cannot read file: ${(err as Error).message}`, replacementsCount: 0 };
  }

  // Normalize line endings on both sides for matching, but preserve the file's
  // original line-ending style on write. Obsidian writes \n on macOS so this is
  // typically a no-op, but if the file came from another tool we don't want to
  // silently CRLF→LF the entire file.
  const fileLE: '\r\n' | '\n' = original.includes('\r\n') ? '\r\n' : '\n';
  const normOriginal = normalizeLineEndings(original);
  const normSearch = normalizeLineEndings(search_text);
  const normReplacement = normalizeLineEndings(replacement_text);

  const result = applyFindReplace(normOriginal, normSearch, normReplacement, {
    exactCase: match_case ?? true,
    scope: (replace_scope as 'first' | 'all') || 'first',
  });

  if (result.error || !result.newContent) {
    return { success: false, error: result.error ?? 'unknown error', replacementsCount: 0 };
  }

  // Restore the file's original line-ending style.
  const finalContent = fileLE === '\r\n'
    ? result.newContent.replace(/\n/g, '\r\n')
    : result.newContent;

  // Atomic write: write a sibling temp file, then rename. Re-stat first to
  // detect external modifications between read and write.
  let mtimeAfterRead: number;
  try {
    mtimeAfterRead = (await fs.stat(realPath)).mtimeMs;
  } catch (err) {
    return { success: false, error: `Cannot re-stat file: ${(err as Error).message}`, replacementsCount: 0 };
  }
  if (mtimeAfterRead !== mtimeBefore) {
    return {
      success: false,
      error: 'File changed externally between read and write — please retry the edit',
      replacementsCount: 0,
    };
  }

  const tmpDir = path.dirname(realPath);
  const tmpName = `.${path.basename(realPath)}.academia.${process.pid}.${Date.now()}.tmp`;
  const tmpPath = path.join(tmpDir, tmpName);
  try {
    await fs.writeFile(tmpPath, finalContent, 'utf-8');
    await fs.rename(tmpPath, realPath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    return { success: false, error: `Write failed: ${(err as Error).message}`, replacementsCount: 0 };
  }

  logger.info(`[ObsidianHostApp] applied ${result.count} replacement(s) to ${realPath}`);
  return { success: true, replacementsCount: result.count };
}

/**
 * Build the Obsidian HostApp. The factory takes a callback that resolves the
 * active note path on demand (so the MCP server can ask the windowMonitorService
 * what's currently focused without circular imports).
 */
export function createObsidianHostApp(deps: {
  /** Returns the absolute path of the currently active note in Obsidian, or null. */
  getActiveNotePath: () => string | null;
}): HostApp {
  return {
    id: 'obsidian',
    bundleId: OBSIDIAN_BUNDLE_ID,
    displayName: 'Obsidian',
    fileExtensions: ['.md'],

    windowMonitorArgs() {
      return [
        '--bundle-id',
        OBSIDIAN_BUNDLE_ID,
        '--track-text-selection',
        '--track-document-text',
      ];
    },

    resolveDocumentPath(_window, workspaceDir) {
      return resolveObsidianDocumentPath(workspaceDir);
    },

    mcpServerKey: 'obsidian',
    createMcpServer(workspaceDir: string) {
      return createObsidianMcpServer({
        workspaceDir,
        getActiveNotePath: deps.getActiveNotePath,
      });
    },

    allowedTools: OBSIDIAN_ALLOWED_TOOLS,
    preToolHooks: [obsidianProtectionHook],
    systemPromptAppend: OBSIDIAN_SYSTEM_PROMPT_APPEND,

    messagePrefix({ documentPath, selectedText }) {
      let prefix = '';
      if (documentPath) prefix += `Active Obsidian note: ${documentPath}\n`;
      if (selectedText) {
        prefix += `The user has selected the following text in the note. Act ONLY on this selected text, not the entire note.\n"""\n${selectedText}\n"""\n`;
      }
      return prefix;
    },

    applyEdit: obsidianApplyEdit,
  };
}

/**
 * Default Obsidian HostApp instance. The active-note resolver reads
 * `.obsidian/workspace.json` from the current cobuilding workspace directory.
 * This avoids circular imports (windowMonitorService → hostApps → ...) by
 * lazily requiring windowMonitorService at call time only to read
 * `getActiveWorkspaceDirectory()`.
 */
export const obsidianHostApp: HostApp = createObsidianHostApp({
  getActiveNotePath: () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { windowMonitorService } = require('../../../windowMonitorService');
      const workspaceDir = windowMonitorService.getActiveWorkspaceDirectory();
      return resolveObsidianDocumentPath(workspaceDir);
    } catch {
      return null;
    }
  },
});
