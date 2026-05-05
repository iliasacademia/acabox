import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { resolveClaudeBinary } from '../sdkBinarySetup';
import { createReport, updateReportStatus } from '../db/reportRepository';
import { buildScannerSystemPrompt, buildScannerPrompt } from './systemPrompt';
import { REPORT_JSON_SCHEMA } from './reportSchema';

export type ScannerEvent =
  | { type: 'progress'; text: string }
  | { type: 'complete'; reportId: string; reportData: string }
  | { type: 'error'; error: string };

export interface ScanParams {
  workspaceId: string;
  directoryPath: string;
  apiKey: string;
  onMessage?: (event: ScannerEvent) => void;
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

export async function scanWorkspaceDirectory(params: ScanParams): Promise<void> {
  const { workspaceId, directoryPath, apiKey, onMessage } = params;
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

      log.debug(`[DirectoryScanner] SDK message: type=${msg.type}${(msg as any).subtype ? ` subtype=${(msg as any).subtype}` : ''}`, JSON.stringify(msg).slice(0, 500));

      // Forward progress events to the renderer
      if (onMessage) {
        if (msg.type === 'assistant') {
          const text = extractProgressText(msg);
          if (text) onMessage({ type: 'progress', text });
        } else if (msg.type === 'tool_use_summary') {
          const summary = (msg as any).summary;
          if (typeof summary === 'string' && summary.length > 0) {
            onMessage({ type: 'progress', text: summary });
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
