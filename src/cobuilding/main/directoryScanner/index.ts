import { query, type SDKMessage, type HookCallback, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import * as path from 'path';
import log from 'electron-log';
import Anthropic from '@anthropic-ai/sdk';
import { resolveClaudeBinary } from '../sdkBinarySetup';
import { createReport, updateReportStatus } from '../db/reportRepository';
import { createBriefing } from '../db/briefingsRepository';
import { upsertScannedFiles } from '../db/scannedFilesRepository';
import { extractText } from '../fileMonitor/textExtractor';
import { buildScannerSystemPrompt, buildScannerPrompt } from './systemPrompt';
import { REPORT_JSON_SCHEMA } from './reportSchema';

const DIRECTORY_ORGANIZATION_PROMPT = `Please help me organize my research directory. First, inspect the workspace and understand the current file structure, research projects, documents, data, scripts, outputs, and any existing naming conventions. Then recommend an effective organization plan for the directory.

YOU MUST ALWAYS present me with a clear plan before proceeding to take any actions or make any file modifications. Do not move, rename, delete, rewrite, or create files until I explicitly approve the plan.`;

interface SuggestionParsed {
  name?: unknown;
  type?: unknown;
  why_im_suggesting_this?: unknown;
  description?: unknown;
}

interface WorkingOnFileParsed {
  file_path?: unknown;
  path?: unknown;
  description?: unknown;
}

interface TaggedFileParsed {
  file_path?: unknown;
  path?: unknown;
  file_name?: unknown;
  file_type?: unknown;
}

function getFilePath(f: { file_path?: unknown; path?: unknown }): string | undefined {
  if (typeof f.file_path === 'string') return f.file_path;
  if (typeof f.path === 'string') return f.path;
  return undefined;
}

const WRITING_AGENT_KICKOFF_PROMPT = '/academic-writing-agent\n\nPlease act as a peer reviewer for this manuscript. Read it end to end and flag concerns a reviewer would raise — about the argument, the evidence, the methodology, the framing, and the structure. Be specific and constructive. Suggest edits based on your feedback.';

interface ManuscriptCandidate {
  filePath: string;
  scannerDescription: string;
}

function createBriefingsFromScan(
  workspaceId: string,
  reportId: string,
  resultText: string,
  ctx: {
    onBriefingsChanged?: () => void;
  },
): ManuscriptCandidate[] {
  // Always create the directory-organization action briefing.
  createBriefing({
    workspaceId,
    type: 'suggested_action',
    sourceReportId: reportId,
    whyImSuggestingThis:
      'A well-organized workspace makes it easier to find files and helps me give better recommendations.',
    briefingData: {
      title: 'Organize your research directory',
      description:
        'I will figure out an effective way to organize the files in your workspace.',
      chat_prompt: DIRECTORY_ORGANIZATION_PROMPT,
    },
  });

  let parsed: {
    suggestions?: unknown;
    what_youre_working_on?: unknown;
    tagged_files?: unknown;
  };
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return [];
  }

  const workingOn = Array.isArray(parsed.what_youre_working_on)
    ? (parsed.what_youre_working_on as WorkingOnFileParsed[])
    : [];
  const taggedFiles = Array.isArray(parsed.tagged_files)
    ? (parsed.tagged_files as TaggedFileParsed[])
    : [];

  const workingOnByPath = new Map<string, string>();
  for (const f of workingOn) {
    const p = getFilePath(f);
    if (p && typeof f.description === 'string') workingOnByPath.set(p, f.description);
  }

  // Collect manuscript-type docx files for peer-review enrichment.
  const manuscriptDocxFiles = taggedFiles.filter((f) => {
    const p = getFilePath(f);
    if (!p || !p.toLowerCase().endsWith('.docx')) return false;
    const name = p.split('/').pop() ?? '';
    if (name.startsWith('~$')) return false;
    const fileType = (typeof f.file_type === 'string' ? f.file_type : typeof (f as any).type === 'string' ? (f as any).type : '').toLowerCase();
    return fileType === 'manuscript';
  });

  // Create briefings from scanner suggestions (one-time tasks and mini-apps).
  const suggestions = Array.isArray(parsed.suggestions)
    ? (parsed.suggestions as SuggestionParsed[])
    : [];

  for (const suggestion of suggestions) {
    if (typeof suggestion?.name !== 'string' || typeof suggestion?.description !== 'string') {
      continue;
    }
    const whyImSuggestingThis =
      typeof suggestion.why_im_suggesting_this === 'string'
        ? suggestion.why_im_suggesting_this
        : null;

    if (suggestion.type === 'mini_app') {
      createBriefing({
        workspaceId,
        type: 'suggested_tool',
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
        type: 'suggested_action',
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

  // Hardcoded demo suggestion: if the scanner found this specific western blot
  // TIF file, suggest building an annotation tool for western blot images.
  if (resultText.includes('western_blot-test-20260507145157.tif')) {
    createBriefing({
      workspaceId,
      type: 'suggested_tool',
      sourceReportId: reportId,
      whyImSuggestingThis:
        'I found a western blot image in your workspace. An annotation tool could help you label bands, add molecular weight markers, and create publication-ready figures.',
      briefingData: {
        name: 'Western Blot Annotation Tool',
        details_on_what_to_build:
          'Build an interactive tool that helps create annotated western blot images. The tool should allow the user to upload western blot TIF images, label individual bands, add molecular weight markers, draw lane boundaries, and export publication-ready annotated figures with clean labeling.',
      },
    });
  }

  ctx.onBriefingsChanged?.();

  // Return manuscript candidates — writing_agent briefings are created after
  // LLM enrichment generates contextual titles and descriptions.
  return manuscriptDocxFiles.map((f) => {
    const filePath = getFilePath(f)!;
    return { filePath, scannerDescription: workingOnByPath.get(filePath) ?? '' };
  });
}

/**
 * Read manuscript content and call Haiku to generate a contextual title and
 * description for the peer-review briefing card. Creates the writing_agent
 * briefing with LLM-generated content. Runs during onboarding scan so the
 * card is ready when the user reaches the home page.
 */
async function enrichAndCreateManuscriptBriefings(
  manuscripts: ManuscriptCandidate[],
  workspaceId: string,
  reportId: string,
  directoryPath: string,
  apiKey: string,
  baseURL?: string,
): Promise<void> {
  if (manuscripts.length === 0) return;

  const client = new Anthropic({ apiKey, baseURL });

  for (const { filePath, scannerDescription } of manuscripts) {
    try {
      const absolutePath = path.join(directoryPath, filePath);
      const fullText = await extractText(absolutePath);
      const excerpt = fullText ? fullText.slice(0, 2000) : '';

      if (!excerpt) {
        log.warn(`[ManuscriptEnrichment] Could not extract text from ${filePath}, creating with defaults`);
        createBriefing({
          workspaceId,
          type: 'writing_agent',
          sourceReportId: reportId,
          whyImSuggestingThis: scannerDescription || 'I can peer-review this manuscript and suggest edits.',
          briefingData: {
            file_path: filePath,
            description: scannerDescription,
            chat_prompt: WRITING_AGENT_KICKOFF_PROMPT,
          },
        });
        continue;
      }

      const fileName = filePath.split('/').pop() ?? filePath;
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are generating a briefing card for a peer-review assistant. Given this manuscript excerpt, return JSON with:
- "title": A short card title (5-10 words) that references the manuscript's topic, e.g. "Review your cortisol signaling paper" or "Peer review the HIF-2α analysis". Start with "Review" or "Peer review".
- "description": One sentence describing what the review will focus on, specific to this manuscript's content. E.g. "I'll check the experimental design of your RPTEC timecourse and flag gaps in the methodology."

Filename: ${fileName}

Manuscript excerpt:
${excerpt}

Output JSON only. No prose, no code fences.`,
        }],
      });

      const block = message.content[0] as { type: string; text?: string };
      const text = (block && block.type === 'text' && block.text) ? block.text : '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      let title = 'Peer review your manuscript';
      let description = scannerDescription;

      if (jsonMatch) {
        try {
          const generated = JSON.parse(jsonMatch[0]) as { title?: unknown; description?: unknown };
          if (typeof generated.title === 'string' && generated.title.trim()) {
            title = generated.title.trim();
          }
          if (typeof generated.description === 'string' && generated.description.trim()) {
            description = generated.description.trim();
          }
        } catch {
          log.warn(`[ManuscriptEnrichment] Failed to parse Haiku JSON for ${filePath}`);
        }
      }

      log.info(`[ManuscriptEnrichment] ${filePath} → "${title}"`);
      createBriefing({
        workspaceId,
        type: 'writing_agent',
        sourceReportId: reportId,
        whyImSuggestingThis: description || 'I can peer-review this manuscript and suggest edits.',
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
        workspaceId,
        type: 'writing_agent',
        sourceReportId: reportId,
        whyImSuggestingThis: scannerDescription || 'I can peer-review this manuscript and suggest edits.',
        briefingData: {
          file_path: filePath,
          description: scannerDescription,
          chat_prompt: WRITING_AGENT_KICKOFF_PROMPT,
        },
      });
    }
  }
}

export type ScannerEvent =
  | { type: 'progress'; text: string }
  | { type: 'file_activity'; path: string; tool: string }
  | { type: 'complete'; reportId: string; reportData: string }
  | { type: 'error'; error: string };

export interface ScanParams {
  workspaceId: string;
  directoryPath: string;
  apiKey: string;
  /** Optional Anthropic base URL for the workspace's credentials. */
  baseURL?: string;
  onMessage?: (event: ScannerEvent) => void;
  /**
   * Fires whenever a briefing is created or updated by the scan flow — both
   * the synchronous creates from `createBriefingsFromScan` and the async
   * manuscript-analysis enrichment.
   */
  onBriefingsChanged?: () => void;
}

/** Strip a workspace-absolute path down to a workspace-relative path. */
function toRelative(filePath: string, directoryPath: string): string {
  const dir = directoryPath.endsWith('/') ? directoryPath : directoryPath + '/';
  if (filePath.startsWith(dir)) {
    return filePath.slice(dir.length);
  }
  // Handle exact match (path IS the directory)
  if (filePath === directoryPath || filePath === dir.slice(0, -1)) {
    return '.';
  }
  return filePath;
}

/** Replace all occurrences of the workspace directory prefix in a string. */
function stripAbsolutePaths(text: string, directoryPath: string): string {
  const dir = directoryPath.endsWith('/') ? directoryPath : directoryPath + '/';
  return text.split(dir).join('').split(directoryPath).join('');
}

/** Extract file paths from tool_use content blocks in an assistant message. */
function extractFileActivities(
  msg: SDKMessage & Record<string, unknown>,
  directoryPath: string,
): Array<{ path: string; tool: string }> {
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return [];

  const activities: Array<{ path: string; tool: string }> = [];

  for (const block of content) {
    if (block.type !== 'tool_use') continue;

    const tool: string = block.name;
    const input = block.input as Record<string, unknown>;

    if (tool === 'Read' && typeof input.file_path === 'string' && input.file_path.trim()) {
      activities.push({ path: `Read: ${toRelative(input.file_path, directoryPath)}`, tool });
    } else if (tool === 'Glob' && typeof input.pattern === 'string' && input.pattern.trim()) {
      const rel = typeof input.path === 'string' && input.path.trim()
        ? toRelative(input.path, directoryPath)
        : '';
      const dir = rel && rel !== '.' ? rel + '/' : '';
      activities.push({ path: `Glob ${dir}${input.pattern}`, tool });
    } else if (tool === 'Grep') {
      const target = typeof input.path === 'string' && input.path.trim()
        ? toRelative(input.path, directoryPath)
        : typeof input.pattern === 'string' && input.pattern.trim()
          ? input.pattern
          : null;
      if (target) activities.push({ path: `Grep: ${target}`, tool });
    }
  }

  return activities;
}

/** Extract human-readable progress text from an SDK assistant message. */
function extractProgressText(msg: SDKMessage & Record<string, unknown>): string | null {
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      // Take the first non-empty line — agent progress updates are brief
      const firstLine = block.text.split('\n').map((l: string) => l.trim()).find((l: string) => l.length > 0);
      if (firstLine) return firstLine.slice(0, 120);
    }
  }
  return null;
}

/** Returns true if a file path contains a hidden segment (dot-prefixed). */
function hasHiddenSegment(filePath: string): boolean {
  return filePath.split('/').some((seg) => seg.startsWith('.') && seg.length > 1);
}

/** PreToolUse hook that blocks Read/Glob/Grep from accessing hidden files or directories. */
const blockHiddenPaths: HookCallback = async (input) => {
  const preInput = input as PreToolUseHookInput;
  const toolInput = preInput.tool_input as Record<string, unknown>;

  const pathsToCheck: string[] = [];

  if (typeof toolInput.file_path === 'string') pathsToCheck.push(toolInput.file_path);
  if (typeof toolInput.path === 'string') pathsToCheck.push(toolInput.path);
  if (typeof toolInput.pattern === 'string') pathsToCheck.push(toolInput.pattern);

  for (const p of pathsToCheck) {
    if (hasHiddenSegment(p)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: `Access to hidden paths is not allowed: ${p}`,
        },
      };
    }
  }

  return {};
};

export async function scanWorkspaceDirectory(params: ScanParams): Promise<void> {
  const { workspaceId, directoryPath, apiKey, baseURL, onMessage } = params;
  const reportId = randomUUID();

  log.info(`[DirectoryScanner] Starting scan for workspace ${workspaceId} at ${directoryPath}`);

  const claudeBinaryPath = resolveClaudeBinary();
  if (!claudeBinaryPath) {
    log.error('[DirectoryScanner] Claude binary not found — skipping scan');
    onMessage?.({ type: 'error', error: 'Claude binary not found' });
    return;
  }

  createReport(reportId, workspaceId, 'directory_scan');
  updateReportStatus(reportId, 'running');

  const abortController = new AbortController();

  try {
    const scanQuery = query({
      prompt: buildScannerPrompt(directoryPath),
      options: {
        abortController,
        pathToClaudeCodeExecutable: claudeBinaryPath,
        model: 'claude-sonnet-4-6',
        systemPrompt: buildScannerSystemPrompt(),
        tools: ['Read', 'Glob', 'Grep', 'Agent'],
        allowedTools: ['Read', 'Glob', 'Grep', 'Agent'],
        cwd: directoryPath,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: apiKey,
          ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
        },
        persistSession: false,
        thinking: { type: 'disabled' },
        effort: 'low',
        maxTurns: 30,
        maxBudgetUsd: 5,
        outputFormat: {
          type: 'json_schema',
          schema: REPORT_JSON_SCHEMA,
        },
        hooks: {
          PreToolUse: [{ matcher: 'Read|Glob|Grep', hooks: [blockHiddenPaths] }],
        },
        settingSources: [],
        stderr: (data: string) => {
          for (const line of data.split('\n').filter(Boolean)) {
            log.debug(`[DirectoryScanner:stderr] ${line}`);
          }
        },
      },
    });

    for await (const message of scanQuery) {
      const msg = message as SDKMessage & Record<string, unknown>;

      // Forward progress events to the renderer
      if (onMessage) {
        if (msg.type === 'assistant') {
          const text = extractProgressText(msg);
          if (text) onMessage({ type: 'progress', text });

          // Extract file paths from tool_use blocks
          const activities = extractFileActivities(msg, directoryPath);
          for (const activity of activities) {
            onMessage({ type: 'file_activity', path: activity.path, tool: activity.tool });
          }
        } else if (msg.type === 'tool_use_summary') {
          const summary = (msg as any).summary;
          if (typeof summary === 'string' && summary.trim().length > 0) {
            onMessage({ type: 'progress', text: summary });
            const relativeSummary = stripAbsolutePaths(summary, directoryPath).trim();
            if (relativeSummary.length > 0) {
              onMessage({ type: 'file_activity', path: relativeSummary.slice(0, 120), tool: 'summary' });
            }
          }
        } else if (
          msg.type === 'system' &&
          (msg as any).subtype === 'task_started' &&
          typeof (msg as any).description === 'string'
        ) {
          onMessage({ type: 'progress', text: (msg as any).description });
        }
      }

      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          // Prefer structured_output (parsed JSON from json_schema output format),
          // fall back to result (raw text)
          const structured = (msg as any).structured_output;
          const resultText = structured
            ? JSON.stringify(structured)
            : (typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result));
          log.info(`[DirectoryScanner] Scan completed for workspace ${workspaceId} (has structured_output: ${!!structured}, result length: ${(msg.result as string)?.length ?? 0})`);
          updateReportStatus(reportId, 'completed', resultText);
          let manuscripts: ManuscriptCandidate[] = [];
          try {
            manuscripts = createBriefingsFromScan(workspaceId, reportId, resultText, {
              onBriefingsChanged: params.onBriefingsChanged,
            });
          } catch (err) {
            log.error('[DirectoryScanner] Failed to create briefings from scan:', err);
          }
          try {
            const scanData = JSON.parse(resultText);
            if (Array.isArray(scanData.tagged_files)) {
              // Normalise keys: LLM may return {path,filename,type}
              // instead of the schema's {file_path,file_name,file_type}.
              const normalised = scanData.tagged_files
                .map((f: Record<string, unknown>) => ({
                  file_path: (f.file_path ?? f.path) as string,
                  file_name: (f.file_name ?? f.filename) as string,
                  file_type: (f.file_type ?? f.type) as string,
                }))
                .filter((f: { file_name: string }) => !f.file_name.startsWith('~$'));
              upsertScannedFiles(workspaceId, reportId, normalised);
            }
          } catch (err) {
            log.error('[DirectoryScanner] Failed to persist tagged files:', err);
          }
          // Enrich manuscripts with LLM-generated titles before completing.
          try {
            await enrichAndCreateManuscriptBriefings(
              manuscripts, workspaceId, reportId, directoryPath,
              params.apiKey, params.baseURL,
            );
            params.onBriefingsChanged?.();
          } catch (err) {
            log.error('[DirectoryScanner] Manuscript enrichment failed:', err);
          }
          onMessage?.({ type: 'complete', reportId, reportData: resultText });
        } else {
          const errorText = (msg.error as string) || (msg.subtype as string) || 'Unknown error';
          updateReportStatus(reportId, 'failed', undefined, errorText);
          log.warn(`[DirectoryScanner] Scan failed for workspace ${workspaceId}: ${errorText}`);
          onMessage?.({ type: 'error', error: errorText });
        }
        break;
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`[DirectoryScanner] Scan error for workspace ${workspaceId}:`, err);
    updateReportStatus(reportId, 'failed', undefined, errorMessage);
    onMessage?.({ type: 'error', error: errorMessage });
  }
}
