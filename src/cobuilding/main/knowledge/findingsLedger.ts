import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import log from 'electron-log';

import { SKILL_FINDINGS_SUBDIR } from '../../shared/skills';
import { getSkillsStoreDir } from '../skillStore';

/**
 * The findings ledger — where a discovery goes so the next session does not
 * have to make it again.
 *
 * The evidence this exists to fix: on 2026-07-29 one session announced "three
 * corrections to your handoff doc, all found the hard way". Two reached agent
 * memory, one reached nothing but a code comment inside a mini-app that
 * `miniApps:delete` would remove, and six on-disk locations — two of them
 * executable `.sql` files — still asserted the falsified rule. The loop already
 * runs; it runs partially, unreliably, and into the wrong container.
 *
 * THE ONE INVARIANT THIS MODULE IS BUILT AROUND
 * ---------------------------------------------
 * **A write is never refused.** Not on similarity, not on validation, not on a
 * missing field. The earlier design refused on a trigram-Jaccard hit ≥ 0.6, and
 * two measurements killed it: on realistic rephrasings the score is 0.118–0.184
 * so it never fires, and when it *does* fire it fires on CORRECTIONS — which are
 * by construction lexically near-identical to what they correct. "Group the
 * dedupe on content_hash" and "content_hash is not a hash of content; group on
 * MD5(content)" share every distinctive token, so the deduper would have thrown
 * away the single most valuable discovery of that day and kept the wrong entry.
 * Everything below therefore sanitizes rather than rejects: a too-long title is
 * truncated, a missing rule falls back to the title, an unusable skill name is
 * slugified. Relation detection is a separate, later, non-blocking step.
 *
 * WHY THE HOST WRITES AND THE MODEL DOES NOT
 * ------------------------------------------
 * `Edit` requires a prior `Read`, so appending one line to a 40 KB ledger costs
 * 40 KB of context; a tool call costs the arguments. The host also stamps the
 * session and date with zero model cooperation, and — the part no instruction
 * can match — runs the blast-radius grep, which is the field a model under time
 * pressure skips.
 *
 * EVERYTHING IS SYNCHRONOUS, DELIBERATELY
 * ---------------------------------------
 * Every function here is read-modify-write over the same handful of files, and
 * two `record_finding` calls can be in flight in one turn. Staying synchronous
 * inside the single-threaded main process is the whole concurrency guard: no
 * `await` means no interleaving, so no torn ledger. Do not "modernise" these to
 * `fs.promises` without adding a queue (see `manifestIO.ts` for what that costs
 * and why it had to be written).
 */

// ---------------------------------------------------------------------------
// Layout and limits
// ---------------------------------------------------------------------------

/** Host-maintained, ≤ DIGEST_MAX_BYTES. The one file `SKILL.md` routes to. */
export const DIGEST_FILE = 'digest.md';
/** Derived: one row per ACTIVE finding. */
export const INDEX_FILE = 'index.md';
/** Derived: one row per superseded finding. Auditable, off the read path. */
export const INDEX_ARCHIVE_FILE = 'index-archive.md';

/**
 * A bucket file shards at 32 KB. Layer 3 of the context bound: the model reads
 * `index.md` plus at most one or two buckets, so the ceiling on what one task
 * can pull in is a number we choose rather than however big the ledger grew.
 */
export const BUCKET_SHARD_BYTES = 32 * 1024;

/**
 * An index row is hard-capped. `index.md` is read whole; a row that wraps to
 * three lines because someone pasted a paragraph into `rule` costs every future
 * reader. The `rule` cell absorbs the cap — it is the only free-text column.
 */
export const INDEX_ROW_MAX_CHARS = 120;

/** The digest is loaded on every activation of a ledger-bearing skill. */
export const DIGEST_MAX_BYTES = 2048;
export const DIGEST_MAX_ENTRIES = 15;
export const DIGEST_LINE_MAX_CHARS = 160;

export const TITLE_MAX_CHARS = 80;

/** Bucket used when a finding declares no scope. */
export const DEFAULT_BUCKET = 'general';

/** Files in the findings dir that are DERIVED and rewritten on every record. */
const DERIVED_FILES = new Set([DIGEST_FILE, INDEX_FILE, INDEX_ARCHIVE_FILE]);

const HOST_BANNER =
  '<!-- Maintained by Acabox. Regenerated on every record_finding; hand edits here are lost. -->';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingStatus = 'active' | 'superseded';

/**
 * The machine-readable half of an entry, carried in a single
 * `<!-- acabox:meta {...} -->` comment.
 *
 * A comment rather than per-entry YAML frontmatter because a bucket file holds
 * many entries and markdown allows exactly one frontmatter block. One JSON
 * object on one line also means the meta can be rewritten (status flip,
 * `last_read` bump) with a regex replace instead of a parser round-trip that
 * would reformat the human-authored prose around it.
 */
export interface FindingMeta {
  id: string;
  status: FindingStatus;
  /** YYYY-MM-DD, local time — the user's day, not UTC's. */
  recorded: string;
  /**
   * Bumped when ANY finding in the same bucket file is read. Bucket
   * granularity, and every surface showing it must say so — see
   * `LAST_READ_GRANULARITY_NOTE`.
   */
  last_read?: string;
  /** SDK session id of the turn that recorded it, when the caller knows it. */
  session?: string;
  scope?: string[];
  supersedes?: string[];
  superseded_by?: string;
  confirms?: string[];
  /** Base bucket name (no shard suffix, no extension). */
  bucket: string;
}

export interface Finding {
  meta: FindingMeta;
  title: string;
  /** The `**Rule.**` sentence — what the index row and digest line carry. */
  rule: string;
  /** The whole block: heading, meta comment, body. */
  block: string;
  /** Shard file it currently lives in, e.g. `messages.md`. */
  file: string;
}

export interface LedgerSnapshot {
  skill: string;
  /** Absolute path of `<store>/<skill>/references/findings`. */
  dir: string;
  /** False when the skill has no ledger at all — distinct from an empty one. */
  exists: boolean;
  active: Finding[];
  archived: Finding[];
  /** Total bytes of every file in the findings dir. */
  bytes: number;
}

export interface RecordFindingInput {
  /** Store skill id that owns the domain. Sanitized, never rejected. */
  skill: string;
  title: string;
  /** What to do differently. The only field the index row and digest carry. */
  rule: string;
  /** What was measured. */
  evidence: string;
  cost_if_unknown?: string;
  /** Tables/systems. Drives bucketing; `scope[0]` names the bucket. */
  scope?: string[];
  /** Ids this finding replaces. Triggers the supersession move + the grep. */
  supersedes?: string[];
  confirms?: string[];
  /** Model-supplied extra locations. Merged with the host's grep hits. */
  blast_radius?: string[];
}

export interface RecordFindingResult {
  id: string;
  /** Base bucket name; `file` is the shard actually written. */
  bucket: string;
  file: string;
  /** Active findings in this skill's ledger after the write. */
  entry_count: number;
  ledger_bytes: number;
  /** Ids actually moved to the archive (an unknown id is reported, not thrown). */
  superseded?: string[];
  /** Ids in `supersedes` that named nothing — surfaced, never fatal. */
  supersedes_not_found?: string[];
  /** The lines written into "Also written down, may still be wrong". */
  blast_radius?: string[];
  /** True when the named skill had no directory and one was created. */
  skill_created?: boolean;
}

/**
 * Freshness is per bucket FILE, not per finding: what the host can observe is
 * "the model read `messages.md`", and claiming to know which of the nine
 * entries in it were actually used would be a fabrication. Any UI showing a
 * last-read date must say this, in these terms.
 */
export const LAST_READ_GRANULARITY_NOTE =
  'Last read is tracked per bucket file — reading any finding in a file marks every finding in it.';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `<userData>/<channel>/skills` — userData already carries the channel.
 *
 * Delegates to `skillStore` rather than rebuilding the path. Two resolvers for
 * one directory is the divergence class that already cost this codebase a day
 * over `allowedTools` vs `mcpServers`; if the store ever moves, the ledger has
 * to move with it or every finding lands somewhere nothing reads.
 */
export function skillsStoreRoot(): string {
  return getSkillsStoreDir();
}

/**
 * Make an arbitrary caller-supplied string safe to use as a directory name.
 *
 * This is path safety, NOT validation — a `skill` of `../../etc` must not
 * escape the store, but a merely ugly name must still get its write. That is
 * why this slugifies instead of calling `validateSkillId` and refusing.
 */
function safeSkillId(skill: string): string {
  const slug = String(skill ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'unfiled';
}

export function findingsDirFor(skill: string): string {
  return path.join(skillsStoreRoot(), safeSkillId(skill), SKILL_FINDINGS_SUBDIR);
}

// ---------------------------------------------------------------------------
// Small file helpers
// ---------------------------------------------------------------------------

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Temp file + rename. A ledger is appended to mid-turn while the model may be
 * `Read`ing it in the same turn; `writeFileSync` truncates in place, so a
 * reader can catch a half-written bucket and act on a mangled rule. The same
 * failure `manifestIO` was written for, one directory over.
 */
function writeTextAtomic(file: string, content: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * `realpath`, or the input when it does not resolve. Every path comparison here
 * has to survive a symlink: the store is reached through
 * `<workspace>/.claude/skills/<id>` at runtime, and on macOS even `/tmp` is a
 * link to `/private/tmp`. Comparing unresolved paths silently answers "not
 * ours" for paths that are.
 */
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** YYYY-MM-DD in LOCAL time — the day the user experienced, not UTC's. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function oneLine(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

// ---------------------------------------------------------------------------
// Bucket and shard naming
// ---------------------------------------------------------------------------

/**
 * Bucket name from `scope[0]`.
 *
 * A leading schema qualifier is dropped (`public.users` → `users`) because
 * every table in the warehouse carries the same one and it would make every
 * bucket name start with the same eight characters.
 *
 * The two trailing-suffix strips are not cosmetic: `<base>-2.md` is how a shard
 * is named and `<base>-archive.md` is how an archive is named, so a scope
 * literally called `users-2` or `users-archive` would produce a bucket whose
 * files collide with another bucket's shards. Stripping makes the collision
 * impossible rather than unlikely.
 */
export function bucketNameFor(scope: readonly string[] | undefined): string {
  const first = (scope ?? []).map((s) => String(s ?? '').trim()).find(Boolean);
  if (!first) return DEFAULT_BUCKET;
  const withoutSchema = first.includes('.') ? first.slice(first.lastIndexOf('.') + 1) : first;
  const slug = withoutSchema
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-archive$/, '')
    .replace(/-\d+$/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || DEFAULT_BUCKET;
}

function isArchiveFile(name: string): boolean {
  return /-archive(-\d+)?\.md$/.test(name);
}

function shardName(base: string, index: number): string {
  return index <= 1 ? `${base}.md` : `${base}-${index}.md`;
}

/** Existing shards of `base`, as [index, filename], ascending. */
function shardsOf(dir: string, base: string): Array<[number, string]> {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}(?:-(\\d+))?\\.md$`);
  const out: Array<[number, string]> = [];
  for (const name of listMarkdown(dir)) {
    const m = name.match(re);
    if (!m) continue;
    out.push([m[1] ? Number(m[1]) : 1, name]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Which shard of `base` an entry of `addBytes` should be appended to.
 *
 * An entry is never split across shards, so a single entry larger than the
 * limit lands whole in an empty shard and that shard ends up oversized. That is
 * the right trade: half a rule is worse than a big file.
 */
function shardForAppend(dir: string, base: string, addBytes: number): string {
  const shards = shardsOf(dir, base);
  if (shards.length === 0) return shardName(base, 1);
  const [lastIndex, lastName] = shards[shards.length - 1];
  const current = sizeOf(path.join(dir, lastName));
  if (current > 0 && current + addBytes > BUCKET_SHARD_BYTES) {
    return shardName(base, lastIndex + 1);
  }
  return lastName;
}

function listMarkdown(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Entry parsing and serialization
// ---------------------------------------------------------------------------

const META_RE = /<!--\s*acabox:meta\s*([\s\S]*?)\s*-->/;
const HEADING_RE = /^###\s+(\S+)\s+·\s+([\s\S]*?)\s*$/m;

/**
 * `String.replace` interprets `$&`, `` $` `` and `$1` inside the REPLACEMENT.
 * Every replacement in this file is data — a rule the user wrote, a serialized
 * meta comment — so a title containing `$&` would silently corrupt the ledger
 * on the next rewrite. A function replacer is taken literally; use this
 * everywhere rather than remembering the rule at each call site.
 */
function replaceLiteral(haystack: string, needle: string | RegExp, replacement: string): string {
  return haystack.replace(needle as string, () => replacement);
}

function serializeMeta(meta: FindingMeta): string {
  // One line. A pretty-printed object would still parse, but the rewrite paths
  // (`last_read` bump, status flip) replace the whole comment, and a one-line
  // form keeps those diffs to one line in the user's own `git diff` of the store.
  return `<!-- acabox:meta ${JSON.stringify(meta)} -->`;
}

function parseMeta(block: string): FindingMeta | null {
  const m = block.match(META_RE);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]) as Partial<FindingMeta>;
    if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
    return {
      id: raw.id,
      status: raw.status === 'superseded' ? 'superseded' : 'active',
      recorded: typeof raw.recorded === 'string' ? raw.recorded : '',
      last_read: typeof raw.last_read === 'string' ? raw.last_read : undefined,
      session: typeof raw.session === 'string' ? raw.session : undefined,
      scope: Array.isArray(raw.scope) ? raw.scope.map(String) : undefined,
      supersedes: Array.isArray(raw.supersedes) ? raw.supersedes.map(String) : undefined,
      superseded_by: typeof raw.superseded_by === 'string' ? raw.superseded_by : undefined,
      confirms: Array.isArray(raw.confirms) ? raw.confirms.map(String) : undefined,
      bucket: typeof raw.bucket === 'string' && raw.bucket ? raw.bucket : DEFAULT_BUCKET,
    };
  } catch {
    // A hand-mangled meta comment loses the entry from the derived files but
    // never loses the bytes — the block stays in the bucket where a human can
    // read it. Silent data loss is the one outcome not on the table.
    return null;
  }
}

function ruleOf(block: string): string {
  const m = block.match(/^\*\*Rule\.\*\*\s*([\s\S]*?)(?=\n\s*\n|\n\*\*|$)/m);
  return oneLine(m ? m[1] : '');
}

/** Split a bucket file into entry blocks. Text before the first `###` is the
 *  file's own header and is not an entry; a one-line supersession stub does not
 *  start with `###` either, so it is skipped by construction. */
function parseEntries(fileName: string, content: string): Finding[] {
  const chunks = content.split(/^(?=###\s)/m);
  const out: Finding[] = [];
  for (const chunk of chunks) {
    if (!/^###\s/.test(chunk)) continue;
    const meta = parseMeta(chunk);
    if (!meta) continue;
    const h = chunk.match(HEADING_RE);
    out.push({
      meta,
      title: h ? oneLine(h[2]) : meta.id,
      rule: ruleOf(chunk),
      block: chunk.replace(/\s+$/, ''),
      file: fileName,
    });
  }
  return out;
}

function idNumber(id: string): number {
  const m = /(\d+)\s*$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function formatId(n: number): string {
  return `F-${String(n).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

/**
 * Every entry a skill's ledger holds, active and archived.
 *
 * The bucket files are the single source of truth; `index.md`, `index-archive.md`
 * and `digest.md` are derived from this on every write. That is why they can
 * never drift out of agreement with the bodies — there is nothing to keep in
 * sync, only something to regenerate.
 */
export function readLedger(skill: string): LedgerSnapshot {
  const dir = findingsDirFor(skill);
  const names = listMarkdown(dir);
  const exists = fs.existsSync(dir);
  const active: Finding[] = [];
  const archived: Finding[] = [];
  let bytes = 0;

  for (const name of names) {
    bytes += sizeOf(path.join(dir, name));
    if (DERIVED_FILES.has(name)) continue;
    const entries = parseEntries(name, readText(path.join(dir, name)));
    for (const e of entries) {
      if (e.meta.status === 'superseded' || isArchiveFile(name)) archived.push(e);
      else active.push(e);
    }
  }

  const byId = (a: Finding, b: Finding) => idNumber(a.meta.id) - idNumber(b.meta.id);
  return { skill: safeSkillId(skill), dir, exists, active: active.sort(byId), archived: archived.sort(byId), bytes };
}

/**
 * Active findings, or undefined when the skill has no ledger. Undefined and 0
 * are different answers — "no ledger" and "an empty ledger" must not render the
 * same chip.
 */
export function countActiveFindings(skill: string): number | undefined {
  const snapshot = readLedger(skill);
  return snapshot.exists ? snapshot.active.length : undefined;
}

// ---------------------------------------------------------------------------
// Blast radius — the host's contribution
// ---------------------------------------------------------------------------

export interface BlastRadiusHit {
  /** Path as displayed: relative to the search root it was found under. */
  display: string;
  absPath: string;
  lines: number[];
  /** Exec bit set, or a file type that is run rather than read. */
  executable: boolean;
}

/** Cap per file and overall so one common word cannot produce a 900-line entry. */
const BLAST_MAX_MATCHES_PER_FILE = 20;
const BLAST_MAX_FILES = 40;
const BLAST_GREP_TIMEOUT_MS = 10_000;

/**
 * A file that is *run* rather than read. The distinction is the whole point of
 * the field: a stale sentence in a handoff note misleads a reader, a stale
 * predicate in a `.sql` file silently returns the wrong number to whoever
 * executes it — which is exactly what happened with `content_hash`.
 */
const RUNNABLE_EXTENSIONS = new Set(['.sql', '.sh', '.py', '.r', '.js', '.mjs', '.ts', '.rb']);

const TOKEN_STOPWORDS = new Set([
  'always', 'because', 'before', 'better', 'cannot', 'change', 'column', 'instead',
  'matter', 'moment', 'nothing', 'number', 'others', 'result', 'return', 'returns',
  'should', 'silent', 'silently', 'simple', 'something', 'system', 'through', 'value',
  'values', 'without', 'wrong', 'query', 'queries', 'record', 'records',
]);

/**
 * The rarest-looking identifier in a piece of text — what to grep the workspace
 * for when a belief is superseded.
 *
 * An identifier carrying `_` or `.` wins outright: `content_hash`,
 * `co_scientist_sessions`, `public.users`. Those are the tokens a stale copy of
 * the old belief is guaranteed to contain and an unrelated document is not.
 * Ordinary long words are the fallback, and common ones are excluded because a
 * grep for "silently" over a research folder returns noise, not a checklist.
 */
export function distinctiveToken(text: string): string | null {
  const tokens = (String(text ?? '').match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [])
    // A sentence-ending period is part of the match but not part of the name.
    .map((t) => t.replace(/\.+$/, ''))
    .filter(Boolean);
  const identifiers = tokens.filter((t) => /[_.]/.test(t) && t.length >= 5);
  if (identifiers.length > 0) {
    return identifiers.sort((a, b) => b.length - a.length)[0];
  }
  const words = tokens.filter((t) => t.length >= 6 && !TOKEN_STOPWORDS.has(t.toLowerCase()));
  if (words.length > 0) return words.sort((a, b) => b.length - a.length)[0];
  return null;
}

/**
 * Where the blast-radius grep looks. Registered by the wiring stage from
 * `WorkspaceController.allAllowedPaths` — this module cannot know the user's
 * shared directories and must not import a controller to find out.
 *
 * Unset means no grep runs and the field is simply absent, which is the correct
 * degradation: an empty "also written down" list would read as "checked, found
 * nothing" when the truth is "never looked".
 */
let searchPathsProvider: (() => string[]) | null = null;

export function setBlastRadiusSearchPaths(provider: (() => string[]) | null): void {
  searchPathsProvider = provider;
}

function grepRoot(token: string, root: string): Array<[string, number]> {
  let out = '';
  try {
    out = execFileSync(
      '/usr/bin/grep',
      [
        '-rIn',
        // FIXED STRING, not a regex. A distinctive token is very often an
        // identifier carrying a dot — `public.users` — and as a BRE that `.`
        // matches any character, so an unrelated `publicXusers` lands in the
        // checklist as a place the stale belief is written (measured on this
        // machine's /usr/bin/grep, 2026-07-29). `-m` is per file under `-r`.
        '-F',
        '--binary-files=without-match',
        '--exclude-dir=node_modules',
        '--exclude-dir=.git',
        '--exclude-dir=.venv',
        '--exclude-dir=venv',
        '--exclude-dir=__pycache__',
        '-m', String(BLAST_MAX_MATCHES_PER_FILE),
        '-e', token,
        '--', root,
      ],
      { encoding: 'utf-8', timeout: BLAST_GREP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    // grep exits 1 when nothing matched, and 2 on an unreadable root. Neither
    // is a reason to fail the write that is already committed.
    return [];
  }
  const hits: Array<[string, number]> = [];
  for (const line of out.split('\n')) {
    const m = /^(.*?):(\d+):/.exec(line);
    if (m) hits.push([m[1], Number(m[2])]);
  }
  return hits;
}

function isExecutableFile(absPath: string): boolean {
  if (RUNNABLE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) return true;
  try {
    return (fs.statSync(absPath).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Every other place the superseded belief is still written down.
 *
 * Hits inside the store are dropped: the ledger's own archive contains the old
 * rule by design, and listing it would turn the checklist into a self-reference
 * the user cannot act on.
 */
export function findBlastRadius(token: string, roots?: string[]): BlastRadiusHit[] {
  const searchRoots = (roots ?? searchPathsProvider?.() ?? []).filter(Boolean);
  if (!token || searchRoots.length === 0) return [];

  const store = realOrSelf(skillsStoreRoot());
  const byFile = new Map<string, BlastRadiusHit>();

  for (const root of searchRoots) {
    if (byFile.size >= BLAST_MAX_FILES) break;
    for (const [file, line] of grepRoot(token, root)) {
      const abs = path.resolve(file);
      if (realOrSelf(abs).startsWith(store + path.sep)) continue;
      if (abs.includes(`${path.sep}${SKILL_FINDINGS_SUBDIR.split('/').join(path.sep)}${path.sep}`)) continue;
      const existing = byFile.get(abs);
      if (existing) {
        if (!existing.lines.includes(line)) existing.lines.push(line);
        continue;
      }
      if (byFile.size >= BLAST_MAX_FILES) break;
      byFile.set(abs, {
        absPath: abs,
        display: path.relative(root, abs) || path.basename(abs),
        lines: [line],
        executable: isExecutableFile(abs),
      });
    }
  }

  return [...byFile.values()].map((h) => ({ ...h, lines: h.lines.sort((a, b) => a - b) }));
}

function blastRadiusLines(hits: BlastRadiusHit[]): string[] {
  return hits.map(
    (h) => `\`${h.display}:${h.lines.join(',')}\`${h.executable ? ' (EXECUTABLE)' : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecordFindingContext {
  /** SDK session id of the recording turn, stamped into the meta. */
  sessionId?: string;
  /** Injectable clock, so tests do not depend on today's date. */
  now?: Date;
  /** Overrides the registered provider. Used by tests and by a UI-driven record. */
  searchPaths?: string[];
}

/**
 * Append a finding. NEVER refuses — see the module header.
 *
 * Order matters and is not arbitrary: the blast-radius grep runs BEFORE the
 * supersession move, because the token comes from the entry being superseded
 * and reading it out of the live bucket is cheaper than chasing it into the
 * archive. The derived files are regenerated last, from a fresh read, so they
 * describe the ledger as it now is rather than as it was mid-operation.
 */
export function recordFinding(
  input: RecordFindingInput,
  ctx: RecordFindingContext = {},
): RecordFindingResult {
  const now = ctx.now ?? new Date();
  const skill = safeSkillId(input.skill);
  const dir = findingsDirFor(skill);
  const skillCreated = !fs.existsSync(path.dirname(path.dirname(dir)));
  fs.mkdirSync(dir, { recursive: true });

  const before = readLedger(skill);
  const nextNumber =
    [...before.active, ...before.archived].reduce((max, f) => Math.max(max, idNumber(f.meta.id)), 0) + 1;
  const id = formatId(nextNumber);

  // Sanitize, never reject. A title the model over-ran is truncated; a rule it
  // forgot falls back to the title, because an entry with a heading and no rule
  // is still a durable record of what was learned.
  const title = truncate(oneLine(input.title) || `Finding ${id}`, TITLE_MAX_CHARS);
  const rule = oneLine(input.rule) || title;
  const evidence = oneLine(input.evidence);
  const cost = oneLine(input.cost_if_unknown ?? '');
  const scope = (input.scope ?? []).map((s) => oneLine(String(s))).filter(Boolean);
  const confirms = (input.confirms ?? []).map((s) => oneLine(String(s))).filter(Boolean);
  const supersedes = (input.supersedes ?? []).map((s) => oneLine(String(s))).filter(Boolean);
  const bucket = bucketNameFor(scope);

  // --- blast radius, while the superseded entries are still where we left them
  const targets = supersedes
    .map((sid) => before.active.find((f) => f.meta.id === sid) ?? before.archived.find((f) => f.meta.id === sid))
    .filter((f): f is Finding => Boolean(f));
  const notFound = supersedes.filter((sid) => !targets.some((t) => t.meta.id === sid));

  const hostLines: string[] = [];
  const tokensSearched: string[] = [];
  for (const target of targets) {
    const token = distinctiveToken(`${target.title} ${target.rule}`);
    if (!token) continue;
    tokensSearched.push(token);
    hostLines.push(...blastRadiusLines(findBlastRadius(token, ctx.searchPaths)));
  }
  const modelLines = (input.blast_radius ?? []).map((s) => oneLine(String(s))).filter(Boolean);
  const radius = [...new Set([...hostLines, ...modelLines])];

  // --- the entry itself
  const meta: FindingMeta = {
    id,
    status: 'active',
    recorded: isoDay(now),
    last_read: isoDay(now),
    session: ctx.sessionId,
    scope: scope.length ? scope : undefined,
    supersedes: supersedes.length ? supersedes : undefined,
    confirms: confirms.length ? confirms : undefined,
    bucket,
  };

  const body: string[] = [`### ${id} · ${title}`, serializeMeta(meta), '', `**Rule.** ${rule}`];
  if (evidence) body.push('', `**Evidence.** ${evidence}`);
  if (cost) body.push('', `**Cost of not knowing.** ${cost}`);
  if (confirms.length) body.push('', `**Confirms.** ${confirms.join(', ')}`);
  if (supersedes.length) body.push('', `**Supersedes.** ${supersedes.join(', ')}`);
  if (radius.length) {
    const searched = tokensSearched.length ? ` (searched for ${tokensSearched.map((t) => `\`${t}\``).join(', ')})` : '';
    body.push('', `**Also written down, may still be wrong.**${searched}`, ...radius.map((l) => `- ${l}`));
  }
  const block = `${body.join('\n')}\n`;

  const fileName = shardForAppend(dir, bucket, Buffer.byteLength(block, 'utf-8'));
  appendBlock(dir, fileName, bucket, block);

  // --- supersession, after the new entry exists to point at
  const superseded: string[] = [];
  for (const target of targets) {
    if (applySupersession(dir, target, id, now)) superseded.push(target.meta.id);
  }

  regenerateDerived(skill);

  const after = readLedger(skill);
  log.info(
    `[Findings] ${skill}: recorded ${id} in ${fileName}` +
      `${superseded.length ? `, superseded ${superseded.join(', ')}` : ''}` +
      `${radius.length ? `, blast radius ${radius.length} file(s)` : ''}` +
      ` (${after.active.length} active, ${after.bytes} bytes)`,
  );

  return {
    id,
    bucket,
    file: fileName,
    entry_count: after.active.length,
    ledger_bytes: after.bytes,
    superseded: superseded.length ? superseded : undefined,
    supersedes_not_found: notFound.length ? notFound : undefined,
    blast_radius: radius.length ? radius : undefined,
    skill_created: skillCreated || undefined,
  };
}

function appendBlock(dir: string, fileName: string, bucket: string, block: string): void {
  const file = path.join(dir, fileName);
  const existing = readText(file);
  if (existing.trim()) {
    writeTextAtomic(file, `${existing.replace(/\s+$/, '')}\n\n${block}`);
    return;
  }
  const archived = bucket.endsWith('-archive');
  const subject = archived ? bucket.slice(0, -'-archive'.length) : bucket;
  const title = archived ? `${subject} — superseded` : subject;
  const header =
    `<!-- ${archived ? 'Superseded findings' : 'Findings'} for "${subject}". ` +
    'Written by Acabox record_finding; the host owns this directory. -->\n' +
    `# ${title}\n`;
  writeTextAtomic(file, `${header}\n${block}`);
}

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

/**
 * Retire a finding: flip its status, move the body to `<bucket>-archive.md`,
 * leave a one-line stub behind.
 *
 * The stub is what makes this honest. A reader of `messages.md` who remembers
 * F-006 needs to see that it was replaced and where it went; deleting the
 * heading outright would make the correction look like the entry never existed.
 * It is deliberately ONE line and deliberately not a `###` heading, so it costs
 * almost no read context and the entry parser skips it.
 *
 * Superseded content must not cost read context but must remain auditable —
 * those two requirements are why this is a move rather than a delete or a
 * collapsed section (markdown has no collapse, and `Read` pulls a whole file).
 */
function applySupersession(dir: string, target: Finding, bySupersedingId: string, now: Date): boolean {
  if (target.meta.status === 'superseded') return false;

  const sourceFile = path.join(dir, target.file);
  const source = readText(sourceFile);
  if (!source.includes(target.block.split('\n')[0])) return false;

  const archivedMeta: FindingMeta = {
    ...target.meta,
    status: 'superseded',
    superseded_by: bySupersedingId,
  };
  const archivedBlock = `${replaceLiteral(target.block, META_RE, serializeMeta(archivedMeta))}\n`;

  const archiveBase = `${target.meta.bucket}-archive`;
  const archiveFile = shardForAppend(dir, archiveBase, Buffer.byteLength(archivedBlock, 'utf-8'));
  appendBlock(dir, archiveFile, archiveBase, archivedBlock);

  const stub =
    `- ~~${target.meta.id} · ${target.title}~~ — superseded by ${bySupersedingId} ` +
    `on ${isoDay(now)}, moved to \`${archiveFile}\`\n`;
  const remaining = replaceLiteral(source, target.block, stub.trimEnd());
  writeTextAtomic(sourceFile, `${remaining.replace(/\s+$/, '')}\n`);
  return true;
}

/**
 * Supersede without recording a replacement — the UI's `[Supersede]` action on
 * a findings row. `bySupersedingId` may name an existing finding or be omitted
 * when the belief is simply retired.
 */
export function supersedeFinding(
  skill: string,
  id: string,
  bySupersedingId = 'a later correction',
  now: Date = new Date(),
): boolean {
  const snapshot = readLedger(skill);
  const target = snapshot.active.find((f) => f.meta.id === id);
  if (!target) return false;
  const moved = applySupersession(snapshot.dir, target, bySupersedingId, now);
  if (moved) {
    regenerateDerived(snapshot.skill);
    log.info(`[Findings] ${snapshot.skill}: superseded ${id} by ${bySupersedingId}`);
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * Bump `last_read` on every finding in a bucket file the model just read.
 *
 * Takes the path as it appeared in the tool stream, which may be the workspace
 * render (`<workspace>/.claude/skills/<id>/references/findings/…`) rather than
 * the store — `realpath` collapses the symlink so both spellings work, and a
 * path that does not resolve into the store is not ours and is ignored.
 *
 * Bucket granularity, always. See `LAST_READ_GRANULARITY_NOTE`.
 */
export function noteFindingsFileRead(readPath: string, now: Date = new Date()): string[] {
  if (!readPath || !readPath.endsWith('.md')) return [];
  if (!readPath.includes(SKILL_FINDINGS_SUBDIR)) return [];

  if (!fs.existsSync(readPath)) return [];
  const abs = realOrSelf(readPath);
  const storeRoot = realOrSelf(skillsStoreRoot());
  if (!abs.startsWith(storeRoot + path.sep)) return [];

  const rel = path.relative(storeRoot, abs).split(path.sep);
  const skill = rel[0];
  const fileName = path.basename(abs);
  if (!skill || DERIVED_FILES.has(fileName)) return [];

  const dir = path.dirname(abs);
  const content = readText(path.join(dir, fileName));
  const entries = parseEntries(fileName, content);
  if (entries.length === 0) return [];

  const day = isoDay(now);
  let updated = content;
  const bumped: string[] = [];
  for (const entry of entries) {
    if (entry.meta.last_read === day) continue;
    const nextBlock = replaceLiteral(entry.block, META_RE, serializeMeta({ ...entry.meta, last_read: day }));
    updated = replaceLiteral(updated, entry.block, nextBlock);
    bumped.push(entry.meta.id);
  }
  if (bumped.length === 0) return [];

  writeTextAtomic(path.join(dir, fileName), updated);
  return bumped;
}

// ---------------------------------------------------------------------------
// Derived files
// ---------------------------------------------------------------------------

/**
 * One index row, hard-capped at `INDEX_ROW_MAX_CHARS`.
 *
 * The fixed cells are measured first and whatever is left goes to `rule`, so
 * the cap binds on the free text rather than dropping a column. If even that is
 * not enough (an absurd scope string), the row is sliced — the guarantee callers
 * rely on is that no row exceeds the cap, not that every cell survives.
 */
function indexRow(f: Finding, extra?: string): string {
  const topic = truncate(f.meta.bucket, 24);
  const scope = truncate((f.meta.scope ?? []).join(', '), 32);
  const recorded = f.meta.recorded;
  const tail = extra === undefined ? '' : ` ${truncate(extra.replace(/\|/g, '/'), 16)} |`;
  const fixed = `| ${f.meta.id} | ${topic} |  | ${scope} | ${recorded} |${tail}`;
  const room = INDEX_ROW_MAX_CHARS - fixed.length;
  const rule = truncate(f.rule.replace(/\|/g, '/'), Math.max(1, room));
  const row = `| ${f.meta.id} | ${topic} | ${rule} | ${scope} | ${recorded} |${tail}`;
  return row.length > INDEX_ROW_MAX_CHARS ? row.slice(0, INDEX_ROW_MAX_CHARS) : row;
}

function indexTable(title: string, rows: Finding[], extraHeader?: string, extra?: (f: Finding) => string): string {
  const lines = [HOST_BANNER, '', `# ${title}`, ''];
  if (rows.length === 0) {
    lines.push('_None._', '');
    return lines.join('\n');
  }
  const head = extraHeader ? `| id | topic | rule | scope | recorded | ${extraHeader} |` : '| id | topic | rule | scope | recorded |';
  const sep = extraHeader ? '|---|---|---|---|---|---|' : '|---|---|---|---|---|';
  lines.push(head, sep);
  for (const f of rows) lines.push(indexRow(f, extra?.(f)));
  lines.push('');
  return lines.join('\n');
}

/**
 * The digest — the only findings file loaded unconditionally when the skill
 * activates, via one router line in `SKILL.md`.
 *
 * It is a SEPARATE FILE and not a block inside `SKILL.md`, and that is
 * structural rather than stylistic. A host-maintained block inside the user's
 * own prose file collides head-on with the per-file sha256 baseline: every
 * ledger-bearing skill would read MODIFIED forever with no user edit, and
 * `Revert` would delete the digest. Separate file, no shared ownership of any
 * byte.
 *
 * Newest first, because the newest finding is disproportionately likely to be
 * the correction of an older one that is still written down in six other places.
 */
function digestText(skill: string, active: Finding[]): string {
  const newestFirst = [...active].sort((a, b) => idNumber(b.meta.id) - idNumber(a.meta.id));
  const head = [
    HOST_BANNER,
    '',
    `# ${skill} — findings digest`,
    '',
    `${active.length} active finding${active.length === 1 ? '' : 's'}. Newest first. ` +
      `Full list: \`${SKILL_FINDINGS_SUBDIR}/${INDEX_FILE}\``,
    '',
    '',
  ].join('\n');

  let out = head;
  let shown = 0;
  for (const f of newestFirst) {
    if (shown >= DIGEST_MAX_ENTRIES) break;
    const bucketFile = `${SKILL_FINDINGS_SUBDIR}/${f.file}`;
    const line = truncate(
      `${f.meta.id} · ${f.rule || f.title} (${bucketFile})`,
      DIGEST_LINE_MAX_CHARS,
    );
    const next = `${out}${line}\n`;
    if (Buffer.byteLength(next, 'utf-8') > DIGEST_MAX_BYTES) break;
    out = next;
    shown++;
  }
  if (shown < newestFirst.length) {
    const note = `\n_${newestFirst.length - shown} more in \`${SKILL_FINDINGS_SUBDIR}/${INDEX_FILE}\`._\n`;
    if (Buffer.byteLength(out + note, 'utf-8') <= DIGEST_MAX_BYTES) out += note;
  }
  return out;
}

/**
 * Rewrite `index.md`, `index-archive.md` and `digest.md` from the bucket files.
 *
 * Cheap enough to do on every write (tens of KB) and it is what makes drift
 * structurally impossible: there is one source of truth and two projections of
 * it, never three copies to keep in agreement.
 */
export function regenerateDerived(skill: string): void {
  const snapshot = readLedger(skill);
  if (!snapshot.exists) return;

  writeTextAtomic(path.join(snapshot.dir, INDEX_FILE), indexTable('Findings — active', snapshot.active));
  writeTextAtomic(
    path.join(snapshot.dir, INDEX_ARCHIVE_FILE),
    indexTable('Findings — superseded', snapshot.archived, 'superseded by', (f) => f.meta.superseded_by ?? '—'),
  );
  writeTextAtomic(path.join(snapshot.dir, DIGEST_FILE), digestText(snapshot.skill, snapshot.active));
}

/** Test seam — clears the registered search-path provider. */
export function __resetFindingsLedger(): void {
  searchPathsProvider = null;
}
