import {
  type SDKMessage,
  type HookCallback,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import { app } from "electron";
import log from "electron-log";
import { tree as generateTreeCli } from "tree-node-cli";
import { createDocumentReaderMcpServer } from "./documentReaderMcpServer";
import { ensureApiKeyApproved } from "../../shared/claudeConfigApproval";

export interface TaggedFileParsed {
  file_path?: unknown;
  path?: unknown;
  file_name?: unknown;
  file_type?: unknown;
}

export type ScannerEvent =
  | { type: "progress"; text: string }
  | { type: "file_activity"; path: string; tool: string }
  | { type: "timing"; label: string; seconds: number }
  | { type: "complete"; reportId: string; reportData: string }
  | { type: "error"; error: string };

export interface DriveDirectoryInfo {
  driveId: string;
  name: string;
  mimeType?: string;
}

export interface ScanParams {
  workspaceId: string;
  cwd: string;
  directoryPaths: string[];
  driveDirectories?: DriveDirectoryInfo[];
  memoryDir: string;
  apiKey: string;
  baseURL?: string;
  onMessage: (event: ScannerEvent) => void;
  onBriefingsChanged: () => void;
}

export interface TreeOutput {
  directoryPath: string;
  tree: string;
  source: 'local' | 'google-drive';
}

export interface ScanContext {
  claudeBinaryPath?: string;
  cwd: string;
  directoryPaths: string[];
  apiKey: string;
  baseURL?: string;
  abortController: AbortController;
  treeOutputs: TreeOutput[];
  workspaceId: string;
  reportId: string;
  memoryDir: string;
  onMessage: (event: ScannerEvent) => void;
  onBriefingsChanged: () => void;
}

export const DIRECTORY_ORGANIZATION_PROMPT = `Please help me organize my research directory. First, inspect the workspace and understand the current file structure, research projects, documents, data, scripts, outputs, and any existing naming conventions. Then recommend an effective organization plan for the directory.

YOU MUST ALWAYS present me with a clear plan before proceeding to take any actions or make any file modifications. Do not move, rename, delete, rewrite, or create files until I explicitly approve the plan.`;

export const FILE_ACCESS_PREAMBLE = `## Hidden files and directories

**Ignore all hidden files and directories** (names starting with a dot, e.g. \`.git\`, \`.vscode\`, \`.env\`, \`.DS_Store\`). Do not scan them, read them, or include them in your report. They are not relevant to the researcher's work. Access to hidden paths is blocked and will fail — do not attempt it.

## Directory boundaries

**Only access files within the provided scan directories.** You may be scanning one or more directories — do not read, glob, or grep paths outside of them. This includes:
- Parent directories (e.g. \`../\`, or absolute paths that go up from a scan root)
- Sibling directories at the same level or above the scan roots
- Any absolute path that does not begin with one of the scan roots

Access to paths outside the scan directories is blocked and will fail — do not attempt it. **Always use absolute paths** when reading files, globbing, or grepping — the working directory is not set to the scan directory, so relative paths will not resolve correctly.

## Token usage

- NEVER read large data files (CSV, JSON data, HDF5, binary files, images, etc.)
- NEVER read large code files in their entirety — just skim the first 20-30 lines for imports and structure
- You CAN read .pdf and .docx (Word) files with the \`mcp__document-reader__read_document\` tool, which extracts the text content. Do NOT use the Read tool for .pdf or .docx files — it cannot read them
- Be selective: only read documents (.pdf, .docx) that appear most relevant based on filename, directory location, and recency — do not read every document
- DO read small text files like README.md, abstracts, paper titles, config files, and requirements.txt
- Use file extensions and filenames to infer content types without reading the files
- Use Grep to search for specific patterns (author names, keywords, abstracts) rather than reading entire files

## File timestamps

The directory tree includes modification dates for each file. Use these to understand what the researcher has been working on recently.

## Google Drive directories

Some directory trees may be labeled "(Google Drive)". These are cloud-hosted files — they are NOT on the local filesystem. **Do not attempt to Read, Glob, or Grep files from Google Drive trees.** Those tools only work on local files.

However, you **CAN read Google Drive documents** using \`mcp__document-reader__read_document\` with the \`drive_file_id\` parameter. Pass the file ID shown in the tree (e.g. for \`paper.pdf (id:abc123)\`, use \`drive_file_id: "abc123"\`). Only Google Docs, .pdf, and .docx files can be read this way — other file types will return an error.

Be selective — downloading files from Google Drive is slower than reading local files, so only read the most relevant documents based on their names and location in the tree.
`;

export const SCAN_SPEED_PREAMBLE = `## Speed is critical — this is your #1 priority

A user is waiting on this scan. You MUST finish as fast as possible. Every extra turn you take is noticeable delay.

- **Minimize turns**: Do as much as you can in each response.
- **Don't over-explore**: A good-enough scan that finishes in 30 seconds is far better than a thorough scan that takes 2 minutes. Once you have enough signal to produce your output, stop exploring and write it.
- **Keep summaries concise**: Write short, focused summaries. Do not pad them with unnecessary detail.

## Using the directory tree

A pre-generated directory tree is included in the user prompt. It shows all non-hidden files with modification dates, sorted by most recent first. Use it to identify the most important files and directories. Do NOT run broad Glob surveys like \`**/*\` — the tree already provides this. Only use Glob for targeted searches if the tree's depth limit may have excluded relevant subdirectories.
`;

export const SYSTEM_PROMPT_PREAMBLE = `${SCAN_SPEED_PREAMBLE}
${FILE_ACCESS_PREAMBLE}`;

export function generateDirectoryTree(directoryPath: string): string {
  const rawTree = generateTreeCli(directoryPath, {
    date: true,
    maxDepth: 4,
    exclude: [/^\./],
    sortBy: "mtime",
  });
  const lines = rawTree.split("\n");
  if (lines.length > 500) {
    log.info(
      `[DirectoryScanner] Tree generated (${lines.length} lines, truncated to 500)`,
    );
    return (
      lines.slice(0, 500).join("\n") +
      `\n... (truncated, ${lines.length - 500} more entries)`
    );
  }
  log.info(`[DirectoryScanner] Tree generated (${lines.length} lines)`);
  return rawTree;
}

export function formatTreesForPrompt(treeOutputs: TreeOutput[]): string {
  if (treeOutputs.length === 1) {
    const t = treeOutputs[0];
    if (t.source === 'google-drive') {
      return `### ${t.directoryPath} (Google Drive)\n\`\`\`\n${t.tree}\n\`\`\``;
    }
    return t.tree;
  }
  return treeOutputs
    .map(({ directoryPath, tree, source }) => {
      const label = source === 'google-drive'
        ? `${directoryPath} (Google Drive)`
        : `${path.basename(directoryPath)} (${directoryPath})`;
      return `### ${label}\n\`\`\`\n${tree}\n\`\`\``;
    })
    .join("\n\n");
}

export async function consumeAgentStream<T>(
  queryInstance: AsyncIterable<SDKMessage>,
  onProgressMessage?: (msg: SDKMessage & Record<string, unknown>) => void,
): Promise<T> {
  for await (const message of queryInstance) {
    const msg = message as SDKMessage & Record<string, unknown>;

    if (msg.type !== "result") {
      onProgressMessage?.(msg);
      continue;
    }

    if (msg.subtype === "success") {
      return (msg as any).structured_output as T;
    }

    const errorText =
      (msg.error as string) || (msg.subtype as string) || "Unknown error";
    throw new Error(errorText);
  }

  throw new Error("Agent stream ended without a result message");
}

export function buildCommonQueryOptions(ctx: ScanContext) {
  const { claudeBinaryPath, directoryPaths, apiKey, baseURL, abortController } =
    ctx;
  const hasDriveItems = ctx.treeOutputs.some(t => t.source === 'google-drive');
  const docReaderTool = "mcp__document-reader__read_document";
  const scannerConfigDir = path.join(app.getPath('userData'), 'scanner-claude-config');
  // Headless Claude Code refuses an env API key it hasn't "approved" — see
  // ensureApiKeyApproved. Without this every scan reports "Not logged in".
  ensureApiKeyApproved(scannerConfigDir, apiKey);
  return {
    abortController,
    ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),
    tools: ["Read", "Glob", "Grep", docReaderTool],
    allowedTools: ["Read", "Glob", "Grep", docReaderTool],
    cwd: ctx.cwd,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,
      ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
      // Pin the scanner's Claude Code CLI state under our own userData. Without
      // this it defaults to ~/.claude + ~/.claude.json, which the original app
      // and the user's own Claude Code CLI also read/rewrite — Acabox scans
      // would race and mutate shared global state.
      CLAUDE_CONFIG_DIR: path.join(app.getPath('userData'), 'scanner-claude-config'),
    },
    mcpServers: {
      "document-reader": createDocumentReaderMcpServer(directoryPaths, hasDriveItems),
    },
    persistSession: false as const,
    thinking: { type: "disabled" as const },
    effort: "low" as const,
    settingSources: [] as any[],
    hooks: createHooks(directoryPaths),
    stderr: (data: string) => {
      for (const line of data.split("\n").filter(Boolean)) {
        log.debug(`[DirectoryScanner:stderr] ${line}`);
      }
    },
  };
}

function createHooks(directoryPaths: string[]) {
  const roots = directoryPaths.map((dp) => path.resolve(dp));

  const getToolPaths = (input: unknown) => {
    const toolInput = (input as PreToolUseHookInput).tool_input as Record<
      string,
      unknown
    >;
    const paths: string[] = [];
    if (typeof toolInput.file_path === "string")
      paths.push(toolInput.file_path);
    if (typeof toolInput.path === "string") paths.push(toolInput.path);
    if (typeof toolInput.pattern === "string") paths.push(toolInput.pattern);
    return paths;
  };

  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });

  const blockHiddenPaths: HookCallback = async (input) => {
    for (const p of getToolPaths(input)) {
      if (p.split("/").some((seg) => seg.startsWith(".") && seg.length > 1)) {
        return deny(`Access to hidden paths is not allowed: ${p}`);
      }
    }
    return {};
  };

  const blockOutsideCwd: HookCallback = async (input) => {
    for (const p of getToolPaths(input)) {
      if (!p.trim()) continue;
      const isAllowed = roots.some((root) => {
        const resolved = path.resolve(root, p);
        return resolved === root || resolved.startsWith(root + path.sep);
      });
      if (!isAllowed) {
        return deny(`Access outside the scan directories is not allowed: ${p}`);
      }
    }
    return {};
  };

  return {
    PreToolUse: [
      { matcher: "Read|Glob|Grep|mcp__document-reader__read_document", hooks: [blockHiddenPaths, blockOutsideCwd] },
    ],
  };
}
