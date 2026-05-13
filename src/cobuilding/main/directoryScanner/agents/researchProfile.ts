import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";
import {
  MEMORY_FILE_ABOUT_YOU,
  MEMORY_FILE_WORKING_ON,
} from "../../../shared/paths";
import {
  SYSTEM_PROMPT_PREAMBLE,
  buildCommonQueryOptions,
  consumeAgentStream,
  type ScanContext,
  type ScannerEvent,
} from "../shared";

export interface ResearchProfileResult {
  about_you: string;
  working_on: string;
}

export async function runResearchProfileAgent(
  ctx: ScanContext,
): Promise<ResearchProfileResult> {
  log.info(
    "[DirectoryScanner:ResearchProfile] Starting research profile agent",
  );

  const agentQuery = query({
    prompt: buildPrompt(ctx.directoryPath, ctx.treeOutput),
    options: {
      ...buildCommonQueryOptions(ctx),
      model: "claude-sonnet-4-6",
      systemPrompt: buildSystemPrompt(),
      maxTurns: 10,
      maxBudgetUsd: 2,
      outputFormat: {
        type: "json_schema",
        schema: RESEARCH_PROFILE_SCHEMA,
      },
    },
  });

  const result = await consumeAgentStream<ResearchProfileResult>(
    agentQuery,
    (msg) => forwardProgress(msg, ctx.directoryPath, ctx.onMessage),
  );

  log.info(
    `[DirectoryScanner:ResearchProfile] Completed (about_you: ${result.about_you?.length ?? 0} chars, working_on: ${result.working_on?.length ?? 0} chars)`,
  );
  await writeMemoryFiles(ctx.memoryDir, result);
  return result;
}

const RESEARCH_PROFILE_SCHEMA = {
  type: "object" as const,
  properties: {
    about_you: {
      type: "string",
      description:
        'A concise 2-4 paragraph summary of the researcher written in second person ("You are a computational biologist..."). Cover their field, subfield, methodologies, techniques, and what kind of researcher they are (wet lab, computational, theoretical, clinical). This will be shown directly to the researcher for confirmation.',
    },
    working_on: {
      type: "string",
      description:
        'A 2-4 paragraph summary of what the researcher is currently working on, written in second person ("You have been..."). Describe their active projects, recent focus areas, what stage each is at (data collection, analysis, writing, revision), and what they seem to be in the middle of.',
    },
  },
  required: ["about_you", "working_on"],
};

function buildSystemPrompt(): string {
  return `You are a research directory analyzer. Your job is to quickly scan a researcher's file directory and understand who they are and what they work on.

${SYSTEM_PROMPT_PREAMBLE}

## Progress updates

As you work, emit short progress messages shown to the user while they wait. These MUST be terse — 3-6 words max. No full sentences. Use present participles. Include counts when known.

Good examples:
- "Scanning folders"
- "Reading 52 documents"
- "Indexing 247 papers"
- "Analyzing code projects"
- "Identifying research topics"

Bad examples (too long):
- "Scanning your local folders for research files"
- "Reading through documents and drafts in your workspace"

## Output

Produce a JSON report with two fields:

1. **about_you**: A concise 2-4 paragraph summary of the researcher written in second person ("You are a computational biologist..."). Cover their field, subfield, methodologies, techniques, and what kind of researcher they are (wet lab, computational, theoretical, clinical). The researcher will review and edit this, so make it read naturally.

2. **working_on**: A 2-4 paragraph summary of what the researcher is currently working on, written in second person ("You have been..."). Describe their active projects, recent focus areas, what stage each is at (data collection, analysis, writing, revision), and what they seem to be in the middle of.`;
}

function buildPrompt(directoryPath: string, treeOutput: string): string {
  return `Analyze the research directory to understand who the researcher is and what they are currently working on.

The directory to analyze is the current working directory: ${directoryPath}

Use the directory tree below to guide your analysis. Skip broad Glob surveys and go directly to reading the most important files. Focus on understanding:
- Who the researcher is and what field(s) they work in
- What methodologies and techniques they use
- What projects they have and what stage each is at
- What they have been working on recently

Work as quickly as possible.

## Directory tree

All non-hidden files in the workspace, sorted by modification time (most recent first), with dates:

\`\`\`
${treeOutput}
\`\`\``;
}

function forwardProgress(
  msg: SDKMessage & Record<string, unknown>,
  directoryPath: string,
  onMessage: (event: ScannerEvent) => void,
): void {
  if (msg.type !== "assistant") return;

  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      const firstLine = block.text
        .split("\n")
        .map((l: string) => l.trim())
        .find((l: string) => l.length > 0);
      if (firstLine)
        onMessage({ type: "progress", text: firstLine.slice(0, 120) });
    }
    if (block.type === "tool_use") {
      const input = block.input as Record<string, unknown>;
      if (
        block.name === "Read" &&
        typeof input.file_path === "string" &&
        input.file_path.trim()
      ) {
        onMessage({
          type: "file_activity",
          path: `Read: ${toRelative(input.file_path, directoryPath)}`,
          tool: block.name,
        });
      } else if (
        block.name === "Glob" &&
        typeof input.pattern === "string" &&
        input.pattern.trim()
      ) {
        const rel =
          typeof input.path === "string" && input.path.trim()
            ? toRelative(input.path, directoryPath)
            : "";
        const dir = rel && rel !== "." ? rel + "/" : "";
        onMessage({
          type: "file_activity",
          path: `Glob ${dir}${input.pattern}`,
          tool: block.name,
        });
      } else if (block.name === "Grep") {
        const target =
          typeof input.path === "string" && input.path.trim()
            ? toRelative(input.path, directoryPath)
            : typeof input.pattern === "string" && input.pattern.trim()
              ? input.pattern
              : null;
        if (target)
          onMessage({
            type: "file_activity",
            path: `Grep: ${target}`,
            tool: block.name,
          });
      }
    }
  }
}

function toRelative(filePath: string, directoryPath: string): string {
  const dir = directoryPath.endsWith("/") ? directoryPath : directoryPath + "/";
  if (filePath.startsWith(dir)) return filePath.slice(dir.length);
  if (filePath === directoryPath || filePath === dir.slice(0, -1)) return ".";
  return filePath;
}

async function writeMemoryFiles(
  memoryDir: string,
  result: ResearchProfileResult,
): Promise<void> {
  try {
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, MEMORY_FILE_ABOUT_YOU),
      result.about_you,
    );
    await fs.writeFile(
      path.join(memoryDir, MEMORY_FILE_WORKING_ON),
      result.working_on,
    );
    log.info(`[DirectoryScanner] Wrote memory files to ${memoryDir}`);
  } catch (err) {
    log.error("[DirectoryScanner] Failed to write memory files:", err);
  }
}
