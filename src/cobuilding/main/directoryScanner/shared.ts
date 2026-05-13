import {
  type SDKMessage,
  type HookCallback,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import log from "electron-log";
import { tree as generateTreeCli } from "tree-node-cli";

export interface SuggestionParsed {
  name?: unknown;
  type?: unknown;
  why_im_suggesting_this?: unknown;
  description?: unknown;
}

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

export interface ScanParams {
  workspaceId: string;
  directoryPath: string;
  apiKey: string;
  baseURL?: string;
  onMessage: (event: ScannerEvent) => void;
  onBriefingsChanged: () => void;
}

export interface ScanContext {
  claudeBinaryPath: string;
  directoryPath: string;
  apiKey: string;
  baseURL?: string;
  abortController: AbortController;
  treeOutput: string;
  workspaceId: string;
  reportId: string;
  memoryDir: string;
  onMessage: (event: ScannerEvent) => void;
  onBriefingsChanged: () => void;
}

export const DIRECTORY_ORGANIZATION_PROMPT = `Please help me organize my research directory. First, inspect the workspace and understand the current file structure, research projects, documents, data, scripts, outputs, and any existing naming conventions. Then recommend an effective organization plan for the directory.

YOU MUST ALWAYS present me with a clear plan before proceeding to take any actions or make any file modifications. Do not move, rename, delete, rewrite, or create files until I explicitly approve the plan.`;

export const SYSTEM_PROMPT_PREAMBLE = `## Speed is critical — this is your #1 priority

A user is waiting on this scan. You MUST finish as fast as possible. Every extra turn you take is noticeable delay.

- **Minimize turns**: Do as much as you can in each response.
- **Don't over-explore**: A good-enough scan that finishes in 30 seconds is far better than a thorough scan that takes 2 minutes. Once you have enough signal to produce your output, stop exploring and write it.
- **Keep summaries concise**: Write short, focused summaries. Do not pad them with unnecessary detail.

## Hidden files and directories

**Ignore all hidden files and directories** (names starting with a dot, e.g. \`.git\`, \`.vscode\`, \`.env\`, \`.DS_Store\`). Do not scan them, read them, or include them in your report. They are not relevant to the researcher's work. Access to hidden paths is blocked and will fail — do not attempt it.

## Directory boundaries

**Only access files within the current working directory.** You are scanning one specific directory — do not read, glob, or grep paths outside of it. This includes:
- Parent directories (e.g. \`../\`, or absolute paths that go up from the scan root)
- Sibling directories at the same level or above the scan root
- Any absolute path that does not begin with the scan root

Access to paths outside the scan directory is blocked and will fail — do not attempt it. Use relative paths or glob patterns anchored within the scan root (e.g. \`**/*.docx\`), never absolute paths to other locations on disk.

## Using the directory tree

A pre-generated directory tree is included in the user prompt. It shows all non-hidden files with modification dates, sorted by most recent first. Use it to identify the most important files and directories. Do NOT run broad Glob surveys like \`**/*\` — the tree already provides this. Only use Glob for targeted searches if the tree's depth limit may have excluded relevant subdirectories.

## Token usage

- NEVER read large data files (CSV, JSON data, HDF5, binary files, images, etc.)
- NEVER read large code files in their entirety — just skim the first 20-30 lines for imports and structure
- DO read small text files like README.md, abstracts, paper titles, config files, and requirements.txt
- Use file extensions and filenames to infer content types without reading the files
- Use Grep to search for specific patterns (author names, keywords, abstracts) rather than reading entire files

## File timestamps

The directory tree includes modification dates for each file. Use these to understand what the researcher has been working on recently.
`;

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
  const { claudeBinaryPath, directoryPath, apiKey, baseURL, abortController } =
    ctx;
  return {
    abortController,
    pathToClaudeCodeExecutable: claudeBinaryPath,
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read", "Glob", "Grep"],
    cwd: directoryPath,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,
      ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
    },
    persistSession: false as const,
    thinking: { type: "disabled" as const },
    effort: "low" as const,
    settingSources: [] as any[],
    hooks: createHooks(directoryPath),
    stderr: (data: string) => {
      for (const line of data.split("\n").filter(Boolean)) {
        log.debug(`[DirectoryScanner:stderr] ${line}`);
      }
    },
  };
}

function createHooks(directoryPath: string) {
  const root = path.resolve(directoryPath);

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
      const resolved = path.resolve(root, p);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return deny(`Access outside the scan directory is not allowed: ${p}`);
      }
    }
    return {};
  };

  return {
    PreToolUse: [
      { matcher: "Read|Glob|Grep", hooks: [blockHiddenPaths, blockOutsideCwd] },
    ],
  };
}
