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
    title: { type: "string", description: "Short, enticing notification title that highlights a specific task you can do for the user, e.g. 'I can visualize your RNA-seq results'" },
    body: { type: "string", description: "1-2 sentence description that highlights the most compelling things you found you can help with. Focus on what you can do for the user, not on internal bookkeeping like how many suggestions were added or reordered." },
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
  return `You are a research workspace assistant. Your job is to look at a researcher's files and show them what you can build and do for them — especially things they wouldn't think to ask for.

${FILE_ACCESS_PREAMBLE}

## Suggested tasks guidance

Follow the guidance below closely. It defines what makes a good suggestion, the suggestion types, quality criteria, feasibility requirements, and examples.

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
- What data and research files they have (datasets, papers, experimental results)
- What research domain they're in and what specific problems they're working on
- What research techniques and methods they use (e.g. Western blots, RNA-seq, regression analysis, surveys)
- What repetitive workflows you spot (data formatting, figure generation, similar file processing)
- What computational methods are described in their papers that you could reproduce as interactive tools
- What custom interactive tools you could build for their specific data
- What deep analysis or synthesis work you could do that they wouldn't think to ask for

Create 2-3 suggestions using the \`mcp__suggested-tasks__create_suggestion\` tool. Do not create more than that — an in-depth scan will follow to add and refine suggestions. Make suggestion names specific and enticing (e.g. "Explore your RNA-seq results interactively" not "Data analysis tool"). Work as fast as possible.

## Directory ${multi ? "trees" : "tree"}

All non-hidden files in the workspace, sorted by modification time (most recent first), with dates:

${treeSection}`;
}

function buildInDepthPrompt(directoryPaths: string[]): string {
  const multi = directoryPaths.length > 1;
  const dirDescription = multi
    ? `The researcher's workspace directories are:\n${directoryPaths.map((dp, i) => `${i + 1}. ${dp}`).join("\n")}`
    : `The researcher's workspace directory is: ${directoryPaths[0]}`;

  return `You are performing an in-depth review and curation of the researcher's suggested tasks collection.

${dirDescription}

Use targeted Glob and Grep queries when you need to explore the workspace — avoid broad surveys like \`**/*\`.

## Your process

1. **Review existing suggestions**: Call \`mcp__suggested-tasks__list_suggestions\` to see what's currently suggested. Pay attention to the \`created_at\` timestamps on each suggestion.
2. **Evaluate each suggestion** against the quality criteria and feasibility checklists in the suggested tasks guidance above. Read files in the workspace as needed to verify and improve your understanding.
3. **Improve the collection**:
   - Update suggestions that are too vague or could be more specific using \`mcp__suggested-tasks__update_suggestion\`
   - Delete suggestions that are low-impact, redundant, or less compelling than the others using \`mcp__suggested-tasks__delete_suggestion\` — but never delete suggestions created less than 1 hour ago (check \`created_at\`). Prefer updating over deleting when possible.
   - Create new suggestions if you identify high-impact opportunities not yet covered using \`mcp__suggested-tasks__create_suggestion\`
4. **Order by impact**: Call \`mcp__suggested-tasks__reorder_suggestions\` to put the highest-impact suggestions first. Do not reorder suggestions created less than 1 hour ago — the user may already be looking at them.
5. **Write an enticing notification**: Your response will be captured as structured JSON with \`title\` and \`body\` fields. The notification should catch the user's attention and make them want to check their suggestions. Write a short title that highlights a specific task you can do for the user (e.g. "I can visualize your RNA-seq results"). Write a 1-2 sentence body that highlights the most compelling things you found you can help with. Focus on what you can do for the user — never mention internal bookkeeping like how many suggestions were added, removed, or reordered.

Apply the curation guidance from the suggested tasks skill — evaluate the collection as a cohesive whole and keep it tight.`;
}
