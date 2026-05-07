import * as http from 'http';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { containerService } from '../containerService';
import { createReport, updateReportStatus } from '../db/reportRepository';
import { createBriefing } from '../db/briefingsRepository';
import { upsertScannedFiles } from '../db/scannedFilesRepository';
import { buildScannerPrompt } from './systemPrompt';

const DIRECTORY_ORGANIZATION_PROMPT = `Please help me organize my research directory. First, inspect the workspace and understand the current file structure, research projects, documents, data, scripts, outputs, and any existing naming conventions. Then recommend an effective organization plan for the directory.

YOU MUST ALWAYS present me with a clear plan before proceeding to take any actions or make any file modifications. Do not move, rename, delete, rewrite, or create files until I explicitly approve the plan.`;

interface SuggestedMiniAppParsed {
  name?: unknown;
  why_im_suggesting_this?: unknown;
  details_on_what_to_build?: unknown;
}

interface WorkingOnFileParsed {
  file_path?: unknown;
  description?: unknown;
}

interface TaggedFileParsed {
  file_path?: unknown;
  file_name?: unknown;
  file_type?: unknown;
}

const WRITING_AGENT_KICKOFF_PROMPT = 'Read just the first section of this manuscript (the Introduction, or whatever heading appears first) and propose exactly 3 small wording improvements as tracked changes — clarity or concision only, no content changes.';

function createBriefingsFromScan(
  workspaceId: string,
  reportId: string,
  resultText: string,
  ctx: {
    onBriefingsChanged?: () => void;
  },
): void {
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
    suggested_mini_apps?: unknown;
    what_youre_working_on?: unknown;
    tagged_files?: unknown;
  };
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return;
  }

  // Surface the most relevant DOCX manuscript as a Writing Agent briefing.
  // Source from `tagged_files` (the comprehensive list — any manuscript the
  // scanner found) rather than `what_youre_working_on` (capped at 3 items
  // prioritizing variety across categories, so a manuscript can get bumped
  // out by a presentation or grant). Pull the description from working-on
  // if the same file also made that list, otherwise fall back to a generic.
  const workingOn = Array.isArray(parsed.what_youre_working_on)
    ? (parsed.what_youre_working_on as WorkingOnFileParsed[])
    : [];
  const taggedFiles = Array.isArray(parsed.tagged_files)
    ? (parsed.tagged_files as TaggedFileParsed[])
    : [];
  const docxManuscript = taggedFiles.find(
    (f) =>
      f?.file_type === 'manuscript' &&
      typeof f.file_path === 'string' &&
      f.file_path.toLowerCase().endsWith('.docx'),
  );
  if (docxManuscript && typeof docxManuscript.file_path === 'string') {
    const relPath = docxManuscript.file_path;
    const matchingWorkingOn = workingOn.find(
      (f) => typeof f?.file_path === 'string' && f.file_path === relPath,
    );
    const description =
      typeof matchingWorkingOn?.description === 'string'
        ? matchingWorkingOn.description
        : '';
    createBriefing({
      workspaceId,
      type: 'writing_agent',
      sourceReportId: reportId,
      whyImSuggestingThis:
        description ||
        'Pick up where you left off — I can help you draft and revise inline in Word.',
      briefingData: {
        file_path: relPath,
        description,
        chat_prompt: WRITING_AGENT_KICKOFF_PROMPT,
      },
    });
  }

  // Create one suggested_tool briefing per mini-app the scanner suggested.
  const apps = Array.isArray(parsed.suggested_mini_apps)
    ? (parsed.suggested_mini_apps as SuggestedMiniAppParsed[])
    : [];

  for (const app of apps) {
    if (typeof app?.name !== 'string' || typeof app?.details_on_what_to_build !== 'string') {
      continue;
    }
    createBriefing({
      workspaceId,
      type: 'suggested_tool',
      sourceReportId: reportId,
      whyImSuggestingThis:
        typeof app.why_im_suggesting_this === 'string'
          ? app.why_im_suggesting_this
          : null,
      briefingData: {
        name: app.name,
        details_on_what_to_build: app.details_on_what_to_build,
      },
    });
  }

  // One notify covers every briefing created synchronously above; the async
  // manuscript-analysis path fires its own when the upgrade lands.
  ctx.onBriefingsChanged?.();
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
  msg: Record<string, unknown>,
  containerWorkDir: string,
): Array<{ path: string; tool: string }> {
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return [];

  const activities: Array<{ path: string; tool: string }> = [];

  for (const block of content) {
    if (block.type !== 'tool_use') continue;

    const tool: string = block.name;
    const input = block.input as Record<string, unknown>;

    if (tool === 'Read' && typeof input.file_path === 'string' && input.file_path.trim()) {
      activities.push({ path: `Read: ${toRelative(input.file_path, containerWorkDir)}`, tool });
    } else if (tool === 'Glob' && typeof input.pattern === 'string' && input.pattern.trim()) {
      const rel = typeof input.path === 'string' && input.path.trim()
        ? toRelative(input.path, containerWorkDir)
        : '';
      const dir = rel && rel !== '.' ? rel + '/' : '';
      activities.push({ path: `Glob ${dir}${input.pattern}`, tool });
    } else if (tool === 'Grep') {
      const target = typeof input.path === 'string' && input.path.trim()
        ? toRelative(input.path, containerWorkDir)
        : typeof input.pattern === 'string' && input.pattern.trim()
          ? input.pattern
          : null;
      if (target) activities.push({ path: `Grep: ${target}`, tool });
    }
  }

  return activities;
}

/** Extract human-readable progress text from an SDK assistant message. */
function extractProgressText(msg: Record<string, unknown>): string | null {
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const firstLine = block.text.split('\n').map((l: string) => l.trim()).find((l: string) => l.length > 0);
      if (firstLine && !/^[{\[]/.test(firstLine)) return firstLine.slice(0, 120);
    }
  }
  return null;
}

// ─── HTTP Helpers ──────────────────────────────────────────────────

function httpPost(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Main Scanner ──────────────────────────────────────────────────

/** The container workspace is always mounted at /data. */
const CONTAINER_WORK_DIR = '/data';

export async function scanWorkspaceDirectory(params: ScanParams): Promise<void> {
  const { workspaceId, directoryPath, onMessage } = params;
  const reportId = randomUUID();

  log.info(`[DirectoryScanner] Starting scan for workspace ${workspaceId} at ${directoryPath}`);

  const agentPort = containerService.getAgentPort();
  if (!agentPort) {
    const err = 'Agent server not available — container may not be running';
    log.error(`[DirectoryScanner] ${err}`);
    onMessage?.({ type: 'error', error: err });
    return;
  }

  const baseUrl = `http://localhost:${agentPort}`;

  createReport(reportId, workspaceId, 'directory_scan');
  updateReportStatus(reportId, 'running');

  try {
    // 1. Create a session on the agent server
    const sessionId = randomUUID();
    const createRes = await httpPost(`${baseUrl}/sessions`, JSON.stringify({ sessionId }));
    const createData = JSON.parse(createRes);
    const agentSessionId = createData.sessionId as string;
    log.debug(`[DirectoryScanner] Scan session created: ${agentSessionId}`);

    const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      const timeout = setTimeout(() => {
        settle(() => {
          log.warn('[DirectoryScanner] Scan timed out');
          updateReportStatus(reportId, 'failed', undefined, 'Scan timed out');
          onMessage?.({ type: 'error', error: 'Scan timed out — please try again' });
          try { req.destroy(); } catch {}
          resolve();
        });
      }, SCAN_TIMEOUT_MS);

      const parsed = new URL(`${baseUrl}/sessions/${agentSessionId}/events`);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      }, (res) => {
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');

          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            const lines = part.split('\n');
            let eventType = '';
            let data = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7);
              } else if (line.startsWith('data: ')) {
                data = line.slice(6);
              }
            }

            if (!eventType || !data) continue;

            if (eventType === 'message') {
              try {
                const message = JSON.parse(data);

                if (message.type === 'assistant') {
                  const text = extractProgressText(message);
                  if (text) {
                    onMessage?.({ type: 'progress', text });
                  }

                  const activities = extractFileActivities(message, CONTAINER_WORK_DIR);
                  for (const activity of activities) {
                    onMessage?.({ type: 'file_activity', path: activity.path, tool: activity.tool });
                  }
                } else if (message.type === 'tool_use_summary') {
                  const summary = message.summary;
                  if (typeof summary === 'string' && summary.trim().length > 0) {
                    onMessage?.({ type: 'progress', text: summary });
                    const relativeSummary = stripAbsolutePaths(summary, CONTAINER_WORK_DIR).trim();
                    if (relativeSummary.length > 0) {
                      onMessage?.({ type: 'file_activity', path: relativeSummary.slice(0, 120), tool: 'summary' });
                    }
                  }
                } else if (
                  message.type === 'system' &&
                  message.subtype === 'task_started' &&
                  typeof message.description === 'string'
                ) {
                  onMessage?.({ type: 'progress', text: message.description });
                } else if (message.type === 'result') {
                  if (message.subtype === 'success') {
                    const resultText = typeof message.result === 'string'
                      ? message.result
                      : JSON.stringify(message.result);
                    const cleanResult = extractJsonFromText(resultText);
                    log.info(`[DirectoryScanner] Scan completed (${cleanResult.length} chars)`);
                    updateReportStatus(reportId, 'completed', cleanResult);
                    try {
                      createBriefingsFromScan(workspaceId, reportId, cleanResult, {
                        onBriefingsChanged: params.onBriefingsChanged,
                      });
                    } catch (err) {
                      log.error('[DirectoryScanner] Failed to create briefings:', err);
                    }
                    try {
                      const scanData = JSON.parse(cleanResult);
                      if (Array.isArray(scanData.tagged_files)) {
                        upsertScannedFiles(workspaceId, reportId, scanData.tagged_files);
                      }
                    } catch (err) {
                      log.error('[DirectoryScanner] Failed to persist tagged files:', err);
                    }
                    onMessage?.({ type: 'complete', reportId, reportData: cleanResult });
                    httpPost(
                      `${baseUrl}/sessions/${agentSessionId}/stop`,
                      '{}',
                    ).catch(() => {});
                    settle(() => { clearTimeout(timeout); resolve(); });
                  } else {
                    const errorText = message.error || message.subtype || 'Unknown error';
                    log.warn(`[DirectoryScanner] Scan failed: ${errorText}`);
                    updateReportStatus(reportId, 'failed', undefined, errorText);
                    onMessage?.({ type: 'error', error: errorText });
                    httpPost(
                      `${baseUrl}/sessions/${agentSessionId}/stop`,
                      '{}',
                    ).catch(() => {});
                    settle(() => { clearTimeout(timeout); resolve(); });
                  }
                }
              } catch (err) {
                log.error('[DirectoryScanner] Failed to parse SSE message:', err);
              }
            } else if (eventType === 'mcp-call') {
              try {
                const mcpCall = JSON.parse(data);
                const { callId } = mcpCall;
                httpPost(
                  `${baseUrl}/sessions/${agentSessionId}/mcp-result`,
                  JSON.stringify({ callId, error: 'MCP tools are not available during workspace scan' }),
                ).catch(() => {});
              } catch { /* ignore */ }
            } else if (eventType === 'done') {
              settle(() => { clearTimeout(timeout); resolve(); });
            }
          }
        });

        res.on('error', (err) => {
          log.error(`[DirectoryScanner] SSE connection error: ${err.message}`);
          settle(() => { clearTimeout(timeout); reject(err); });
        });

        res.on('end', () => {
          settle(() => { clearTimeout(timeout); resolve(); });
        });

        httpPost(
          `${baseUrl}/sessions/${agentSessionId}/messages`,
          JSON.stringify({ text: buildScannerPrompt() }),
        ).catch((err) => {
          log.error(`[DirectoryScanner] Failed to send scan prompt: ${err.message}`);
          settle(() => { clearTimeout(timeout); reject(err); });
        });
      });

      req.on('error', (err) => {
        settle(() => { clearTimeout(timeout); reject(err); });
      });
      req.end();
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`[DirectoryScanner] Scan error: ${errorMessage}`);
    updateReportStatus(reportId, 'failed', undefined, errorMessage);
    onMessage?.({ type: 'error', error: errorMessage });
  }
}

function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch { /* not raw JSON */ }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  const braceIdx = trimmed.indexOf('{');
  if (braceIdx > 0) {
    const candidate = trimmed.slice(braceIdx);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch { /* not valid from this brace */ }
  }

  return trimmed;
}
