/**
 * Skills — the one definition shared by the main process (the store, the
 * render, the importer), the agent server (handing `Options.skills` to the
 * SDK), and the renderer (the Knowledge page).
 *
 * A skill is a directory containing `SKILL.md`. Bytes live in exactly one
 * writable place — the host-owned store at `<userData>/<channel>/skills/<id>/`
 * — and `<workspace>/.claude/skills/<id>` is an absolute symlink to it, so an
 * agent `Edit`, a `Bash` heredoc, vim and the Acabox UI all deposit bytes in
 * the same inode. Nothing in this file touches the filesystem; it is types,
 * validation, the frontmatter reader, and the roster arithmetic.
 *
 * WHAT WAS MEASURED AGAINST THE BUNDLED CLI, AND WHY IT MATTERS HERE
 * ------------------------------------------------------------------
 * Every non-obvious rule below was read out of
 * `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, not
 * inferred from docs. The three that shape this file:
 *
 * 1. **A skill's identity is its DIRECTORY name, not its frontmatter `name`.**
 *    The `.claude/skills` loader is `ydH`, and it reads
 *    `skillName: T.name` — the dirent's name, which for a symlink is the
 *    link's name, not the target's basename. The frontmatter `name` lands in
 *    `displayName` and is only ever a label. So the store id is the directory
 *    name and we never rewrite a file to make them agree (see
 *    `aliasOfDirName`).
 *
 * 2. **Unparseable frontmatter does NOT drop the skill — it invents a
 *    description.** `C28` falls back to `SzH(body)`, which returns the first
 *    markdown heading (≤100 chars) of the body. The roster line then reads
 *    plausibly while triggering on nothing the author intended. That is worse
 *    than a silent drop, and making it visible is exactly why
 *    `parseSkillFrontmatter` degrades to a broken row instead of throwing.
 *
 * 3. **The roster is a fixed character budget and Acabox is already over it.**
 *    See ROSTER_* below.
 */

import * as yaml from 'js-yaml';

import { CLAUDE_DIR } from './paths';

// ---------------------------------------------------------------------------
// Store layout
// ---------------------------------------------------------------------------

/** The store, under `<userData>/<channel>/`. Survives workspace deletion. */
export const SKILLS_STORE_DIR = 'skills';

/**
 * The index. A separate file rather than a key in `cobuilding-settings.json`
 * because that file holds the `safeStorage`-encrypted API key and connector
 * headers — a skill edit must never be a reason to rewrite it.
 */
export const SKILLS_STATE_FILE = 'skills-state.json';

/**
 * Pre-revert forks. A *sibling* of the store, not inside it, so the render
 * never tries to link it.
 */
export const SKILLS_TRASH_DIR = 'skills-trash';

/**
 * Where the render lives: `<workspace>/.claude/skills/<id>`.
 *
 * Under the dot-directory deliberately. `containerService.syncWorkspaceSymlinks`
 * unlinks any workspace-ROOT symlink resolving outside the workspace, and skips
 * dot-prefixed names — a root-level `skills` link would be deleted on every
 * `containerService.start()`. It also keeps 255 skill files out of `FilesTab`'s
 * count, which hides only `.`-prefixed and `~$` entries.
 */
export const SKILLS_RENDER_SUBDIR = `${CLAUDE_DIR}/${SKILLS_STORE_DIR}`;

/**
 * Paths inside a skill that the HOST writes and the user does not own.
 * Excluded from the import baseline AND from the revert set, always.
 *
 * No imported skill ever ships a findings ledger, so there is never a
 * legitimate upstream version to reconcile. Without this rule a user who grew
 * sixty findings inside an imported skill and clicked `Revert` would lose them
 * behind a button whose label promises the opposite.
 */
export const HOST_OWNED_SKILL_PATHS = ['references/findings/**'];

/** Where `record_finding` writes, relative to the skill root. */
export const SKILL_FINDINGS_SUBDIR = 'references/findings';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A valid skill id — the directory name, and therefore the name the model
 * types into `Skill({skill})`.
 *
 * The Agent Skills spec's charset. The CLI is more tolerant (it sanitizes with
 * `.replace(/[^a-zA-Z0-9_-]/g, '-')`), but we validate rather than rewrite: an
 * id we silently changed would no longer match the directory on disk, and for
 * an imported skill it would register as a local modification against the
 * baseline on day one.
 */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SKILL_ID_MAX_LENGTH = 64;

export const SKILL_ID_RULE =
  'Use lowercase letters, numbers and single hyphens, e.g. my-lab-protocol.';

/** Spec cap on `description`. Longer than this and the roster line is a lie. */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

/**
 * Skills the SDK ships itself. Registered in the CLI binary via
 * `iA({name:…})` with `source:"bundled"`, discovered from nothing on disk, and
 * present in every session unless an `Options.skills` allowlist filters them
 * out. Enumerated from the binary rather than from docs — the design doc's
 * list of eight was missing `claude-in-chrome`, `dream` and `schedule`.
 *
 * Six load unconditionally (`batch`, `claude-api`, `debug`,
 * `fewer-permission-prompts`, `simplify`, `update-config`); the rest carry an
 * `isEnabled` gate we do not control. Listing all eleven costs nothing and
 * means a gate flipping on cannot quietly reintroduce one.
 *
 * They are reserved as store ids because the Skill tool resolves a name with
 * `Hh(name, commands)` — first match wins — so a store skill sharing a bundled
 * name would shadow it or be shadowed, unpredictably.
 */
export const BUNDLED_SDK_SKILLS = [
  'batch',
  'claude-api',
  'claude-in-chrome',
  'debug',
  'dream',
  'fewer-permission-prompts',
  'keybindings-help',
  'loop',
  'schedule',
  'simplify',
  'update-config',
] as const;

/**
 * The bundled skills Acabox keeps.
 *
 * `update-config`'s entire purpose is to get the agent to rewrite
 * `settings.json` — the file holding Acabox's install-blocking and
 * secret-blocking hooks — so suppressing it is a correctness fix, not tidying.
 * The rest are Claude-Code-harness ergonomics (`/debug`, `/loop`, `/schedule`)
 * that mean nothing inside Acabox and only spend roster budget.
 *
 * `claude-api` stays: a scientist debugging an Anthropic API call from a
 * mini-app is a real case, and it is the one bundled skill about the product
 * rather than about the CLI.
 */
export const BUNDLED_ALLOW: readonly string[] = ['claude-api'];

export const RESERVED_SKILL_IDS: readonly string[] = BUNDLED_SDK_SKILLS;

/** Why an id was refused, so the UI can say something specific. */
export type SkillIdProblem = 'empty' | 'too-long' | 'charset' | 'reserved';

export type SkillIdValidation =
  | { ok: true }
  | { ok: false; problem: SkillIdProblem; error: string };

/**
 * Validate a skill id. Returns the reason rather than a boolean because every
 * caller has to say something — the import path explains why a directory was
 * skipped, the create form puts it under the field.
 */
export function validateSkillId(id: string): SkillIdValidation {
  const trimmed = (id ?? '').trim();
  if (!trimmed) {
    return { ok: false, problem: 'empty', error: 'A name is required.' };
  }
  if (trimmed.length > SKILL_ID_MAX_LENGTH) {
    return {
      ok: false,
      problem: 'too-long',
      error: `"${trimmed}" is ${trimmed.length} characters; the limit is ${SKILL_ID_MAX_LENGTH}.`,
    };
  }
  if (!SKILL_ID_PATTERN.test(trimmed)) {
    return {
      ok: false,
      problem: 'charset',
      error: `Invalid name "${trimmed}". ${SKILL_ID_RULE}`,
    };
  }
  if (RESERVED_SKILL_IDS.includes(trimmed)) {
    return {
      ok: false,
      problem: 'reserved',
      error: `"${trimmed}" is the name of a skill the Claude Agent SDK ships. Pick another name.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Provenance and state
// ---------------------------------------------------------------------------

/**
 * Where a skill's bytes came from.
 *
 * - `builtin` — seeded from the read-only pristine tree that ships in the app
 *   bundle. Revertible, because there is something to revert to.
 * - `custom` — the user's or the agent's. No pristine counterpart, so
 *   `modified` is *undefined* rather than false: there is nothing to compare
 *   against and a chip either way would be a fabrication.
 * - `imported` — fetched from a pinned commit elsewhere.
 */
export type SkillOrigin = 'builtin' | 'custom' | 'imported';

export type SkillSourceKind = 'github-subdir' | 'local-folder';

/**
 * The provenance record for an imported skill. Written once at import and
 * never inferred afterwards.
 *
 * `sha` is always a resolved 40-character commit SHA, never a branch ref — a
 * pin is meaningless otherwise, and the update check recomputes git blob SHAs
 * against it.
 */
export interface SkillSource {
  kind: SkillSourceKind;
  /** github-subdir. */
  owner?: string;
  repo?: string;
  /** The ref the user pasted, kept for display only. */
  ref?: string;
  /** Resolved 40-char commit SHA. This, not `ref`, is the pin. */
  sha?: string;
  /** Path of the skill directory inside the repo. */
  subpath?: string;
  /** Canonical https URL to the exact tree, for the row's hyperlink. */
  url?: string;
  /** local-folder: the absolute path the copy was taken from. */
  localPath?: string;
}

/** Frontmatter as it was at import, so the UI can show a declared alias. */
export interface SkillDeclaredMetadata {
  name?: string;
  description?: string;
  license?: string;
}

export interface SkillStateEntry {
  origin: SkillOrigin;
  /**
   * On the roster. See `buildSkillRuntimeConfig` — this is the budget
   * allocator, not a sandbox. A disabled skill keeps its bytes and its
   * symlink; it just stops costing roster characters.
   */
  enabled: boolean;
  /**
   * A built-in the user removed. The entry survives so the seeder does not
   * immediately re-seed it and so a restore can bring it back.
   */
  removed?: boolean;
  createdAt?: string;
  /**
   * A built-in that upstream dropped while the user had edits. Retagged
   * `custom` and flagged, because Anthropic dropping a skill from our tree is
   * not consent to delete the user's work.
   */
  formerlyBuiltin?: boolean;

  /**
   * relPath -> sha256 of the bytes we last wrote. Answers "have I changed it".
   * Absent for `custom` — nothing to compare against.
   */
  baseline?: Record<string, string>;
  /** relPath -> the upstream hash the user chose to keep theirs over. */
  dismissed?: Record<string, string>;
  /**
   * relPath -> the pristine hash that collided with a local edit at the last
   * reconcile. This is the whole `UPDATE AVAILABLE` chip, and it has to be
   * persisted rather than recomputed: once the shipped file changes, the bytes
   * the baseline was taken from are gone, so "there was a conflict here" is no
   * longer derivable from the three hashes alone.
   *
   * Cleared by `revertFile` (take the new version) and by `dismissFileUpdate`
   * (keep mine, which records `dismissed[rel]` so the chip does not come back
   * until the NEXT release changes that file again).
   */
  updateAvailable?: Record<string, string>;

  // --- import provenance ---------------------------------------------------
  source?: SkillSource;
  importedAt?: string;
  importedVia?: 'ui' | 'agent';
  /** Marketplace/catalogue name, or 'direct'. */
  importedFrom?: string;
  upstreamTreeSha?: string;
  /**
   * relPath -> git blob SHA at the pinned commit. Answers "has upstream
   * changed". Deliberately a SECOND hash set alongside `baseline`: two
   * questions, two answers, which is what lets the user take an upstream fix
   * to one file while keeping their own edits to another.
   */
  upstreamBlobs?: Record<string, string>;
  declared?: SkillDeclaredMetadata;
  /** Frontmatter `name` disagrees with the directory name. Display only. */
  aliasOfDirName?: boolean;
  fileCount?: number;
  /** Files with the exec bit — stated to the user before they commit. */
  execCount?: number;
  /** Defaults to HOST_OWNED_SKILL_PATHS. Never baselined, never reverted. */
  hostOwnedPaths?: string[];
}

export interface SkillsState {
  version: number;
  /** App version whose pristine tree last seeded the store. */
  seededAppVersion?: string;
  /**
   * `hashTree()` of the pristine tree. Reconcile runs when either this or
   * `seededAppVersion` moves — the hash clause is what makes a dev `git pull`
   * behave identically to a release.
   */
  pristineRootHash?: string;
  skills: Record<string, SkillStateEntry>;
}

export const SKILLS_STATE_VERSION = 1;

export function emptySkillsState(): SkillsState {
  return { version: SKILLS_STATE_VERSION, skills: {} };
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * The CLI's own frontmatter delimiter (`nbH` in the binary), copied exactly.
 *
 * Note it does NOT anchor the closing `---` to a line start, and `\s*` after
 * the opening fence swallows newlines. A stricter regex would be tidier and
 * WRONG: this surface exists to show the user what the CLI sees, so a row that
 * reads BROKEN here while the CLI loads it fine (or the reverse) is the one
 * failure mode that makes the whole page untrustworthy.
 */
const FRONTMATTER_DELIMITER = /^---\s*\n([\s\S]*?)---\s*\n?/;

export interface SkillFrontmatter {
  /** False means the block is missing or unparseable — render a broken row. */
  ok: boolean;
  /** Frontmatter `name`. A DISPLAY alias; identity is the directory name. */
  name?: string;
  /** Trimmed, matching the CLI's `gb()`. This is what the roster line costs. */
  description?: string;
  /**
   * Frontmatter `when_to_use`. Not in the design doc's field list, but the CLI
   * concatenates it into the roster line (`gK8`: `${description} - ${whenToUse}`),
   * so the roster arithmetic is wrong without it.
   */
  whenToUse?: string;
  license?: string;
  source?: string;
  /** Spec-legal string map. Non-scalar values are dropped, not stringified. */
  metadata?: Record<string, string>;
  /** The whole parsed block, for fields no one has needed yet. */
  raw?: Record<string, unknown>;
  /** Present when `ok` is false. Shown on the broken row. */
  error?: string;
}

/**
 * The CLI's YAML repair pass (`Qk1`), which runs only after a strict parse
 * throws: re-quote single-line `key: value` pairs whose value contains a
 * YAML-special character. Replicated so our verdict matches the CLI's — a
 * false "broken frontmatter" badge on a skill that loads fine is exactly the
 * kind of lie this surface must not tell.
 */
const YAML_SPECIAL = /[{}[\]*&#!|>%@`]|: /;

function repairYaml(block: string): string {
  return block
    .split('\n')
    .map((line) => {
      const m = line.match(/^([a-zA-Z_-]+):\s+(.+)$/);
      if (!m) return line;
      const [, key, value] = m;
      if (!key || !value) return line;
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (quoted) return line;
      if (!YAML_SPECIAL.test(value)) return line;
      // (`replaceAll` is ES2021; this project targets ES2020.)
      return `${key}: "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    })
    .join('\n');
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const s = asTrimmedString(v);
    if (s !== undefined) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Read a `SKILL.md`'s frontmatter. NEVER throws.
 *
 * Uses js-yaml because descriptions are multi-line block scalars. A regex
 * attempt during the research for this feature silently truncated every folded
 * scalar and under-reported the roster by 55% (4,594 chars against a real
 * 10,201) — which is the whole reason `js-yaml` is now a declared dependency
 * rather than a transitive one.
 *
 * A malformed file degrades to `{ ok: false, error }` so the caller can render
 * a visible broken row. The CLI does something worse than dropping it: it
 * loads the skill with a description synthesized from the first heading of the
 * body, so the roster line reads plausibly and triggers on nothing the author
 * intended. Making that visible is the point of the row.
 */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return { ok: false, error: 'SKILL.md is empty.' };
  }

  const match = markdown.match(FRONTMATTER_DELIMITER);
  if (!match) {
    return { ok: false, error: 'No YAML frontmatter block (a --- fenced header) at the top of the file.' };
  }

  const block = match[1] ?? '';
  let parsed: unknown;
  try {
    parsed = yaml.load(block);
  } catch (strictErr) {
    try {
      parsed = yaml.load(repairYaml(block));
    } catch {
      const message = strictErr instanceof Error ? strictErr.message : String(strictErr);
      return { ok: false, error: `Frontmatter is not valid YAML: ${message}` };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Frontmatter is not a set of key/value pairs.' };
  }

  const raw = parsed as Record<string, unknown>;
  return {
    ok: true,
    name: asTrimmedString(raw.name),
    // Trimmed to match the CLI's `gb()`, which does `H.trim() || null`. Every
    // shipped description is a `>` folded scalar and therefore carries a
    // trailing newline the model never sees.
    description: asTrimmedString(raw.description),
    whenToUse: asTrimmedString(raw.when_to_use),
    license: asTrimmedString(raw.license),
    source: asTrimmedString(raw.source),
    metadata: asStringMap(raw.metadata),
    raw,
  };
}

// ---------------------------------------------------------------------------
// The renderer-facing shape
// ---------------------------------------------------------------------------

/**
 * One row on the Knowledge page. Every optional field is optional because it
 * is genuinely absent sometimes — render nothing rather than a fabricated
 * "Unknown", the rule `ConnectorsSettings` already follows.
 */
export interface SkillDescriptor {
  /** Directory name in the store. The identity the CLI uses. */
  id: string;
  origin: SkillOrigin;
  enabled: boolean;
  /** Absolute path in the store, for Reveal in Finder and the detail header. */
  storePath: string;

  /** Frontmatter `name` when it differs from `id`. A declared alias only. */
  declaredName?: string;
  description?: string;
  whenToUse?: string;
  /** Displayed verbatim when present; informational, never a gate. */
  license?: string;
  source?: string;

  /** False renders the row by directory name with the parse error attached. */
  frontmatterOk: boolean;
  frontmatterError?: string;

  /** Bytes of SKILL.md — the cost paid on every activation. */
  skillMdBytes: number;
  fileCount: number;
  /** Files with the exec bit. Stated, never hidden. */
  execCount: number;
  /** mtime of the newest file in the skill dir, ms since epoch. */
  changedAt?: number;

  /** Import provenance, absent for builtin and custom. */
  provenance?: SkillSource;
  importedAt?: string;

  /**
   * Any file's hash differs from its baseline. UNDEFINED for a custom skill —
   * there is no pristine counterpart, so both true and false would be a claim
   * we cannot support.
   */
  modified?: boolean;
  removed?: boolean;

  /** Active rows in `references/findings/index.md`, when the skill has one. */
  findingsCount?: number;
}

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------

/**
 * The `Options.skills` array handed to the SDK.
 *
 * WHAT THIS RETURNS, AND WHY IT IS THE ENABLED SUBSET
 * ---------------------------------------------------
 * Only enabled, non-removed store ids, plus BUNDLED_ALLOW.
 *
 * An earlier draft (`docs/design/skills-plugins-connectors.md`) passed *every*
 * store id, enabled or not, on the theory that enablement would be enforced by
 * the symlink's absence from the render. `docs/design/skills-knowledge-loop.md`
 * supersedes that, and it is right: the roster is a fixed character budget and
 * Acabox is already over it, so enable/disable has to be the budget allocator
 * rather than a second disk-level mechanism. Verified in the CLI binary that
 * this option is the lever — the listing builder applies
 * `r2H(commands, sessionSkillAllowlist)` before formatting, so an id omitted
 * here costs zero roster characters.
 *
 * The consequence `skillRender` MUST match: a disabled skill still gets its
 * symlink. It keeps every byte, stays readable by an explicit `Read`, and only
 * stops appearing in the roster. Do not "optimise" the render to skip disabled
 * skills — that would make a disable irreversible mid-session and would break
 * the ledger paths of a skill the user re-enables.
 *
 * Two more measured facts a caller needs:
 *
 * - **Do not also add `Skill` or `Skill(<id>)` to `allowedTools`.** The SDK
 *   does it: `skills.map(t => \`Skill(${t})\`)` is unioned into `allowedTools`
 *   inside `query()`. Bare `'Skill'` must be REMOVED from
 *   `AgentInfrastructureController`'s list when this starts being passed,
 *   or it re-approves everything the allowlist just filtered.
 * - **The result is never empty**, and that matters: `Options.skills`
 *   undefined means "load every discovered skill", while `[]` means "load
 *   none" and would make every `Skill()` call fail with `errorCode: 8`.
 *   BUNDLED_ALLOW guarantees at least one entry, so the two cases can never be
 *   confused by an empty store.
 *
 * Deterministically ordered so the live agent-server config and the config the
 * host would replay after a crash restart compute an identical array. Those
 * two disagreeing is a bug this codebase has already shipped once, with
 * connectors.
 */
export function buildSkillRuntimeConfig(state: SkillsState): string[] {
  const storeIds = Object.entries(state.skills ?? {})
    .filter(([, entry]) => entry.enabled && !entry.removed)
    .map(([id]) => id)
    .sort();

  const seen = new Set(storeIds);
  const bundled = [...BUNDLED_ALLOW].sort().filter((id) => !seen.has(id));
  return [...storeIds, ...bundled];
}

// ---------------------------------------------------------------------------
// Roster budget
// ---------------------------------------------------------------------------

/**
 * The skill roster — one `- name: description` line per enabled skill — is
 * injected into the system prompt once per session and is the ONLY thing about
 * a skill that is always in context. It is capped in characters, and when the
 * cap binds the CLI shortens descriptions silently, with no error and no log
 * line. The observable symptom is a skill that stops activating.
 *
 * Constants below are the CLI's own, read out of the binary
 * (`dU9`/`cU9`/`iU1`/`rU1`/`dK8` in the same `var` statement as `o5_`):
 *
 *   budget = SLASH_COMMAND_TOOL_CHAR_BUDGET (env, wins unconditionally)
 *          | contextTokens * 4 * fraction              (context known)
 *          | 8000 * (fraction / 0.01)                  (context unknown)
 */

/** `cU9` — characters per token, the CLI's own conversion. */
export const ROSTER_CHARS_PER_TOKEN = 4;

/** `dU9` — default `skillListingBudgetFraction`, 1% of the window. */
export const ROSTER_DEFAULT_BUDGET_FRACTION = 0.01;

/** `iU1` — the budget base used when the context size is not known. */
export const ROSTER_FALLBACK_BUDGET_CHARS = 8000;

/** `rU1` — default `skillListingMaxDescChars`, the per-skill description cap. */
export const ROSTER_DEFAULT_MAX_DESC_CHARS = 1536;

/**
 * `dK8` — if the per-skill share falls below this the CLI abandons
 * descriptions entirely and emits bare `- name` lines. That is the collapse
 * an unbounded import would cause, and it is silent.
 */
export const ROSTER_MIN_DESC_CHARS = 20;

/**
 * What Acabox sets `skillListingBudgetFraction` to.
 *
 * At `claude-opus-5` (200,000 tokens) the 1% default is 8,000 characters and
 * the 21 shipped skills already need ~10,600 — roughly half were being
 * truncated before a single import. 5% is 40,000 characters, which leaves
 * headroom for imports without pretending the budget is free: it is context
 * paid on every turn of every conversation.
 */
export const ACABOX_ROSTER_BUDGET_FRACTION = 0.05;

/** Context window of the models Acabox sends, for the budget arithmetic. */
export const ROSTER_CONTEXT_TOKENS_DEFAULT = 200_000;

export interface RosterBudgetOptions {
  /** Model context window. Omit to use the CLI's context-unknown fallback. */
  contextTokens?: number;
  /** `skillListingBudgetFraction`. Defaults to the CLI's 1%. */
  fraction?: number;
  /**
   * `SLASH_COMMAND_TOOL_CHAR_BUDGET`. The CLI checks this FIRST and
   * unconditionally, so it overrides both of the above.
   */
  envBudgetChars?: number;
}

/** The roster's character budget, computed exactly as `o5_()` does. */
export function rosterBudgetChars(opts: RosterBudgetOptions = {}): number {
  const env = opts.envBudgetChars;
  if (env !== undefined && Number.isFinite(env) && env > 0) return Math.floor(env);

  const fraction = opts.fraction ?? ROSTER_DEFAULT_BUDGET_FRACTION;
  const raw =
    opts.contextTokens && opts.contextTokens > 0
      ? opts.contextTokens * ROSTER_CHARS_PER_TOKEN * fraction
      : ROSTER_FALLBACK_BUDGET_CHARS * (fraction / ROSTER_DEFAULT_BUDGET_FRACTION);
  return Math.max(1, Math.floor(raw));
}

/** The minimum a caller must supply to price a roster line. */
export interface RosterEntry {
  id: string;
  description?: string;
  whenToUse?: string;
}

/**
 * The listing text for one skill, exactly as the CLI builds it: `gK8()`
 * concatenates `when_to_use` onto the description with " - ", `cK8()` caps the
 * result at `skillListingMaxDescChars` with a single-character ellipsis, and
 * `aU1()` wraps it as `- name: desc`.
 */
export function rosterLine(
  entry: RosterEntry,
  maxDescChars: number = ROSTER_DEFAULT_MAX_DESC_CHARS,
): string {
  const description = entry.description ?? '';
  const full = entry.whenToUse ? `${description} - ${entry.whenToUse}` : description;
  const capped = full.length > maxDescChars ? `${full.slice(0, maxDescChars - 1)}…` : full;
  return `- ${entry.id}: ${capped}`;
}

export interface RosterUsage {
  /** Number of skills priced. */
  entries: number;
  /** Characters the listing occupies, joined by newlines, as `lU9` counts. */
  chars: number;
  budget: number;
  fits: boolean;
  /** Ids whose own description exceeded `maxDescChars` before any squeeze. */
  descCappedIds: string[];
}

/**
 * Measure a roster. Real arithmetic over real descriptions — this is what lets
 * the Knowledge page show a measured figure instead of an estimate.
 *
 * It is needed even though the SDK exposes `getContextUsage().skills`, because
 * that does not answer this question. Read out of the binary (`nx5`):
 * `totalSkills` is every discovered skill and `includedSkills` is the count
 * surviving the `Options.skills` allowlist. Neither one moves when a
 * description is truncated, so `includedSkills === totalSkills` is a statement
 * about the allowlist and says nothing about the budget. (The CLI's own
 * truncation verdict, `budgetMode` / `budgetTruncatedSkills`, is not exposed
 * through the SDK at all.) `getContextUsage().skills.skillFrontmatter[].tokens`
 * IS real per-skill cost and is the right thing to show beside this.
 *
 * Counted with `String.length`, matching the CLI's own reporting path.
 */
export function computeRosterUsage(
  entries: readonly RosterEntry[],
  opts: RosterBudgetOptions & { maxDescChars?: number } = {},
): RosterUsage {
  const maxDescChars = opts.maxDescChars ?? ROSTER_DEFAULT_MAX_DESC_CHARS;
  const descCappedIds: string[] = [];
  let chars = 0;

  for (const entry of entries) {
    const description = entry.description ?? '';
    const full = entry.whenToUse ? `${description} - ${entry.whenToUse}` : description;
    if (full.length > maxDescChars) descCappedIds.push(entry.id);
    chars += 2 + entry.id.length + 2 + Math.min(full.length, maxDescChars);
  }
  // The lines are joined with newlines, so N lines cost N-1 separators.
  if (entries.length > 0) chars += entries.length - 1;

  const budget = rosterBudgetChars(opts);
  return { entries: entries.length, chars, budget, fits: chars <= budget, descCappedIds };
}
