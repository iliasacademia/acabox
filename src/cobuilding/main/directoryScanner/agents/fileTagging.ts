import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import log from "electron-log";
import Anthropic from "@anthropic-ai/sdk";
import { upsertScannedFiles } from "../../db/scannedFilesRepository";
import { createBriefing } from "../../db/briefingsRepository";
import { extractText } from "../../fileMonitor/textExtractor";
import {
  SYSTEM_PROMPT_PREAMBLE,
  buildCommonQueryOptions,
  consumeAgentStream,
  type ScanContext,
  type TaggedFileParsed,
} from "../shared";

interface ManuscriptCandidate {
  filePath: string;
  scannerDescription: string;
}

export interface FileTaggingResult {
  taggedFiles: TaggedFileParsed[];
}

export async function runFileTaggingAgent(
  ctx: ScanContext,
): Promise<FileTaggingResult> {
  const startTime = Date.now();
  log.info("[DirectoryScanner:FileTagging] Starting file tagging agent");

  const agentQuery = query({
    prompt: buildPrompt(ctx.directoryPath, ctx.treeOutput),
    options: {
      ...buildCommonQueryOptions(ctx),
      model: "claude-haiku-4-5-20251001",
      systemPrompt: buildSystemPrompt(),
      maxTurns: 8,
      maxBudgetUsd: 1,
      outputFormat: {
        type: "json_schema",
        schema: FILE_TAGGING_SCHEMA,
      },
    },
  });

  const { tagged_files } = await consumeAgentStream<{
    tagged_files: TaggedFileParsed[];
  }>(agentQuery);

  const seconds = Math.round((Date.now() - startTime) / 1000);
  log.info(
    `[DirectoryScanner:FileTagging] Completed in ${seconds}s (${tagged_files.length} tagged files)`,
  );

  persistTaggedFiles(tagged_files, ctx.workspaceId, ctx.reportId);
  await enrichManuscripts(extractManuscriptCandidates(tagged_files), ctx);
  return { taggedFiles: tagged_files };
}

function persistTaggedFiles(
  taggedFiles: TaggedFileParsed[],
  workspaceId: string,
  reportId: string,
): void {
  try {
    const normalised = taggedFiles
      .map((f) => ({
        file_path: ((f as any).file_path ?? (f as any).path) as string,
        file_name: ((f as any).file_name ?? (f as any).filename) as string,
        file_type: ((f as any).file_type ?? (f as any).type) as string,
      }))
      .filter((f) => !f.file_name?.startsWith("~$"));
    upsertScannedFiles(workspaceId, reportId, normalised);
  } catch (err) {
    log.error("[DirectoryScanner] Failed to persist tagged files:", err);
  }
}

function extractManuscriptCandidates(
  taggedFiles: TaggedFileParsed[],
): ManuscriptCandidate[] {
  return taggedFiles
    .filter((f) => {
      const p = getFilePath(f);
      if (!p || !p.toLowerCase().endsWith(".docx")) return false;
      const name = p.split("/").pop() ?? "";
      if (name.startsWith("~$")) return false;
      const fileType = (
        typeof f.file_type === "string"
          ? f.file_type
          : typeof (f as any).type === "string"
            ? (f as any).type
            : ""
      ).toLowerCase();
      return fileType === "manuscript";
    })
    .map((f) => ({ filePath: getFilePath(f)!, scannerDescription: "" }));
}

function getFilePath(f: {
  file_path?: unknown;
  path?: unknown;
}): string | undefined {
  if (typeof f.file_path === "string") return f.file_path;
  if (typeof f.path === "string") return f.path;
  return undefined;
}

const FILE_TAGGING_SCHEMA = {
  type: "object" as const,
  properties: {
    tagged_files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Relative path to the file from the workspace root.",
          },
          file_name: {
            type: "string",
            description: "The filename only (basename, including extension).",
          },
          file_type: {
            type: "string",
            enum: ["manuscript", "grant", "presentation"],
            description:
              "manuscript = academic paper, thesis, chapter, or dissertation (.tex, .docx, .md). grant = grant proposal, funding application, NIH/NSF/R01 submission. presentation = .pptx, .key, talks, slides, lab-meeting files.",
          },
        },
        required: ["file_path", "file_name", "file_type"],
      },
      description:
        "All manuscript, grant, and presentation files found in the directory.",
    },
  },
  required: ["tagged_files"],
};

function buildSystemPrompt(): string {
  return `You are a research directory file tagger. Your job is to quickly scan a researcher's file directory and identify all manuscripts, grants, and presentations.

${SYSTEM_PROMPT_PREAMBLE}

## Output

Produce a JSON report with one field:

**tagged_files**: A comprehensive list of ALL manuscript, grant, and presentation files you find. For each file, record the relative path, the filename, and its type:
- \`manuscript\`: .tex, .docx, .md files that are academic papers, theses, chapters, or dissertations
- \`grant\`: files or directories whose names or contents indicate grant proposals, funding applications, or NIH/NSF/R01 submissions
- \`presentation\`: .pptx or .key files, or directories with names like "talks", "slides", "lab-meeting"

Cast a wide net — include every file you are reasonably confident belongs to one of these categories. This list populates file pickers in writing tools, so completeness matters. Do NOT include code, data, or general documents.

You can largely identify files from the directory tree — use file extensions and directory names. Only use Read/Grep on ambiguous files where you need to check content to determine the type.`;
}

function buildPrompt(directoryPath: string, treeOutput: string): string {
  return `Identify and tag all manuscript, grant, and presentation files in this research directory.

The directory to analyze is the current working directory: ${directoryPath}

Use the directory tree below to identify files. You can determine most file types from extensions and directory names alone. Only read files when you need to disambiguate.

Work as quickly as possible.

## Directory tree

All non-hidden files in the workspace, sorted by modification time (most recent first), with dates:

\`\`\`
${treeOutput}
\`\`\``;
}

const WRITING_AGENT_KICKOFF_PROMPT =
  "Review this manuscript. Read the document, assess its current state, and provide a structured peer review.";

async function enrichManuscripts(
  manuscripts: ManuscriptCandidate[],
  ctx: ScanContext,
): Promise<void> {
  if (manuscripts.length === 0) return;

  const client = new Anthropic({ apiKey: ctx.apiKey, baseURL: ctx.baseURL });

  for (const { filePath, scannerDescription } of manuscripts) {
    try {
      const absolutePath = path.join(ctx.directoryPath, filePath);
      const fullText = await extractText(absolutePath);
      const excerpt = fullText ? fullText.slice(0, 2000) : "";

      if (!excerpt) {
        log.warn(
          `[ManuscriptEnrichment] Could not extract text from ${filePath}, creating with defaults`,
        );
        createBriefing({
          workspaceId: ctx.workspaceId,
          type: "writing_agent",
          sourceReportId: ctx.reportId,
          whyImSuggestingThis:
            scannerDescription ||
            "I can review the introduction of this manuscript and suggest edits.",
          briefingData: {
            file_path: filePath,
            description: scannerDescription,
            chat_prompt: WRITING_AGENT_KICKOFF_PROMPT,
          },
        });
        continue;
      }

      const fileName = filePath.split("/").pop() ?? filePath;
      const message = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: `You are generating a briefing card for a writing assistant that reviews the introduction section of manuscripts. Given this manuscript excerpt, return JSON with:
- "title": A short card title (5-10 words) that references the manuscript's topic and focuses on the introduction, e.g. "Review the intro of your cortisol paper" or "Strengthen the introduction of your HIF-2α draft". Start with "Review" or "Strengthen".
- "description": One sentence describing what the introduction review will focus on, specific to this manuscript's content. E.g. "I'll review how your introduction motivates the RPTEC timecourse study and propose 2–3 edits to strengthen it."

Filename: ${fileName}

Manuscript excerpt:
${excerpt}

Output JSON only. No prose, no code fences.`,
          },
        ],
      });

      const block = message.content[0] as { type: string; text?: string };
      const text =
        block && block.type === "text" && block.text ? block.text : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      let title = "Review your manuscript introduction";
      let description = scannerDescription;

      if (jsonMatch) {
        try {
          const generated = JSON.parse(jsonMatch[0]) as {
            title?: unknown;
            description?: unknown;
          };
          if (typeof generated.title === "string" && generated.title.trim()) {
            title = generated.title.trim();
          }
          if (
            typeof generated.description === "string" &&
            generated.description.trim()
          ) {
            description = generated.description.trim();
          }
        } catch {
          log.warn(
            `[ManuscriptEnrichment] Failed to parse Haiku JSON for ${filePath}`,
          );
        }
      }

      log.info(`[ManuscriptEnrichment] ${filePath} → "${title}"`);
      createBriefing({
        workspaceId: ctx.workspaceId,
        type: "writing_agent",
        sourceReportId: ctx.reportId,
        whyImSuggestingThis:
          description ||
          "I can review the introduction of this manuscript and suggest edits.",
        briefingData: {
          file_path: filePath,
          title,
          description,
          chat_prompt: WRITING_AGENT_KICKOFF_PROMPT,
        },
      });
    } catch (err) {
      log.error(`[ManuscriptEnrichment] Failed to enrich ${filePath}:`, err);
      createBriefing({
        workspaceId: ctx.workspaceId,
        type: "writing_agent",
        sourceReportId: ctx.reportId,
        whyImSuggestingThis:
          scannerDescription ||
          "I can review the introduction of this manuscript and suggest edits.",
        briefingData: {
          file_path: filePath,
          description: scannerDescription,
          chat_prompt: WRITING_AGENT_KICKOFF_PROMPT,
        },
      });
    }
  }
}
