import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";
import log from "electron-log";
import { createSuggestedTasksMcpServer } from "../../mcpServers/suggestedTasksMcpServer";
import {
  SYSTEM_PROMPT_PREAMBLE,
  buildCommonQueryOptions,
  consumeAgentStream,
  formatTreesForPrompt,
  type ScanContext,
  type SuggestionParsed,
  type TreeOutput,
} from "../shared";

export async function runTaskSuggestionAgent(
  ctx: ScanContext,
): Promise<SuggestionParsed[]> {
  const startTime = Date.now();
  log.info("[DirectoryScanner:TaskSuggestion] Starting task suggestion agent");

  let skillContent = "";
  try {
    skillContent = fs.readFileSync(
      path.join(ctx.cwd, ".claude", "skills", "suggested-tasks", "SKILL.md"),
      "utf-8",
    );
  } catch {
    log.warn("[DirectoryScanner:TaskSuggestion] Could not read suggested-tasks SKILL.md");
  }

  const createdSuggestions: SuggestionParsed[] = [];
  const mcpServer = createSuggestedTasksMcpServer({
    workspaceId: ctx.workspaceId,
    sourceReportId: ctx.reportId,
    onBriefingsChanged: () => ctx.onBriefingsChanged(),
    onSuggestionCreated: (s) => createdSuggestions.push(s),
  });

  const commonOptions = buildCommonQueryOptions(ctx);

  const agentQuery = query({
    prompt: buildPrompt(ctx.directoryPaths, ctx.treeOutputs),
    options: {
      ...commonOptions,
      model: "claude-sonnet-4-6",
      systemPrompt: buildSystemPrompt(skillContent),
      maxTurns: 10,
      maxBudgetUsd: 2,
      tools: [...commonOptions.tools, "mcp__suggested-tasks__create_suggestion"],
      allowedTools: [...commonOptions.allowedTools, "mcp__suggested-tasks__create_suggestion"],
      mcpServers: { "suggested-tasks": mcpServer },
    },
  });

  await consumeAgentStream(agentQuery);

  const seconds = Math.round((Date.now() - startTime) / 1000);
  log.info(
    `[DirectoryScanner:TaskSuggestion] Completed in ${seconds}s (${createdSuggestions.length} suggestions)`,
  );

  return createdSuggestions;
}

function buildSystemPrompt(skillContent: string): string {
  return `You are a research directory analyzer. Your job is to quickly scan a researcher's file directory and suggest things you can do for them that would significantly expedite their research.

${SYSTEM_PROMPT_PREAMBLE}

## Suggested tasks skill

Follow the guidance below closely. It defines what makes a good suggestion, the suggestion types, quality criteria, and examples.

${skillContent}

## Output

For each suggestion, call the \`mcp__suggested-tasks__create_suggestion\` tool. Call it once per suggestion. Suggest as many as are genuinely useful — don't hold back. When you are done creating suggestions, respond with a brief summary of what you suggested.`;
}

function buildPrompt(directoryPaths: string[], treeOutputs: TreeOutput[]): string {
  const multi = directoryPaths.length > 1;
  const dirDescription = multi
    ? `The directories to analyze are:\n${directoryPaths.map((dp, i) => `${i + 1}. ${dp}`).join("\n")}`
    : `The directory to analyze is: ${directoryPaths[0]}`;

  const treeSection = multi
    ? formatTreesForPrompt(treeOutputs)
    : `\`\`\`\n${treeOutputs[0].tree}\n\`\`\``;

  return `Analyze the research ${multi ? "directories" : "directory"} and suggest things you could do for this researcher that would significantly expedite their research. These can be one-time tasks or interactive mini-apps.

${dirDescription}

Use the directory ${multi ? "trees" : "tree"} below to guide your analysis. Skip broad Glob surveys and go directly to reading the most important files. Focus on understanding:
- What projects the researcher has and what each contains
- What tools, languages, and frameworks they use
- What research techniques and methods they employ
- What repetitive workflows could be automated
- What things you could build or do that would save them the most time

Work as quickly as possible.

## Directory ${multi ? "trees" : "tree"}

All non-hidden files in the workspace, sorted by modification time (most recent first), with dates:

${treeSection}`;
}
