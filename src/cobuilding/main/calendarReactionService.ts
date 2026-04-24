import Anthropic from '@anthropic-ai/sdk';
import { Notification } from 'electron';
import * as https from 'https';
import * as http from 'http';
import log from 'electron-log';
import * as cal from './db/calendarRepository';
import * as reactions from './db/calendarReactionRepository';
import { hasRecentReactionForEntity } from './db/calendarReactionRepository';
import * as resources from './db/resourceRepository';
import type { CalendarEditBundle } from '../shared/types';

const DEBOUNCE_MS = 30_000;
const MODEL = 'claude-sonnet-4-6';
const MAX_TURNS = 8;
const FETCH_MAX_BYTES = 30_000;
// Don't re-react to the same event/plan within this window
const ENTITY_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

interface PendingMutation {
  type: string;
  entityId: string;
  entityName?: string;
  timestamp: string;
}

interface FindingResource {
  url: string;
  title: string;
}

interface Finding {
  title: string;
  content: string;
  event_id?: string | null;
  plan_id?: string | null;
  resources?: FindingResource[];
}

// ---- URL fetcher ----

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AcademiaBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    }, (res) => {
      // Follow one redirect
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        chunks.push(chunk);
        if (total > FETCH_MAX_BYTES) req.destroy();
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8', 0, FETCH_MAX_BYTES);
        // Strip HTML tags to get readable text
        const text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{3,}/g, '\n\n')
          .trim()
          .slice(0, 8000);
        resolve(text);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---- Tools ----

const FETCH_URL_TOOL: Anthropic.Tool = {
  name: 'fetch_url',
  description: 'Fetch the content of a URL. Use this to retrieve paper abstracts from arXiv, PubMed, bioRxiv, or any relevant academic resource. Returns plain text (HTML tags stripped).',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' },
    },
    required: ['url'],
  },
};

const REPORT_TOOL: Anthropic.Tool = {
  name: 'report_findings',
  description: 'Submit your final findings. Call this when you have gathered enough information, or immediately with an empty array if no helpful insight exists for these edits.',
  input_schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short title, under 60 chars.' },
            content: { type: 'string', description: '2–4 sentences of plain text explaining why this is relevant.' },
            event_id: { type: 'string', description: 'ID of the specific event this relates to, if any.' },
            plan_id: { type: 'string', description: 'ID of the specific plan this relates to, if any.' },
            resources: {
              type: 'array',
              description: 'Verified URLs you fetched and confirmed exist.',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  title: { type: 'string' },
                },
                required: ['url', 'title'],
              },
            },
          },
          required: ['title', 'content'],
        },
      },
    },
    required: ['findings'],
  },
};

const TOOLS: Anthropic.Tool[] = [FETCH_URL_TOOL, REPORT_TOOL];

// Collapse multiple mutations for the same entity into one (keep the latest).
function deduplicateMutations(mutations: PendingMutation[]): PendingMutation[] {
  const seen = new Map<string, PendingMutation>();
  for (const m of mutations) {
    seen.set(`${m.type}:${m.entityId}`, m);
  }
  return [...seen.values()];
}

// Remove mutations for entities that already have a reaction within the cooldown window.
function filterCooledDown(
  mutations: PendingMutation[],
  workspaceId: string
): PendingMutation[] {
  const since = new Date(Date.now() - ENTITY_COOLDOWN_MS).toISOString();
  return mutations.filter(m => !hasRecentReactionForEntity(workspaceId, m.entityId, since));
}

function buildSystemPrompt(bundle: CalendarEditBundle, workspaceId: string): string {
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const twoMonthsOut = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  const plans = cal.listPlans(workspaceId);
  const events = cal.listEvents(workspaceId, { from: twoWeeksAgo, to: twoMonthsOut });
  const today = new Date().toISOString().split('T')[0];

  return `You are a proactive research assistant embedded in an academic calendar used by a postdoc or graduate student. Your job is to look at recent calendar edits and surface genuinely useful insights: relevant papers, grants, tools, protocols, databases, or scheduling observations.

Today: ${today}

Recent calendar edits:
${JSON.stringify(bundle.mutations, null, 2)}

Calendar context:
Plans: ${JSON.stringify(plans.map(p => ({ id: p.id, name: p.name })))}
Upcoming events: ${JSON.stringify(events.map(e => ({ id: e.id, name: e.name, start_at: e.start_at, end_at: e.end_at, plan_id: e.plan_id })))}

---

## Your task

1. Look at the event/plan names and infer what the researcher is working on.
2. Use fetch_url to search for and retrieve real, relevant content from:
   - arXiv: https://arxiv.org/search/?query=TERM&searchtype=all&order=-announced_date_first
   - PubMed: https://pubmed.ncbi.nlm.nih.gov/?term=TERM&sort=date
   - bioRxiv/medRxiv: https://www.biorxiv.org/search/TERM%20numresults%3A5%20sort%3Arelevance-rank
   - Specific tools, databases, or grant pages if the context suggests them
3. Fetch the actual page to verify content before citing it.
4. Report only findings that are concretely useful — a specific paper with an abstract that's relevant, a real tool the researcher doesn't obviously already know about, a scheduling concern worth flagging.
5. It is perfectly fine — even preferred — to call report_findings with an empty array if the edits are routine (e.g., rescheduling a meeting) or you found nothing genuinely helpful.

## Findings quality bar
- Don't report vague observations ("this event is in 2 weeks") unless there's a real scheduling concern.
- Don't cite papers you haven't fetched and confirmed are real.
- Keep findings specific to the inferred research topic.
- 1–3 findings is ideal; 0 is fine; max 5.
- Write for a PhD student or postdoc: assume technical literacy, skip basics.`;
}

// ---- Agentic loop ----

async function generateReactions(
  bundle: CalendarEditBundle,
  workspaceId: string,
  apiKey: string
): Promise<void> {
  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt(bundle, workspaceId);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: 'Please analyze the calendar edits and report your findings.' },
  ];

  let findings: Finding[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: TOOLS,
    });

    // Append assistant turn
    messages.push({ role: 'assistant', content: response.content });

    // Check for terminal conditions
    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason !== 'tool_use') break;

    // Process all tool calls
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let done = false;

    for (const block of toolUseBlocks) {
      if (block.name === 'report_findings') {
        const input = block.input as { findings: Finding[] };
        findings = input?.findings ?? [];
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Findings recorded.' });
        done = true;
      } else if (block.name === 'fetch_url') {
        const { url } = block.input as { url: string };
        log.info('[CalendarReactions] Fetching URL:', url);
        let content: string;
        try {
          content = await fetchUrl(url);
        } catch (err) {
          content = `Error fetching URL: ${String(err)}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
      } else {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Unknown tool.' });
      }
    }

    messages.push({ role: 'user', content: toolResults });

    if (done) break;
  }

  if (findings.length === 0) {
    log.info('[CalendarReactions] No findings generated for this batch.');
    return;
  }

  const triggerContext = JSON.stringify(bundle);

  for (const finding of findings) {
    const reaction = reactions.createReaction(workspaceId, {
      event_id: finding.event_id ?? null,
      plan_id: finding.plan_id ?? null,
      title: finding.title,
      content: finding.content,
      trigger_context: triggerContext,
    });

    if (finding.resources?.length) {
      for (const r of finding.resources) {
        try {
          resources.createResource(workspaceId, {
            type: 'link',
            url: r.url,
            title: r.title,
            event_id: finding.event_id ?? null,
            plan_id: finding.plan_id ?? null,
            ai_generated: true,
          });
        } catch (err) {
          log.warn('[CalendarReactions] Failed to create resource for reaction', reaction.id, err);
        }
      }
    }
  }

  try {
    new Notification({
      title: 'New calendar insights',
      body: findings[0].title,
    }).show();
  } catch {
    // Notifications may not be available in all environments
  }
}

// ---- Public service ----

export interface CalendarReactionService {
  recordMutation(mutation: PendingMutation): void;
  setWorkspace(workspaceId: string, apiKey: string): void;
  destroy(): void;
}

export function createCalendarReactionService(
  onReactionsGenerated: () => void
): CalendarReactionService {
  let pending: PendingMutation[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let workspaceId: string | null = null;
  let apiKey: string | null = null;

  function flush() {
    if (pending.length === 0) return;
    if (!workspaceId || !apiKey) {
      log.info('[CalendarReactions] No workspace/apiKey set, skipping reaction generation');
      pending = [];
      return;
    }

    // Collapse duplicate mutations for the same entity, then drop entities
    // that already have a recent reaction (within the cooldown window).
    const deduplicated = deduplicateMutations(pending);
    const filtered = filterCooledDown(deduplicated, workspaceId);
    pending = [];

    if (filtered.length === 0) {
      log.info('[CalendarReactions] All mutations filtered (duplicates or cooldown) — skipping LLM call');
      return;
    }

    const bundle: CalendarEditBundle = {
      mutations: filtered,
      workspaceId,
      triggeredAt: new Date().toISOString(),
    };

    generateReactions(bundle, workspaceId, apiKey)
      .then(() => onReactionsGenerated())
      .catch(err => log.error('[CalendarReactions] Generation failed', err));
  }

  return {
    recordMutation(mutation: PendingMutation) {
      pending.push(mutation);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    },

    setWorkspace(wsId: string, key: string) {
      workspaceId = wsId;
      apiKey = key;
    },

    destroy() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
