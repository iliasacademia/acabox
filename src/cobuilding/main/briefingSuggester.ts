import * as http from 'http';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { containerService } from './containerService';
import { createBriefing } from './db/briefingsRepository';
import { getReport } from './db/reportRepository';

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

interface BriefingSuggestion {
  title?: unknown;
  description?: unknown;
  why_im_suggesting_this?: unknown;
  chat_prompt?: unknown;
}

const SUGGESTION_PROMPT = `Here is what I learned about the researcher from scanning their workspace:

## About the researcher
{about_you}

## What they're currently working on
{working_on}

Given what you learned about me from my workspace, can you suggest things that you can do for me that would significantly expedite my research?

Focus on concrete, actionable tasks — things like helping draft a specific section of a paper, creating figures from data, reviewing and improving a manuscript, preparing for a presentation, analyzing datasets, or writing grant proposal sections.

Suggest as many things as you can think of. Order them by your confidence that you can actually do the task well — put the things you're most confident you can deliver at the top.

Your response MUST be valid JSON (no markdown fences, no commentary). Return an object with a single field:

{
  "suggestions": [
    {
      "title": "Short action title (e.g. 'Draft methods section for your cortisol paper')",
      "description": "1-2 sentence description of what you'd do and why it helps",
      "why_im_suggesting_this": "1 sentence connecting this to something specific in their workspace",
      "chat_prompt": "The exact message the user would send to start this task — specific enough that you could begin working immediately"
    }
  ]
}

Prioritize suggestions that are specific to the researcher's actual files and projects, not generic advice.`;

export async function generateBriefingSuggestions(params: {
  workspaceId: string;
  reportId: string;
  onBriefingsChanged?: () => void;
}): Promise<void> {
  const { workspaceId, reportId } = params;

  const report = getReport(reportId);
  if (!report) {
    throw new Error('Report not found');
  }

  const aboutYou = report.about_you_summary || '';
  const workingOn = report.what_youre_working_on_summary || '';

  if (!aboutYou && !workingOn) {
    log.warn('[BriefingSuggester] No profile data available — skipping');
    return;
  }

  const agentPort = containerService.getAgentPort();
  if (!agentPort) {
    throw new Error('Agent server not available — container may not be running');
  }

  const baseUrl = `http://localhost:${agentPort}`;

  const sessionId = randomUUID();
  const createRes = await httpPost(`${baseUrl}/sessions`, JSON.stringify({ sessionId }));
  const agentSessionId = JSON.parse(createRes).sessionId as string;
  log.info(`[BriefingSuggester] Session created: ${agentSessionId}`);

  const TIMEOUT_MS = 2 * 60 * 1000;

  try {
    const resultText = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      const timeout = setTimeout(() => {
        settle(() => {
          try { req.destroy(); } catch {}
          reject(new Error('Briefing suggestion timed out'));
        });
      }, TIMEOUT_MS);

      const parsedUrl = new URL(`${baseUrl}/sessions/${agentSessionId}/events`);
      const req = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
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
              if (line.startsWith('event: ')) eventType = line.slice(7);
              else if (line.startsWith('data: ')) data = line.slice(6);
            }

            if (!eventType || !data) continue;

            if (eventType === 'message') {
              try {
                const message = JSON.parse(data);
                if (message.type === 'result') {
                  if (message.subtype === 'success') {
                    const text = typeof message.result === 'string'
                      ? message.result
                      : JSON.stringify(message.result);
                    settle(() => { clearTimeout(timeout); resolve(text); });
                  } else {
                    const errorText = message.error || message.subtype || 'Unknown error';
                    settle(() => { clearTimeout(timeout); reject(new Error(errorText)); });
                  }
                }
              } catch (err) {
                log.error('[BriefingSuggester] Failed to parse SSE message:', err);
              }
            } else if (eventType === 'mcp-call') {
              try {
                const mcpCall = JSON.parse(data);
                httpPost(
                  `${baseUrl}/sessions/${agentSessionId}/mcp-result`,
                  JSON.stringify({ callId: mcpCall.callId, error: 'MCP tools are not available during briefing generation' }),
                ).catch(() => {});
              } catch {}
            } else if (eventType === 'done') {
              settle(() => { clearTimeout(timeout); reject(new Error('Session ended without result')); });
            }
          }
        });

        res.on('error', (err) => {
          settle(() => { clearTimeout(timeout); reject(err); });
        });

        res.on('end', () => {
          settle(() => { clearTimeout(timeout); reject(new Error('SSE stream ended unexpectedly')); });
        });

        // Send the prompt after connecting to SSE
        const prompt = SUGGESTION_PROMPT
          .replace('{about_you}', aboutYou)
          .replace('{working_on}', workingOn);

        httpPost(
          `${baseUrl}/sessions/${agentSessionId}/messages`,
          JSON.stringify({ text: prompt }),
        ).catch((err) => {
          settle(() => { clearTimeout(timeout); reject(err); });
        });
      });

      req.on('error', (err) => {
        settle(() => { clearTimeout(timeout); reject(err); });
      });
      req.end();
    });

    // Parse the result and create briefings
    const cleanResult = extractJson(resultText);
    let parsed: { suggestions?: unknown };
    try {
      parsed = JSON.parse(cleanResult);
    } catch {
      log.error('[BriefingSuggester] Failed to parse result JSON');
      return;
    }

    if (!Array.isArray(parsed.suggestions)) {
      log.warn('[BriefingSuggester] No suggestions array in result');
      return;
    }

    const suggestions = parsed.suggestions as BriefingSuggestion[];
    let created = 0;

    for (const suggestion of suggestions) {
      if (typeof suggestion?.title !== 'string' || typeof suggestion?.chat_prompt !== 'string') {
        continue;
      }
      createBriefing({
        workspaceId,
        type: 'suggested_action',
        sourceReportId: reportId,
        whyImSuggestingThis:
          typeof suggestion.why_im_suggesting_this === 'string'
            ? suggestion.why_im_suggesting_this
            : null,
        briefingData: {
          title: suggestion.title,
          description: typeof suggestion.description === 'string' ? suggestion.description : '',
          chat_prompt: suggestion.chat_prompt,
        },
      });
      created++;
    }

    log.info(`[BriefingSuggester] Created ${created} briefings`);
    if (created > 0) {
      params.onBriefingsChanged?.();
    }
  } finally {
    httpPost(`${baseUrl}/sessions/${agentSessionId}/stop`, '{}').catch(() => {});
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {}

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceIdx = trimmed.indexOf('{');
  if (braceIdx > 0) {
    const candidate = trimmed.slice(braceIdx);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  return trimmed;
}
