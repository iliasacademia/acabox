import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import log from 'electron-log';

import { RESERVED_CONNECTOR_IDS } from '../../shared/connectors';
import { SKILL_FINDINGS_SUBDIR } from '../../shared/skills';

/**
 * The inverted omission rule, and the store behind the Knowledge page's
 * "Needs attention" section.
 *
 * WHY THE OBVIOUS RULE IS THE WRONG ONE
 * -------------------------------------
 * The naive detector is "a skill was used and no finding was recorded". It
 * fires on the HEALTHY path: a mature ledger means most sessions legitimately
 * discover nothing new, so the channel would fill with rows that are correct to
 * ignore and the user would learn to ignore all of them inside a fortnight. A
 * notification channel that has been trained away is worse than no channel.
 *
 * The rule that carries signal is the inverse:
 *
 *   > the turn ran a connector tool AND read no file under references/findings/
 *
 * That is *went to the warehouse without consulting the ledger* — the exact
 * failure that cost this user twice, and observable in the same tool-call
 * stream `agentSession` already watches to arm the OAuth pin. It fires on the
 * unhealthy path only, and it is silent on a session that consulted the ledger
 * and found nothing worth adding.
 *
 * Persisted following the `tool-jobs.json` / `tool-build-health.json`
 * precedent: a plain JSON array in userData, loaded lazily, rewritten whole,
 * with listeners so a surface can subscribe.
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Acabox's own relay servers, which are NOT connectors. `mcp__workspace__*` and
 * `mcp__mini-apps__*` are the host talking to itself; treating them as a trip
 * to the warehouse would make every mini-app turn raise a row.
 *
 * `knowledge` — the findings-ledger relay — is in `RESERVED_CONNECTOR_IDS`
 * alongside the rest, so a user cannot configure a connector that would make
 * `record_finding` itself read as a trip to the warehouse.
 */
const RELAY_SERVER_IDS = new Set<string>(RESERVED_CONNECTOR_IDS);

/**
 * The connector id inside an MCP tool name, or null when the name is not a
 * connector call. The SDK builds names as `mcp__<id>__<tool>`, and connector
 * ids may not contain `__` (enforced by `CONNECTOR_ID_PATTERN`), so the split
 * is unambiguous.
 */
export function connectorIdOfTool(toolName: string): string | null {
  const m = /^mcp__([^_](?:[^_]|_(?!_))*)__/.exec(String(toolName ?? ''));
  if (!m) return null;
  const id = m[1];
  return RELAY_SERVER_IDS.has(id) ? null : id;
}

/** Did this path reach into a skill's findings ledger? */
export function isFindingsRead(readPath: string): boolean {
  return String(readPath ?? '').includes(SKILL_FINDINGS_SUBDIR);
}

export type TurnVerdict =
  /** No connector tool ran — the rule does not apply. */
  | 'no-connector'
  /** A connector ran and the ledger was consulted. Nothing to report. */
  | 'consulted-ledger'
  /** A connector ran and no findings file was read. This is the signal. */
  | 'omitted-ledger';

export interface TurnToolActivity {
  /** Every tool name used in the turn, in any order. Duplicates are fine. */
  toolNames: readonly string[];
  /** Every file path the turn read. Duplicates are fine. */
  readPaths: readonly string[];
}

export function classifyTurn(activity: TurnToolActivity): TurnVerdict {
  const connectors = (activity.toolNames ?? [])
    .map(connectorIdOfTool)
    .filter((id): id is string => Boolean(id));
  if (connectors.length === 0) return 'no-connector';
  return (activity.readPaths ?? []).some(isFindingsRead) ? 'consulted-ledger' : 'omitted-ledger';
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type KnowledgeReviewKind =
  /** A turn queried a connector without reading the ledger. */
  | 'connector-without-ledger'
  /**
   * Relation triage thinks a new finding may replace an older one. Produced by
   * the post-write Haiku classifier, which is deliberately NOT part of the
   * write path — `record_finding` never refuses, so relating happens after.
   */
  | 'possible-supersession';

export interface KnowledgeReviewItem {
  id: string;
  kind: KnowledgeReviewKind;
  /** Acabox chat session id, so the card can open the conversation. */
  sessionId?: string;
  /** Chat title as it read when the row was raised. */
  chatTitle?: string;
  /** Connector ids observed — the evidence, so the card can name Hex by name. */
  connectors?: string[];
  /** `possible-supersession`: the two finding ids and the skill that owns them. */
  findingIds?: string[];
  skill?: string;
  at: number;
}

/** More than this and the oldest rows are dropped; a backlog is not a queue. */
const MAX_ITEMS = 100;

let items: KnowledgeReviewItem[] = [];
let loaded = false;
const listeners = new Set<(all: KnowledgeReviewItem[]) => void>();

function storePath(): string {
  return path.join(app.getPath('userData'), 'knowledge-review.json');
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf-8'));
    if (Array.isArray(parsed)) {
      items = parsed.filter((i) => i && typeof i.id === 'string' && typeof i.kind === 'string');
    }
  } catch {
    // Missing or corrupt — an empty review list is the correct default. Nothing
    // here is a record of work; it is a record of things worth looking at.
    items = [];
  }
}

function persist(): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    log.warn(`[Knowledge] Could not persist review list: ${(err as Error).message}`);
  }
}

function emit(): void {
  if (items.length > MAX_ITEMS) {
    items = [...items].sort((a, b) => b.at - a.at).slice(0, MAX_ITEMS);
  }
  persist();
  const snapshot = listKnowledgeReviews();
  for (const l of listeners) {
    try {
      l(snapshot);
    } catch (err) {
      log.warn(`[Knowledge] review listener threw: ${(err as Error).message}`);
    }
  }
}

export function listKnowledgeReviews(): KnowledgeReviewItem[] {
  load();
  return [...items].sort((a, b) => b.at - a.at).map((i) => ({ ...i }));
}

export function subscribeKnowledgeReviews(
  listener: (all: KnowledgeReviewItem[]) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Dismiss a row. It is REMOVED rather than flagged, and that is deliberate: a
 * dismissed row that lingers invites a "show dismissed" affordance nobody asked
 * for, and the underlying fact (that one chat did not read the ledger) is not
 * worth keeping once the user has looked at it. Mirrors `acknowledgeTool`.
 */
export function dismissKnowledgeReview(id: string): boolean {
  load();
  const before = items.length;
  items = items.filter((i) => i.id !== id);
  if (items.length === before) return false;
  emit();
  return true;
}

export function addKnowledgeReview(item: Omit<KnowledgeReviewItem, 'id' | 'at'> & { at?: number }): KnowledgeReviewItem {
  load();
  const row: KnowledgeReviewItem = { ...item, id: randomUUID(), at: item.at ?? Date.now() };
  items.push(row);
  emit();
  return row;
}

/**
 * Apply the omission rule to one finished turn.
 *
 * One row per CHAT, not per turn: the card reads "this chat queried Hex without
 * consulting the ledger", and three turns in one conversation are one piece of
 * news. A later turn in the same chat that DOES read the ledger clears the row
 * — the row describes a conversation, and the conversation stopped being an
 * example the moment it consulted the ledger.
 *
 * Returns the row when one is raised or refreshed, null otherwise.
 */
export function noteTurn(input: {
  sessionId?: string;
  chatTitle?: string;
  toolNames: readonly string[];
  readPaths: readonly string[];
  at?: number;
}): KnowledgeReviewItem | null {
  load();
  const verdict = classifyTurn(input);
  const existing = input.sessionId
    ? items.find((i) => i.kind === 'connector-without-ledger' && i.sessionId === input.sessionId)
    : undefined;

  if (verdict !== 'omitted-ledger') {
    if (verdict === 'consulted-ledger' && existing) {
      items = items.filter((i) => i !== existing);
      emit();
      log.info(`[Knowledge] Chat ${input.sessionId} consulted the ledger — review row cleared`);
    }
    return null;
  }

  const connectors = [
    ...new Set(input.toolNames.map(connectorIdOfTool).filter((id): id is string => Boolean(id))),
  ].sort();
  const at = input.at ?? Date.now();

  if (existing) {
    existing.at = at;
    existing.chatTitle = input.chatTitle ?? existing.chatTitle;
    existing.connectors = [...new Set([...(existing.connectors ?? []), ...connectors])].sort();
    emit();
    return { ...existing };
  }

  const row = addKnowledgeReview({
    kind: 'connector-without-ledger',
    sessionId: input.sessionId,
    chatTitle: input.chatTitle,
    connectors,
    at,
  });
  log.info(
    `[Knowledge] Chat ${input.sessionId ?? '(none)'} queried ${connectors.join(', ')} without reading the findings ledger`,
  );
  return row;
}

/** Test seam. */
export function __resetKnowledgeReviews(): void {
  items = [];
  loaded = true;
  listeners.clear();
}
