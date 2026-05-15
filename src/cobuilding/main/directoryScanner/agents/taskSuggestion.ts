import { query } from "@anthropic-ai/claude-agent-sdk";
import log from "electron-log";
import { createBriefing } from "../../db/briefingsRepository";
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

  const agentQuery = query({
    prompt: buildPrompt(ctx.directoryPaths, ctx.treeOutputs),
    options: {
      ...buildCommonQueryOptions(ctx),
      model: "claude-sonnet-4-6",
      systemPrompt: buildSystemPrompt(),
      maxTurns: 10,
      maxBudgetUsd: 2,
      outputFormat: {
        type: "json_schema",
        schema: TASK_SUGGESTION_SCHEMA,
      },
    },
  });

  const { suggestions } = await consumeAgentStream<{
    suggestions: SuggestionParsed[];
  }>(agentQuery);

  const seconds = Math.round((Date.now() - startTime) / 1000);
  log.info(
    `[DirectoryScanner:TaskSuggestion] Completed in ${seconds}s (${suggestions.length} suggestions)`,
  );

  createSuggestionBriefings(suggestions, ctx.workspaceId, ctx.reportId);
  return suggestions;
}

function createSuggestionBriefings(
  suggestions: SuggestionParsed[],
  workspaceId: string,
  reportId: string,
): void {
  for (const suggestion of suggestions) {
    if (
      typeof suggestion?.name !== "string" ||
      typeof suggestion?.description !== "string"
    ) {
      continue;
    }
    const whyImSuggestingThis =
      typeof suggestion.why_im_suggesting_this === "string"
        ? suggestion.why_im_suggesting_this
        : null;

    if (suggestion.type === "mini_app") {
      createBriefing({
        workspaceId,
        type: "suggested_tool",
        sourceReportId: reportId,
        whyImSuggestingThis,
        briefingData: {
          name: suggestion.name,
          details_on_what_to_build: suggestion.description,
        },
      });
    } else {
      createBriefing({
        workspaceId,
        type: "suggested_action",
        sourceReportId: reportId,
        whyImSuggestingThis,
        briefingData: {
          title: suggestion.name,
          description: suggestion.description,
          chat_prompt: suggestion.description,
        },
      });
    }
  }
}

const TASK_SUGGESTION_SCHEMA = {
  type: "object" as const,
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short display name for the suggestion.",
          },
          type: {
            type: "string",
            enum: ["one_time_task", "mini_app"],
            description:
              "Whether this is a one-time task or an interactive mini-app to build.",
          },
          why_im_suggesting_this: {
            type: "string",
            description:
              "A 1-2 sentence explanation tying this suggestion to specific files or patterns found in the researcher's directory.",
          },
          description: {
            type: "string",
            description:
              "A clear, actionable description of what to do. Reference specific files or patterns from the scan. 2-4 sentences.",
          },
        },
        required: ["name", "type", "why_im_suggesting_this", "description"],
      },
      description:
        "Suggestions that would significantly expedite the researcher's work.",
    },
  },
  required: ["suggestions"],
};

function buildSystemPrompt(): string {
  return `You are a research directory analyzer. Your job is to quickly scan a researcher's file directory and suggest things you can do for them that would significantly expedite their research.

${SYSTEM_PROMPT_PREAMBLE}

## Output

Produce a JSON report with one field:

**suggestions**: Based on what you learned about the researcher from their folders, suggest things you can do for them that would significantly expedite their research. These can be one-time tasks or building mini-apps. Suggest as many as are genuinely useful — don't hold back.

**One-time tasks** (\`type: "one_time_task"\`): Things the researcher would benefit from but might not think to ask for, or tasks that would take them hours but you can do quickly. Examples:
- Summarizing or synthesizing a body of literature they have collected
- Creating a structured comparison table across multiple papers or datasets
- Extracting and organizing key findings, methods, or statistics from their documents
- Converting or reformatting files (e.g. reformatting references, converting between data formats)
- Drafting sections of documents based on existing notes or data
- Analyzing patterns across their datasets or experimental results

**Mini-apps** (\`type: "mini_app"\`): Interactive tools built as sandboxed React apps with Plotly charts and file I/O through a bridge API. Good for data explorers, chart generators, statistical dashboards, AI-powered text analyzers, and data transformers. Do NOT suggest mini-apps that require direct filesystem writes, real-time monitors, or image editing.

**Prioritize high-impact suggestions.** Think about what would save the researcher the most time or unlock insights they couldn't easily get on their own. Tie every suggestion to specific files or patterns you actually found in their directory.

**Maximize variety across suggestions.** Don't cluster suggestions around one category (e.g. don't suggest three literature reviews). Spread them across different angles:
- **Research technique analysis**: Look at the specific techniques and methods the researcher uses (e.g. Western blots, PCR, RNA-seq, regression analysis, finite element modeling) and suggest technique-specific analysis help you could provide.
- **Repetitive workflow automation**: Identify repetitive work patterns in the researcher's files — data formatting, figure generation, protocol documentation, reference management — and suggest mini-apps that could streamline those workflows.
- **Document review and improvement**: Review drafts, grant proposals, or presentations.
- **Literature synthesis**: Summarize or compare bodies of literature they've collected.
- **Data exploration and visualization**: Build interactive dashboards or analysis tools for their datasets.

**For each suggestion provide four fields:**
- \`name\`: Short display title.
- \`type\`: Either \`"one_time_task"\` or \`"mini_app"\`.
- \`why_im_suggesting_this\`: 1-2 sentences tying the suggestion to specific files or patterns you found in their directory.
- \`description\`: A clear, actionable description of what you would do. Reference specific files or file patterns from the scan. 2-4 sentences — enough to act on without ambiguity.

**Examples** (adapt to what you actually find):
- \`{ name: "Synthesize literature on X", type: "one_time_task", why_im_suggesting_this: "You have 23 PDFs in papers/topic-X/ spanning 2019-2024.", description: "Read all 23 papers in papers/topic-X/, extract key findings and methodologies, and produce a structured literature review organized by theme with a summary table of methods, sample sizes, and main results." }\`
- \`{ name: "Western blot quantification tool", type: "mini_app", why_im_suggesting_this: "Your lab notebook entries and protocols/ folder show you regularly run Western blots and manually quantify band intensities.", description: "Build a mini-app that lets you upload Western blot images, automatically detect and quantify band intensities using densitometry, normalize to loading controls, and export publication-ready bar charts with statistical comparisons." }\`
- \`{ name: "Batch figure formatter", type: "mini_app", why_im_suggesting_this: "You have 40+ figures across 5 manuscript directories, each with inconsistent axis labels, fonts, and color schemes.", description: "Build a mini-app that loads your Plotly/matplotlib figures, lets you set a unified style template (font, colors, axis formatting), previews changes across all figures, and exports publication-ready versions in bulk." }\`
- \`{ name: "Analysis help for your research techniques", type: "one_time_task", why_im_suggesting_this: "Your code and data files show you use several research techniques including RNA-seq, qPCR, and cell viability assays.", description: "For each research technique identified in your workflow, provide a detailed breakdown of the analysis steps I can help with — from raw data processing to statistical testing to figure generation — with specific recommendations tied to your existing scripts and datasets." }\`
- \`{ name: "Review my draft on Y", type: "one_time_task", why_im_suggesting_this: "Your manuscript drafts/paper-Y.docx was recently modified and appears to be a near-complete draft.", description: "Read drafts/paper-Y.docx end-to-end and provide a structured review: assess the argument flow, flag gaps in the literature review, check whether the methods section is reproducible, and suggest specific improvements for clarity and concision." }\``;
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
