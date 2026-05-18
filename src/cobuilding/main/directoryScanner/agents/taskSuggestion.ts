import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";
import { createSuggestedTasksMcpServer } from "../../mcpServers/suggestedTasksMcpServer";
import {
  FILE_ACCESS_PREAMBLE,
  SCAN_SPEED_PREAMBLE,
  buildCommonQueryOptions,
  consumeAgentStream,
  formatTreesForPrompt,
  type ScanContext,
  type TreeOutput,
} from "../shared";

export async function runQuickTaskSuggestionAgent(ctx: ScanContext): Promise<void> {
  await runTaskSuggestionAgent<void>(ctx, {
    label: "Quick",
    mcpMode: "create-only",
    prompt: buildQuickPrompt(ctx.directoryPaths, ctx.treeOutputs),
    tools: ["mcp__suggested-tasks__create_suggestion"],
    maxTurns: 10,
    maxBudgetUsd: 2,
  });
}

export async function runInDepthTaskSuggestionAgent(ctx: ScanContext): Promise<NotificationOutput> {
  return runTaskSuggestionAgent<NotificationOutput>(ctx, {
    label: "InDepth",
    mcpMode: "full",
    prompt: buildInDepthPrompt(ctx.directoryPaths),
    tools: ALL_SUGGESTED_TASKS_TOOLS,
    maxTurns: 25,
    maxBudgetUsd: 5,
    effort: "medium",
    thinking: { type: "adaptive" },
    outputFormat: { type: "json_schema", schema: NOTIFICATION_OUTPUT_SCHEMA },
  });
}

const ALL_SUGGESTED_TASKS_TOOLS = [
  "mcp__suggested-tasks__create_suggestion",
  "mcp__suggested-tasks__list_suggestions",
  "mcp__suggested-tasks__update_suggestion",
  "mcp__suggested-tasks__reorder_suggestions",
  "mcp__suggested-tasks__delete_suggestion",
];

interface NotificationOutput {
  made_changes: boolean;
  title: string;
  body: string;
}

const NOTIFICATION_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    made_changes: { type: "boolean", description: "Whether any suggestions were created, updated, deleted, or reordered" },
    title: { type: "string", description: "Short notification title, e.g. 'Suggestions updated'" },
    body: { type: "string", description: "1-2 sentence summary of changes made" },
  },
  required: ["made_changes", "title", "body"],
};

interface AgentConfig {
  label: string;
  mcpMode: "create-only" | "full";
  prompt: string;
  tools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  effort?: "low" | "medium" | "high";
  thinking?: { type: "disabled" | "adaptive" };
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
}

async function runTaskSuggestionAgent<T>(ctx: ScanContext, config: AgentConfig): Promise<T> {
  const startTime = Date.now();
  log.info(`[DirectoryScanner:TaskSuggestion:${config.label}] Starting`);

  let skillContent = "";
  try {
    skillContent = await fs.readFile(
      path.join(ctx.cwd, ".claude", "skills", "suggested-tasks", "SKILL.md"),
      "utf-8",
    );
  } catch {
    log.warn("[DirectoryScanner:TaskSuggestion] Could not read suggested-tasks SKILL.md");
  }

  const mcpServer = createSuggestedTasksMcpServer(
    {
      workspaceId: ctx.workspaceId,
      sourceReportId: ctx.reportId,
    },
    config.mcpMode,
  );

  const commonOptions = buildCommonQueryOptions(ctx);

  const agentQuery = query({
    prompt: config.prompt,
    options: {
      ...commonOptions,
      model: "claude-sonnet-4-6",
      systemPrompt: buildSharedSystemPrompt(skillContent),
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      ...(config.effort ? { effort: config.effort } : {}),
      ...(config.thinking ? { thinking: config.thinking } : {}),
      ...(config.outputFormat ? { outputFormat: config.outputFormat } : {}),
      tools: [...commonOptions.tools, ...config.tools],
      allowedTools: [...commonOptions.allowedTools, ...config.tools],
      mcpServers: { "suggested-tasks": mcpServer },
    },
  });

  const result = await consumeAgentStream<T>(agentQuery);

  const seconds = Math.round((Date.now() - startTime) / 1000);
  log.info(`[DirectoryScanner:TaskSuggestion:${config.label}] Completed in ${seconds}s`);

  return result;
}

function buildSharedSystemPrompt(skillContent: string): string {
  return `You are a research workspace assistant. Your job is to identify and suggest things you can do for a researcher that would significantly expedite their research.

${FILE_ACCESS_PREAMBLE}

## Suggested tasks guidance

Follow the guidance below closely. It defines what makes a good suggestion, the suggestion types, quality criteria, and examples.

${skillContent}`;
}

function buildQuickPrompt(directoryPaths: string[], treeOutputs: TreeOutput[]): string {
  const multi = directoryPaths.length > 1;
  const dirDescription = multi
    ? `The directories to analyze are:\n${directoryPaths.map((dp, i) => `${i + 1}. ${dp}`).join("\n")}`
    : `The directory to analyze is: ${directoryPaths[0]}`;

  const treeSection = multi
    ? formatTreesForPrompt(treeOutputs)
    : `\`\`\`\n${treeOutputs[0].tree}\n\`\`\``;

  return `You are performing a QUICK task suggestion scan. A user is waiting — speed is your #1 priority.

${SCAN_SPEED_PREAMBLE}

${dirDescription}

Use the directory ${multi ? "trees" : "tree"} below to guide your analysis. Skip broad Glob surveys and go directly to reading the most important files. Focus on understanding:
- What projects the researcher has and what each contains
- What tools, languages, and frameworks they use
- What research techniques and methods they employ
- What repetitive workflows could be automated
- What things you could build or do that would save them the most time

Create 2 high-impact task suggestions using the \`mcp__suggested-tasks__create_suggestion\` tool — ideally one \`one_time_task\` and one \`mini_app\`. Focus on the most impactful things you can identify quickly. Work as fast as possible.

## Directory ${multi ? "trees" : "tree"}

All non-hidden files in the workspace, sorted by modification time (most recent first), with dates:

${treeSection}`;
}

function buildInDepthPrompt(directoryPaths: string[]): string {
  const multi = directoryPaths.length > 1;
  const dirDescription = multi
    ? `The researcher's workspace directories are:\n${directoryPaths.map((dp, i) => `${i + 1}. ${dp}`).join("\n")}`
    : `The researcher's workspace directory is: ${directoryPaths[0]}`;

  return `You are performing an in-depth review and curation of the researcher's suggested tasks collection. Your goal is to ensure the suggestions shown on their Home tab are the most impactful things you can offer.

${dirDescription}

Use targeted Glob and Grep queries when you need to explore the workspace — avoid broad surveys like \`**/*\`.

## Your process

1. **Review existing suggestions**: Call \`mcp__suggested-tasks__list_suggestions\` to see what's currently suggested. Pay attention to the \`created_at\` timestamps on each suggestion.
2. **Evaluate each suggestion**: For each existing suggestion, assess whether it is specific enough, tied to real files in the workspace, and genuinely high-impact. Read files in the workspace as needed to verify and improve your understanding.
3. **Improve the collection**:
   - Update suggestions that are too vague or could be more specific using \`mcp__suggested-tasks__update_suggestion\`
   - Delete suggestions that are low-impact or redundant using \`mcp__suggested-tasks__delete_suggestion\` — but avoid deleting recently created suggestions (check \`created_at\`). Prefer updating over deleting when a suggestion was just created.
   - Create new suggestions if you identify high-impact opportunities not yet covered using \`mcp__suggested-tasks__create_suggestion\`
   - Aim for variety across categories (literature synthesis, technique analysis, workflow automation, document review, data exploration)
4. **Order by impact**: Call \`mcp__suggested-tasks__reorder_suggestions\` to put the highest-impact suggestions first.
5. **Summarize your changes**: Your response will be captured as structured JSON with \`title\` and \`body\` fields. Provide a short title (e.g. "Suggestions updated") and a 1-2 sentence body summarizing what you changed (e.g. how many suggestions you added, updated, or removed).

Focus on quality over quantity. A curated list of 4-6 excellent, specific suggestions is better than 10 mediocre ones.`;
}
