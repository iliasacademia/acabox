/**
 * The model roster — one definition, shared by the picker, the agent-server
 * default and the mini-app proxy allowlist.
 *
 * WHY THIS FILE EXISTS. Until 2026-09-16 the roster was a hardcoded array in
 * THREE places (`ModelSelector.tsx`, `ANTHROPIC_ALLOWED_MODELS` in
 * `main/index.ts`, and the agent default in `AgentInfrastructureController`),
 * so adding a model was a manual three-edit change and forgetting one gave a
 * different failure at each site: missing from the picker, refused for
 * mini-apps, or silently replaced by the default. They drifted exactly as you
 * would expect — Fable 5.1 shipped and the picker still offered Fable 5.
 *
 * WHAT IS AUTOMATIC AND WHAT IS NOT. `GET /v1/models` is the live roster, and
 * `discoverModels()` in `main/modelCatalog.ts` reads it. But a raw passthrough
 * is the wrong UI: the endpoint also lists every legacy model the account can
 * still reach, in release order, with no descriptions. So discovery decides
 * WHICH models exist and the curated table below decides how the ones we know
 * about are described and ordered. A model we have never heard of is added
 * automatically — see `mergeModels` for the rule that distinguishes "released
 * after this build" from "old, and deliberately not listed".
 *
 * The default model is deliberately NOT automatic. Auto-jumping to whatever is
 * newest would change every new chat's cost and behaviour because Anthropic
 * shipped something, with no one having chosen it.
 */

/** A model as the picker renders it. */
export interface PickerModel {
  id: string;
  label: string;
  description: string;
  /** True when this came from the API rather than the table below. */
  discovered?: boolean;
}

/** One row of `GET /v1/models`. Only the fields we actually use. */
export interface DiscoveredModel {
  id: string;
  display_name?: string;
  /** ISO 8601. Absent on very old records, which is why every read guards it. */
  created_at?: string;
}

/**
 * The models we show, in capability order — NOT release order, which is why
 * this is hand-maintained rather than sorted from the API.
 */
export const CURATED_MODELS: readonly PickerModel[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', description: 'Highest intelligence, premium cost' },
  { id: 'claude-opus-5', label: 'Opus 5', description: 'Most capable for ambitious work' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Previous-generation Opus' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Most efficient for everyday tasks' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest for quick answers' },
] as const;

/**
 * Models we know exist and deliberately do not show.
 *
 * This list is load-bearing for `mergeModels`, not documentation. A superseded
 * id still present here is how the merge knows that model is OLD — drop
 * `claude-fable-5` from this set and the next discovery would re-add it to the
 * picker as if it were a new release.
 */
export const SUPERSEDED_MODEL_IDS: readonly string[] = [
  'claude-fable-5',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;

/**
 * Models this account CAN see but Acabox cannot run, because the Claude Code
 * CLI bundled with the Agent SDK refuses them.
 *
 * EMPTY TODAY, and the reason it exists anyway is the constraint it records.
 * On SDK 0.2.121 (== Claude Code 2.1.121) a real turn on `claude-fable-5-1`
 * returned
 *
 *     API Error: 400 invalid_request_error
 *     "Claude Code 2.1.121 does not support this model;
 *      version 2.1.251 or newer is required"
 *
 * while `claude-fable-5` replied normally on the same build. Upgrading the
 * SDK to 0.3.273 (Claude Code 2.1.273) cleared it, verified by re-running the
 * same turn — which is why Fable 5.1 is now in CURATED_MODELS above.
 *
 * The general rule this leaves behind: the account roster and the CLI are two
 * different gates. `GET /v1/models` can only tell us a model EXISTS; whether
 * we can RUN it depends on the bundled CLI version, and a brand-new model is
 * exactly the case an older CLI rejects. When Anthropic ships a model this
 * build's CLI is too old for, put its id here (it must also stay reachable
 * from KNOWN_MODEL_IDS, or discovery will auto-add it straight back) and
 * bump the SDK to clear it.
 *
 * The gate is CHAT-only — mini-apps call the Anthropic API directly through
 * the proxy with no CLI in the path, which is why `allowedModelIds` below is
 * free to trust discovery outright.
 */
export const UNSUPPORTED_MODEL_IDS: readonly string[] = [
] as const;

/**
 * Every id this build was written against, shown or not.
 *
 * `UNSUPPORTED_MODEL_IDS` belongs here and leaving it out would be a live bug:
 * "known" is what stops `mergeModels` treating an id as a new release, and
 * Fable 5.1 is newer than everything else on the roster — so an unknown
 * Fable 5.1 would be auto-added to the picker on the next discovery and 400
 * for whoever chose it.
 */
export const KNOWN_MODEL_IDS: readonly string[] = [
  ...CURATED_MODELS.map((m) => m.id),
  ...SUPERSEDED_MODEL_IDS,
  ...UNSUPPORTED_MODEL_IDS,
];

/**
 * Pinned, and pinned on purpose — see the header. Changing it is a decision,
 * so it is a code edit.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Most a single discovery may add.
 *
 * Not politeness: `mergeModels` trusts `created_at`, and a roster whose dates
 * are wrong (or a future response shape we guessed at) would otherwise be able
 * to push the curated models off the bottom of the menu. The cap bounds the
 * blast radius of being wrong about the API.
 */
export const MAX_AUTO_ADDED_MODELS = 6;

/** What a newly discovered model says until someone curates it. */
const DISCOVERED_DESCRIPTION = 'New from Anthropic — may need an Acabox update';

/**
 * Merge the live roster into the curated one.
 *
 * THE RULE, and why it is not a date constant: a discovered model is shown
 * when we have never heard of its id **and** it is newer than every model we
 * *have* heard of. The cutoff is computed from the API's own `created_at`
 * values for the ids in `KNOWN_MODEL_IDS`, so it re-calibrates itself on every
 * call and there is no hardcoded date to go stale.
 *
 * Both halves are needed, and each one alone fails a real case:
 *   - "unknown id" alone would surface `claude-3-5-sonnet-20240620` — a model
 *     older than everything here, never curated because it is not worth
 *     offering — and present it as new.
 *   - "newer than what we know" alone would re-add a model we deliberately
 *     retired the moment it outranked the rest by date.
 *
 * Conservative when it cannot tell: if discovery returns nothing we recognise,
 * there is no trustworthy cutoff, so nothing is added. A roster we cannot
 * locate ourselves in is a roster we should not be reordering the UI from.
 */
export function mergeModels(discovered: readonly DiscoveredModel[]): PickerModel[] {
  const known = new Set(KNOWN_MODEL_IDS);

  let newestKnown = '';
  for (const m of discovered) {
    if (known.has(m.id) && m.created_at && m.created_at > newestKnown) newestKnown = m.created_at;
  }
  if (!newestKnown) return [...CURATED_MODELS];

  const seen = new Set<string>();
  const newcomers = discovered
    .filter((m) => {
      if (known.has(m.id) || !m.created_at) return false;
      if (m.created_at <= newestKnown) return false;
      if (seen.has(m.id)) return false;   // the API paginates; a dupe would render twice
      seen.add(m.id);
      return true;
    })
    // Newest first, so the most capable release of a batch leads.
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .slice(0, MAX_AUTO_ADDED_MODELS)
    .map<PickerModel>((m) => ({
      id: m.id,
      // The API's own name, so a model we know nothing about is still labelled
      // the way Anthropic labels it rather than by its raw id.
      label: m.display_name?.trim() || m.id,
      description: DISCOVERED_DESCRIPTION,
      discovered: true,
    }));

  return [...newcomers, ...CURATED_MODELS];
}

/**
 * Ids a mini-app may pass to the Claude bridge.
 *
 * Everything we know about, plus everything the account can actually reach.
 * The union is the point: this gate exists to stop a mini-app inventing a
 * model string, not to second-guess Anthropic's own roster, and keeping it in
 * step with the picker is what stops "pickable in chat, refused in a tool".
 */
export function allowedModelIds(discovered: readonly DiscoveredModel[]): Set<string> {
  return new Set([...KNOWN_MODEL_IDS, ...discovered.map((m) => m.id)]);
}
