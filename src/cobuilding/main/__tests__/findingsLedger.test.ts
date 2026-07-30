/**
 * The findings ledger, against real directories on disk.
 *
 * Nothing here is mocked except `app.getPath` and the logger. The ledger's whole
 * job is to leave correct bytes in correct files — a fake filesystem would only
 * prove the fake agrees with itself, and the two behaviours that matter most
 * (sharding at a byte boundary, and grep finding a real stale `.sql`) are
 * measurements of the real thing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-findings-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  recordFinding,
  readLedger,
  countActiveFindings,
  supersedeFinding,
  noteFindingsFileRead,
  bucketNameFor,
  distinctiveToken,
  findBlastRadius,
  setBlastRadiusSearchPaths,
  regenerateDerived,
  findingsDirFor,
  skillsStoreRoot,
  INDEX_FILE,
  INDEX_ARCHIVE_FILE,
  DIGEST_FILE,
  INDEX_ROW_MAX_CHARS,
  DIGEST_MAX_BYTES,
  DIGEST_MAX_ENTRIES,
  BUCKET_SHARD_BYTES,
  TITLE_MAX_CHARS,
  __resetFindingsLedger,
} from '../knowledge/findingsLedger';

const SKILL = 'coscientist-analytics';
const NOW = new Date(2026, 6, 29); // 2026-07-29, local

function dir(skill = SKILL): string {
  return findingsDirFor(skill);
}
function read(file: string, skill = SKILL): string {
  return fs.readFileSync(path.join(dir(skill), file), 'utf-8');
}
function ls(skill = SKILL): string[] {
  return fs.readdirSync(dir(skill)).sort();
}

beforeEach(() => {
  __resetFindingsLedger();
  fs.rmSync(skillsStoreRoot(), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

describe('recordFinding — append', () => {
  it('creates the ledger, the bucket, the index and the digest', async () => {
    const result = await recordFinding(
      {
        skill: SKILL,
        title: 'public.users JOIN times out; IN-subquery completes',
        rule: 'Filter with IN (SELECT id FROM …), never JOIN public.users directly.',
        evidence: 'The JOIN form exceeded the Hex thread timeout; IN returned in 41s.',
        cost_if_unknown: 'Every users-table question burns a thread before failing.',
        scope: ['public.users'],
      },
      { now: NOW, sessionId: 'fef47b89' },
    );

    expect(result.id).toBe('F-001');
    expect(result.bucket).toBe('users');
    expect(result.file).toBe('users.md');
    expect(result.entry_count).toBe(1);
    expect(result.ledger_bytes).toBeGreaterThan(0);
    expect(ls()).toEqual([DIGEST_FILE, INDEX_ARCHIVE_FILE, INDEX_FILE, 'users.md']);

    const bucket = read('users.md');
    expect(bucket).toContain('### F-001 · public.users JOIN times out; IN-subquery completes');
    expect(bucket).toContain('**Rule.** Filter with IN');
    expect(bucket).toContain('**Evidence.** The JOIN form exceeded');
    expect(bucket).toContain('**Cost of not knowing.** Every users-table question');

    // One machine-readable comment, on one line, holding everything the host
    // needs — no per-entry YAML parser anywhere in this feature.
    const meta = JSON.parse(/<!-- acabox:meta (.*?) -->/.exec(bucket)![1]);
    expect(meta).toMatchObject({
      id: 'F-001',
      status: 'active',
      recorded: '2026-07-29',
      last_read: '2026-07-29',
      session: 'fef47b89',
      scope: ['public.users'],
      bucket: 'users',
    });

    expect(read(INDEX_FILE)).toContain('| F-001 | users |');
    expect(read(DIGEST_FILE)).toContain('F-001 ·');
  });

  it('numbers ids sequentially and keeps unrelated scopes in separate buckets', async () => {
    await recordFinding({ skill: SKILL, title: 'a', rule: 'a', evidence: 'a', scope: ['co_scientist_agent_messages'] }, { now: NOW });
    const second = await recordFinding({ skill: SKILL, title: 'b', rule: 'b', evidence: 'b', scope: ['cohorts'] }, { now: NOW });

    expect(second.id).toBe('F-002');
    expect(ls()).toContain('co-scientist-agent-messages.md');
    expect(ls()).toContain('cohorts.md');
  });

  it('files a scopeless finding under the default bucket', async () => {
    const r = await recordFinding({ skill: SKILL, title: 'x', rule: 'x', evidence: 'x' }, { now: NOW });
    expect(r.bucket).toBe('general');
    expect(ls()).toContain('general.md');
  });

  it('records the finding even when the skill has no directory yet', async () => {
    const r = await recordFinding({ skill: 'brand-new-skill', title: 'x', rule: 'x', evidence: 'x' }, { now: NOW });
    expect(r.skill_created).toBe(true);
    expect(readLedger('brand-new-skill').active).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The anti-dedup invariant — the reason this feature exists
// ---------------------------------------------------------------------------

describe('recordFinding never refuses a write', () => {
  /**
   * The headline invariant. A similarity threshold fires precisely on
   * CORRECTIONS, because a correction restates the thing it corrects. These two
   * share every distinctive token; a deduper would have kept the first and
   * discarded the second, which is the wrong one to keep.
   */
  it('lands BOTH of two near-identical corrections', async () => {
    const first = await recordFinding(
      {
        skill: SKILL,
        title: 'Group the dedupe on content_hash',
        rule: 'Group the message recurrence CTE on content_hash, not raw content.',
        evidence: 'content_hash is indexed and shorter than the body.',
        scope: ['co_scientist_agent_messages'],
      },
      { now: NOW },
    );
    const second = await recordFinding(
      {
        skill: SKILL,
        title: 'content_hash is not a hash of content',
        rule: 'Group the message recurrence CTE on MD5(content). Never on content_hash.',
        evidence: 'Grouping example_template on content_hash matched 0 rows against an expected 3,362.',
        scope: ['co_scientist_agent_messages'],
      },
      { now: NOW },
    );

    expect(first.id).toBe('F-001');
    expect(second.id).toBe('F-002');

    const ledger = readLedger(SKILL);
    expect(ledger.active.map((f) => f.meta.id)).toEqual(['F-001', 'F-002']);
    const bucket = read('co-scientist-agent-messages.md');
    expect(bucket).toContain('not raw content');
    expect(bucket).toContain('Never on content_hash');
  });

  it('truncates rather than rejects an over-long title, and falls back for a missing rule', async () => {
    const long = 'x'.repeat(400);
    const r = await recordFinding({ skill: SKILL, title: long, rule: '', evidence: '' }, { now: NOW });
    const entry = readLedger(SKILL).active[0];
    expect(r.id).toBe('F-001');
    expect(entry.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    // An entry with no rule still gets one, so the index row and digest line are
    // never blank — losing the record entirely is the only unacceptable outcome.
    expect(entry.rule).toBe(entry.title);
  });

  it('slugifies a hostile skill name instead of escaping the store', async () => {
    await recordFinding({ skill: '../../etc/passwd', title: 'x', rule: 'x', evidence: 'x' }, { now: NOW });
    const written = fs.readdirSync(skillsStoreRoot());
    expect(written).toEqual(['etc-passwd']);
  });

  it('survives a rule containing $& — a String.replace replacement pattern', async () => {
    await recordFinding({ skill: SKILL, title: 'dollar $& case', rule: 'Use $& and $1 literally.', evidence: 'e', scope: ['s'] }, { now: NOW });
    // The rewrite paths (last_read bump, supersession) all replace whole blocks;
    // a naive string replacement would expand $& into the matched text.
    await recordFinding({ skill: SKILL, title: 'replacement', rule: 'r', evidence: 'e', scope: ['s'], supersedes: ['F-001'] }, { now: NOW });
    expect(read('s-archive.md')).toContain('Use $& and $1 literally.');
  });
});

// ---------------------------------------------------------------------------
// Sharding
// ---------------------------------------------------------------------------

describe('sharding', () => {
  it('rolls to a second shard at the 32 KB boundary and never splits an entry', async () => {
    const filler = 'E'.repeat(4000);
    let created = 0;
    for (let i = 0; i < 12; i++) {
      await recordFinding({ skill: SKILL, title: `finding ${i}`, rule: `rule ${i}`, evidence: filler, scope: ['messages'] }, { now: NOW });
      created++;
      if (fs.existsSync(path.join(dir(), 'messages-2.md'))) break;
    }

    expect(fs.existsSync(path.join(dir(), 'messages-2.md'))).toBe(true);
    // The first shard is closed BEFORE it exceeds the limit, not after.
    expect(fs.statSync(path.join(dir(), 'messages.md')).size).toBeLessThanOrEqual(BUCKET_SHARD_BYTES);

    // Every entry is still exactly one whole entry, in exactly one file.
    const ledger = readLedger(SKILL);
    expect(ledger.active).toHaveLength(created);
    expect(new Set(ledger.active.map((f) => f.file)).size).toBe(2);
    for (const f of ledger.active) expect(f.rule).toMatch(/^rule \d+$/);
  });

  it('keeps a scope that looks like a shard or an archive out of the naming space', async () => {
    // `users-2` and `users-archive` as bucket names would collide with the
    // shard and archive files of the `users` bucket.
    expect(bucketNameFor(['users-2'])).toBe('users');
    expect(bucketNameFor(['users-archive'])).toBe('users');
    expect(bucketNameFor(['public.users'])).toBe('users');
    expect(bucketNameFor([])).toBe('general');
  });
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

describe('supersession', () => {
  async function seedPair() {
    await recordFinding(
      {
        skill: SKILL,
        title: 'Group the dedupe on content_hash',
        rule: 'Group the recurrence CTE on content_hash.',
        evidence: 'It is indexed.',
        scope: ['co_scientist_agent_messages'],
      },
      { now: NOW },
    );
    return await recordFinding(
      {
        skill: SKILL,
        title: 'content_hash is not a hash of content',
        rule: 'Group on MD5(content). Never on content_hash.',
        evidence: 'Matched 0 rows against an expected 3,362.',
        scope: ['co_scientist_agent_messages'],
        supersedes: ['F-001'],
      },
      { now: NOW },
    );
  }

  it('moves the body to the archive and leaves a one-line stub', async () => {
    const result = await seedPair();
    expect(result.superseded).toEqual(['F-001']);

    const bucket = read('co-scientist-agent-messages.md');
    const archive = read('co-scientist-agent-messages-archive.md');

    // The body left the read path...
    expect(bucket).not.toContain('**Rule.** Group the recurrence CTE on content_hash.');
    expect(archive).toContain('**Rule.** Group the recurrence CTE on content_hash.');

    // ...and left exactly one line behind, which is not a heading (so it costs
    // almost nothing to read and the entry parser skips it).
    const stubs = bucket.split('\n').filter((l) => l.includes('~~F-001'));
    expect(stubs).toHaveLength(1);
    expect(stubs[0].startsWith('###')).toBe(false);
    expect(stubs[0]).toContain('superseded by F-002');
    expect(stubs[0]).toContain('co-scientist-agent-messages-archive.md');
  });

  it('flips status in the meta comment and records who replaced it', async () => {
    await seedPair();
    const ledger = readLedger(SKILL);
    expect(ledger.active.map((f) => f.meta.id)).toEqual(['F-002']);
    expect(ledger.archived.map((f) => f.meta.id)).toEqual(['F-001']);
    expect(ledger.archived[0].meta.status).toBe('superseded');
    expect(ledger.archived[0].meta.superseded_by).toBe('F-002');
  });

  it('moves the index row to index-archive.md', async () => {
    await seedPair();
    const index = read(INDEX_FILE);
    const archiveIndex = read(INDEX_ARCHIVE_FILE);
    expect(index).toContain('| F-002 |');
    expect(index).not.toContain('| F-001 |');
    expect(archiveIndex).toContain('| F-001 |');
    expect(archiveIndex).toContain('F-002');
  });

  it('does not reuse a superseded id', async () => {
    await seedPair();
    const next = await recordFinding({ skill: SKILL, title: 'c', rule: 'c', evidence: 'c' }, { now: NOW });
    expect(next.id).toBe('F-003');
  });

  it('reports an unknown supersedes id instead of throwing', async () => {
    const r = await recordFinding(
      { skill: SKILL, title: 'a', rule: 'a', evidence: 'a', supersedes: ['F-999'] },
      { now: NOW },
    );
    expect(r.supersedes_not_found).toEqual(['F-999']);
    expect(readLedger(SKILL).active).toHaveLength(1);
  });

  it('supersedes from the UI with no replacement finding', async () => {
    await recordFinding({ skill: SKILL, title: 'a', rule: 'a', evidence: 'a', scope: ['s'] }, { now: NOW });
    expect(supersedeFinding(SKILL, 'F-001', 'the user', NOW)).toBe(true);
    expect(readLedger(SKILL).active).toHaveLength(0);
    expect(readLedger(SKILL).archived).toHaveLength(1);
    // Idempotent: a second call finds nothing active to move.
    expect(supersedeFinding(SKILL, 'F-001', 'the user', NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Derived files
// ---------------------------------------------------------------------------

describe('index and digest regeneration', () => {
  it('caps every index row at 120 characters', async () => {
    await recordFinding(
      {
        skill: SKILL,
        title: 'long',
        rule: 'R'.repeat(600),
        evidence: 'e',
        scope: ['a_very_long_scope_name_that_goes_on', 'and_another_one_as_well'],
      },
      { now: NOW },
    );
    const rows = read(INDEX_FILE).split('\n').filter((l) => l.startsWith('| F-'));
    expect(rows).toHaveLength(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(INDEX_ROW_MAX_CHARS);
  });

  it('keeps the digest newest-first, within 15 entries and 2 KB', async () => {
    for (let i = 0; i < 20; i++) {
      await recordFinding({ skill: SKILL, title: `t${i}`, rule: `rule number ${i}`, evidence: 'e', scope: ['s'] }, { now: NOW });
    }
    const digest = read(DIGEST_FILE);
    const lines = digest.split('\n').filter((l) => /^F-\d+ ·/.test(l));

    expect(lines.length).toBeLessThanOrEqual(DIGEST_MAX_ENTRIES);
    expect(lines[0]).toContain('F-020');
    expect(lines[1]).toContain('F-019');
    expect(Buffer.byteLength(digest, 'utf-8')).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    expect(digest).toContain('20 active findings');
    // The overflow is stated rather than silently dropped.
    expect(digest).toMatch(/\d+ more in/);
  });

  it('names the shard a finding actually lives in', async () => {
    await recordFinding({ skill: SKILL, title: 't', rule: 'r', evidence: 'e', scope: ['messages'] }, { now: NOW });
    expect(read(DIGEST_FILE)).toContain('references/findings/messages.md');
  });

  it('is a pure projection of the bucket files — a deleted index is rebuilt exactly', async () => {
    await recordFinding({ skill: SKILL, title: 't1', rule: 'r1', evidence: 'e', scope: ['s'] }, { now: NOW });
    await recordFinding({ skill: SKILL, title: 't2', rule: 'r2', evidence: 'e', scope: ['s'] }, { now: NOW });
    const before = read(INDEX_FILE);

    fs.rmSync(path.join(dir(), INDEX_FILE));
    regenerateDerived(SKILL);
    expect(read(INDEX_FILE)).toBe(before);
  });

  it('writes the digest as its own file and never touches SKILL.md', async () => {
    const skillMd = path.join(skillsStoreRoot(), SKILL, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillMd), { recursive: true });
    fs.writeFileSync(skillMd, '---\nname: x\ndescription: y\n---\n\nrouter\n');
    const beforeBytes = fs.readFileSync(skillMd);

    await recordFinding({ skill: SKILL, title: 't', rule: 'r', evidence: 'e' }, { now: NOW });

    // The per-file sha256 baseline is why this matters: a host-maintained block
    // inside SKILL.md would make every ledger-bearing skill read MODIFIED
    // forever, and Revert would delete the digest.
    expect(fs.readFileSync(skillMd)).toEqual(beforeBytes);
    expect(fs.existsSync(path.join(dir(), DIGEST_FILE))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

describe('blast radius', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'));
    fs.writeFileSync(
      path.join(workspace, 'genuine-messages-canonical-query.sql'),
      'SELECT 1\n-- group on content_hash here\nGROUP BY content_hash\n',
    );
    fs.writeFileSync(path.join(workspace, 'HANDOFF.md'), 'line one\nwe dedupe by content_hash\n');
    fs.writeFileSync(path.join(workspace, 'unrelated.md'), 'nothing to see\n');
  });

  it('picks the identifier, not an ordinary word', async () => {
    expect(distinctiveToken('content_hash is not a hash of content')).toBe('content_hash');
    expect(distinctiveToken('Group the dedupe on content_hash, not raw content')).toBe('content_hash');
    expect(distinctiveToken('public.users JOIN times out; IN-subquery completes')).toBe('public.users');
    // Ordinary long words are the fallback, and common ones are excluded so a
    // grep for "silently" over a research folder returns noise, not a checklist.
    expect(distinctiveToken('the warehouse silently returns wrong numbers')).toBe('warehouse');
    expect(distinctiveToken('do it now')).toBeNull();
  });

  it('greps the real shared directories and marks runnable files', async () => {
    const hits = await findBlastRadius('content_hash', [workspace]);
    const displays = hits.map((h) => h.display).sort();
    expect(displays).toEqual(['HANDOFF.md', 'genuine-messages-canonical-query.sql']);

    const sql = hits.find((h) => h.display.endsWith('.sql'))!;
    expect(sql.lines).toEqual([2, 3]);
    expect(sql.executable).toBe(true);
    expect(hits.find((h) => h.display === 'HANDOFF.md')!.executable).toBe(false);
  });

  // ── B22: the grep used to be execFileSync on the Electron main thread ──

  it('keeps the main thread live while grepping (B22)', async () => {
    // The bug was not correctness — nothing was lost and it self-resolved. It
    // was that `recordFinding`'s body ran synchronously on the main thread, so
    // a grep over the user's real research directories froze the entire UI for
    // its duration. A synchronous grep cannot let a timer fire; an async one
    // must. Measured on this machine: ~80ms for 3000 files, so a 15ms timer has
    // a wide margin.
    const big = fs.mkdtempSync(path.join(tmpDir, 'big-'));
    for (let i = 0; i < 3000; i += 1) {
      const sub = path.join(big, `sub${Math.floor(i / 100)}`);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, `f${i}.md`), 'lorem ipsum dolor sit amet '.repeat(40));
    }

    let tickedDuringGrep = false;
    const timer = setTimeout(() => { tickedDuringGrep = true; }, 15);
    await findBlastRadius('content_hash', [big]);
    clearTimeout(timer);

    expect(tickedDuringGrep).toBe(true);
  });

  it('spends nothing once the total budget is gone (B22)', async () => {
    // The per-root timeout is charged once per root PER SUPERSEDED TOKEN, so the
    // old worst case grew with (shared dirs x superseded findings) and had no
    // ceiling. A deadline already in the past must skip the root outright
    // rather than start a 10s grep against it.
    const started = Date.now();
    const hits = await findBlastRadius('content_hash', [workspace], Date.now() - 1);
    expect(hits).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    // …and the same call without an expired deadline still finds the hits, so
    // the guard is a budget rather than an off switch.
    expect((await findBlastRadius('content_hash', [workspace])).length).toBe(2);
  });

  it('matches the token literally, not as a regex', async () => {
    // `public.users` is exactly the shape a distinctive token takes, and as a
    // BRE its `.` matches any character — measured on this machine's grep,
    // `publicXusers` matches without `-F`. A false entry in the "may still be
    // wrong" checklist is a wild goose chase the user cannot tell from a real one.
    fs.writeFileSync(path.join(workspace, 'regex-trap.md'), 'publicXusers is unrelated\n');
    fs.writeFileSync(path.join(workspace, 'real.md'), 'we JOIN public.users here\n');
    const displays = (await findBlastRadius('public.users', [workspace])).map((h) => h.display);
    expect(displays).toEqual(['real.md']);
  });

  it('writes the hit list into the superseding entry, host-augmented', async () => {
    await recordFinding(
      {
        skill: SKILL,
        title: 'Group the dedupe on content_hash',
        rule: 'Group the recurrence CTE on content_hash.',
        evidence: 'e',
        scope: ['messages'],
      },
      { now: NOW },
    );
    const r = await recordFinding(
      {
        skill: SKILL,
        title: 'content_hash is not a hash of content',
        rule: 'Group on MD5(content).',
        evidence: 'e',
        scope: ['messages'],
        supersedes: ['F-001'],
      },
      { now: NOW, searchPaths: [workspace] },
    );

    const bucket = read('messages.md');
    expect(bucket).toContain('**Also written down, may still be wrong.** (searched for `content_hash`)');
    expect(bucket).toContain('`genuine-messages-canonical-query.sql:2,3` (EXECUTABLE)');
    expect(bucket).toContain('`HANDOFF.md:2`');
    expect(r.blast_radius).toHaveLength(2);
  });

  it('never lists the ledger itself, which contains the old rule by design', async () => {
    await recordFinding(
      { skill: SKILL, title: 'Group on content_hash', rule: 'Group on content_hash.', evidence: 'e', scope: ['messages'] },
      { now: NOW },
    );
    // Point the search at the store as well as the workspace.
    const r = await recordFinding(
      { skill: SKILL, title: 'correction', rule: 'MD5(content).', evidence: 'e', scope: ['messages'], supersedes: ['F-001'] },
      { now: NOW, searchPaths: [workspace, skillsStoreRoot()] },
    );
    // The archive, index and digest all carry the old rule by construction;
    // listing them would turn the checklist into a self-reference.
    expect(r.blast_radius!.some((l) => l.includes('references/findings'))).toBe(false);
    expect(r.blast_radius!.some((l) => l.includes(SKILL))).toBe(false);
    expect(r.blast_radius).toHaveLength(2);
  });

  it('omits the field entirely when no search paths are registered', async () => {
    // Absent means "never looked". An empty list would read as "looked, found
    // nothing", which is a different and false claim.
    await recordFinding({ skill: SKILL, title: 'Group on content_hash', rule: 'x content_hash', evidence: 'e' }, { now: NOW });
    const r = await recordFinding({ skill: SKILL, title: 'b', rule: 'b', evidence: 'e', supersedes: ['F-001'] }, { now: NOW });
    expect(r.blast_radius).toBeUndefined();
    expect(read('general.md')).not.toContain('Also written down');
  });

  it('uses the registered provider when the caller passes nothing', async () => {
    setBlastRadiusSearchPaths(() => [workspace]);
    await recordFinding({ skill: SKILL, title: 'Group on content_hash', rule: 'x content_hash', evidence: 'e' }, { now: NOW });
    const r = await recordFinding({ skill: SKILL, title: 'b', rule: 'b', evidence: 'e', supersedes: ['F-001'] }, { now: NOW });
    expect(r.blast_radius).toHaveLength(2);
  });

  it('merges model-supplied locations with the ones the host found', async () => {
    setBlastRadiusSearchPaths(() => [workspace]);
    await recordFinding({ skill: SKILL, title: 'Group on content_hash', rule: 'x content_hash', evidence: 'e' }, { now: NOW });
    const r = await recordFinding(
      {
        skill: SKILL,
        title: 'b',
        rule: 'b',
        evidence: 'e',
        supersedes: ['F-001'],
        blast_radius: ['`Obsidian vault/co-scientist.md:179`'],
      },
      { now: NOW },
    );
    expect(r.blast_radius).toHaveLength(3);
    expect(r.blast_radius).toContain('`Obsidian vault/co-scientist.md:179`');
  });
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

describe('last_read freshness', () => {
  it('bumps every finding in the bucket file that was read', async () => {
    await recordFinding({ skill: SKILL, title: 'a', rule: 'a', evidence: 'e', scope: ['messages'] }, { now: NOW });
    await recordFinding({ skill: SKILL, title: 'b', rule: 'b', evidence: 'e', scope: ['messages'] }, { now: NOW });
    await recordFinding({ skill: SKILL, title: 'c', rule: 'c', evidence: 'e', scope: ['cohorts'] }, { now: NOW });

    const later = new Date(2026, 7, 15);
    const bumped = noteFindingsFileRead(path.join(dir(), 'messages.md'), later);

    // Bucket granularity, stated plainly: reading the file marks everything in
    // it, and nothing in any other bucket.
    expect(bumped).toEqual(['F-001', 'F-002']);
    const ledger = readLedger(SKILL);
    expect(ledger.active.find((f) => f.meta.id === 'F-001')!.meta.last_read).toBe('2026-08-15');
    expect(ledger.active.find((f) => f.meta.id === 'F-003')!.meta.last_read).toBe('2026-07-29');
  });

  it('is a no-op on a second read the same day', async () => {
    await recordFinding({ skill: SKILL, title: 'a', rule: 'a', evidence: 'e', scope: ['messages'] }, { now: NOW });
    const later = new Date(2026, 7, 15);
    expect(noteFindingsFileRead(path.join(dir(), 'messages.md'), later)).toEqual(['F-001']);
    expect(noteFindingsFileRead(path.join(dir(), 'messages.md'), later)).toEqual([]);
  });

  it('resolves the workspace symlink the model actually reads through', async () => {
    await recordFinding({ skill: SKILL, title: 'a', rule: 'a', evidence: 'e', scope: ['messages'] }, { now: NOW });

    // The render: <workspace>/.claude/skills/<id> -> <store>/<id>
    const renderRoot = fs.mkdtempSync(path.join(tmpDir, 'render-'));
    const link = path.join(renderRoot, SKILL);
    fs.symlinkSync(path.join(skillsStoreRoot(), SKILL), link);

    const viaLink = path.join(link, 'references', 'findings', 'messages.md');
    expect(noteFindingsFileRead(viaLink, new Date(2026, 7, 15))).toEqual(['F-001']);
  });

  it('ignores derived files and anything outside the store', async () => {
    await recordFinding({ skill: SKILL, title: 'a', rule: 'a', evidence: 'e', scope: ['messages'] }, { now: NOW });
    expect(noteFindingsFileRead(path.join(dir(), INDEX_FILE))).toEqual([]);
    expect(noteFindingsFileRead(path.join(dir(), DIGEST_FILE))).toEqual([]);
    expect(noteFindingsFileRead('/etc/hosts')).toEqual([]);
    expect(noteFindingsFileRead(path.join(tmpDir, 'references/findings/nope.md'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('readLedger', () => {
  it('distinguishes no ledger from an empty one', async () => {
    expect(countActiveFindings('never-used')).toBeUndefined();
    fs.mkdirSync(findingsDirFor('empty-one'), { recursive: true });
    expect(countActiveFindings('empty-one')).toBe(0);
  });

  it('keeps the bytes of an entry whose meta comment was mangled by hand', async () => {
    await recordFinding({ skill: SKILL, title: 'a', rule: 'a', evidence: 'e', scope: ['messages'] }, { now: NOW });
    const file = path.join(dir(), 'messages.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('acabox:meta {', 'acabox:meta {{'));

    // Dropped from the derived files, still on disk for a human to fix.
    expect(readLedger(SKILL).active).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf-8')).toContain('### F-001 · a');
  });
});
