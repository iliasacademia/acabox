import * as fs from 'fs';
import * as path from 'path';

import {
  ACABOX_ROSTER_BUDGET_FRACTION,
  BUNDLED_ALLOW,
  BUNDLED_SDK_SKILLS,
  RESERVED_SKILL_IDS,
  ROSTER_CONTEXT_TOKENS_DEFAULT,
  ROSTER_DEFAULT_BUDGET_FRACTION,
  ROSTER_DEFAULT_MAX_DESC_CHARS,
  SKILL_ID_PATTERN,
  buildSkillRuntimeConfig,
  computeRosterUsage,
  emptySkillsState,
  parseSkillFrontmatter,
  rosterBudgetChars,
  rosterLine,
  validateSkillId,
  type RosterEntry,
  type SkillStateEntry,
  type SkillsState,
} from '../skills';

/** The shipped pristine tree. These tests read the REAL files, not fixtures. */
const SKILLS_DIR = path.resolve(__dirname, '..', '..', 'skills');

function readSkillMd(id: string): string {
  return fs.readFileSync(path.join(SKILLS_DIR, id, 'SKILL.md'), 'utf8');
}

function shippedSkillIds(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

describe('validateSkillId', () => {
  it('accepts the ids we actually ship', () => {
    for (const id of shippedSkillIds()) {
      expect(validateSkillId(id)).toEqual({ ok: true });
    }
  });

  it('rejects malformed ids with a reason the UI can show', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['   ', 'empty'],
      ['My-Skill', 'charset'],       // uppercase — the CLI would sanitize, we refuse
      ['my_skill', 'charset'],       // underscore is outside the spec charset
      ['my skill', 'charset'],
      ['my--skill', 'charset'],      // double hyphen
      ['-my-skill', 'charset'],
      ['my-skill-', 'charset'],
      ['my.skill', 'charset'],
      ['../escape', 'charset'],      // must never survive into a path join
      ['a'.repeat(65), 'too-long'],
    ];
    for (const [id, problem] of cases) {
      const result = validateSkillId(id);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.problem).toBe(problem);
      expect(result.error.length).toBeGreaterThan(0);
    }
    expect(validateSkillId('a').ok).toBe(true);
    expect(validateSkillId('a'.repeat(64)).ok).toBe(true);
  });

  it('refuses every name the SDK ships a skill under', () => {
    // The Skill tool resolves a name with a first-match lookup over the merged
    // command list, so a store skill sharing a bundled name shadows it or is
    // shadowed — unpredictably, and with no error either way.
    for (const reserved of RESERVED_SKILL_IDS) {
      const result = validateSkillId(reserved);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.problem).toBe('reserved');
    }
    // Enumerated from the bundled CLI's own `iA({name:…})` registrations. The
    // design doc listed eight; these three were missing from it.
    expect(BUNDLED_SDK_SKILLS).toContain('update-config');
    expect(BUNDLED_SDK_SKILLS).toContain('claude-in-chrome');
    expect(BUNDLED_SDK_SKILLS).toContain('dream');
    expect(BUNDLED_SDK_SKILLS).toContain('schedule');
  });

  it('keeps SKILL_ID_PATTERN and the shipped ids in agreement', () => {
    for (const id of shippedSkillIds()) {
      expect(SKILL_ID_PATTERN.test(id)).toBe(true);
    }
  });
});

describe('parseSkillFrontmatter', () => {
  it('reads a long single-line quoted scalar in full (xlsx, the largest we ship)', () => {
    const fm = parseSkillFrontmatter(readSkillMd('xlsx'));
    expect(fm.ok).toBe(true);
    expect(fm.name).toBe('xlsx');
    expect(fm.license).toBe('Proprietary. LICENSE.txt has complete terms');
    expect(fm.description?.startsWith('Use this skill any time a spreadsheet file is the primary input')).toBe(true);
    expect(fm.description?.endsWith('even if tabular data is involved.')).toBe(true);
    // 941 chars, measured. The largest single roster description in the tree.
    expect(fm.description).toHaveLength(941);
  });

  it('folds a real multi-line block scalar without truncating it', () => {
    // manage-mini-application is the genuinely hard case in the tree: a `>`
    // folded scalar, three paragraphs separated by blank lines, and trailing
    // whitespace on continuation lines. The regex parser used during research
    // stopped at the first newline here and under-reported the roster by 55%.
    const fm = parseSkillFrontmatter(readSkillMd('manage-mini-application'));
    expect(fm.ok).toBe(true);
    expect(fm.description).toHaveLength(760);
    expect(fm.description?.startsWith('PRIORITY SKILL: Invoke this skill BEFORE')).toBe(true);
    expect(fm.description?.endsWith('no mention of building a UI or application.')).toBe(true);
    // Blank lines in a folded scalar survive as real newlines, so the roster
    // line for this skill is not one line. Three paragraphs, two newlines.
    expect((fm.description?.match(/\n/g) ?? []).length).toBe(2);
    // A trailing space before a fold becomes a double space. Verbatim, not
    // normalised — the model sees exactly this.
    expect(fm.description).toContain('data-processing  skills');
  });

  it('trims the description the way the CLI does', () => {
    // Every `>` scalar ends with a newline the CLI strips in `gb()` before it
    // ever reaches the roster line, so we strip it too.
    const fm = parseSkillFrontmatter(readSkillMd('acabox'));
    expect(fm.ok).toBe(true);
    expect(fm.description?.endsWith('\n')).toBe(false);
    expect(fm.description?.endsWith('IS possible.')).toBe(true);
  });

  it('surfaces the optional fields only when they are present', () => {
    const withSource = parseSkillFrontmatter(readSkillMd('geo-database'));
    expect(withSource.source).toBe('jaechang-hits/SciAgent-Skills');
    expect(withSource.license).toBe('MIT');

    const withoutEither = parseSkillFrontmatter(readSkillMd('react-plotly'));
    expect(withoutEither.ok).toBe(true);
    // Absent, not an empty string and not "Unknown" — the row renders no chip.
    expect(withoutEither.license).toBeUndefined();
    expect(withoutEither.source).toBeUndefined();
  });

  it('degrades to a visible broken row instead of throwing', () => {
    const cases = [
      ['', 'empty file'],
      ['# Just a heading\n\nNo frontmatter here.\n', 'no frontmatter block'],
      ['---\nname: broken\ndescription: "unterminated\n  - [a, b\n---\n\nbody\n', 'unparseable YAML'],
      ['---\n- just\n- a\n- list\n---\n\nbody\n', 'not a mapping'],
    ];
    for (const [markdown, label] of cases) {
      let fm: ReturnType<typeof parseSkillFrontmatter> | undefined;
      expect(() => {
        fm = parseSkillFrontmatter(markdown);
      }).not.toThrow();
      expect(fm?.ok).toBe(false);
      expect(typeof fm?.error).toBe('string');
      expect((fm?.error ?? '').length).toBeGreaterThan(0);
      // The row is rendered by directory name, so nothing here may be invented.
      expect(fm?.description).toBeUndefined();
      expect(label).toBeTruthy();
    }
  });

  it('applies the CLI\'s own YAML repair so our verdict matches its behaviour', () => {
    // An unquoted value containing `: ` throws in a strict YAML parse; the CLI
    // re-quotes it and parses again. A skill the CLI loads must not read
    // BROKEN here.
    const fm = parseSkillFrontmatter('---\nname: repairable\ndescription: Use this: for spreadsheets\n---\n\nbody\n');
    expect(fm.ok).toBe(true);
    expect(fm.description).toBe('Use this: for spreadsheets');
  });

  it('keeps metadata as a string map and drops non-scalar values', () => {
    const fm = parseSkillFrontmatter(
      '---\nname: m\ndescription: d\nmetadata:\n  requires-connectors: hex\n  count: 2\n  nested:\n    a: b\n---\n',
    );
    expect(fm.metadata).toEqual({ 'requires-connectors': 'hex', count: '2' });
  });

  it('never claims the frontmatter name is the identity', () => {
    // 62 of openai/plugins' 607 skills disagree with their directory name, and
    // the CLI keys `.claude/skills` off the DIRENT name. `name` is a label.
    const fm = parseSkillFrontmatter('---\nname: box-content-api\ndescription: d\n---\n');
    expect(fm.name).toBe('box-content-api');
  });
});

describe('roster arithmetic against the real shipped tree', () => {
  const shipped = shippedSkillIds();
  const entries: RosterEntry[] = shipped.map((id) => {
    const fm = parseSkillFrontmatter(readSkillMd(id));
    return { id, description: fm.description, whenToUse: fm.whenToUse };
  });

  it('parses all 21 shipped skills', () => {
    expect(shipped).toHaveLength(21);
    for (const id of shipped) {
      expect(parseSkillFrontmatter(readSkillMd(id)).ok).toBe(true);
    }
  });

  it('reproduces the measured total description size', () => {
    // THE REGRESSION TEST FOR THE PARSER. A regex frontmatter reader gives
    // 4,594 here because it truncates every folded block scalar; a real YAML
    // parse gives 10,201. If this number collapses, the parser broke.
    //
    // `docs/design/skills-knowledge-loop.md` states 10,193. The 8-character
    // difference is entirely manage-mini-application: that document's
    // measurement collapsed the 8 double-spaces its folded scalar produces.
    // 10,201 is what js-yaml returns and what the model actually receives.
    const total = entries.reduce((sum, e) => sum + (e.description?.length ?? 0), 0);
    expect(total).toBe(10201);
  });

  it('is over budget at the SDK default and inside it at ours', () => {
    const usage = computeRosterUsage(entries, {
      contextTokens: ROSTER_CONTEXT_TOKENS_DEFAULT,
      fraction: ROSTER_DEFAULT_BUDGET_FRACTION,
    });
    expect(usage.entries).toBe(21);
    expect(usage.chars).toBe(10595);
    expect(usage.budget).toBe(8000);
    // This is the state Acabox ships in today: roughly ten of twenty-one
    // descriptions are being silently shortened before a single import.
    expect(usage.fits).toBe(false);

    const widened = computeRosterUsage(entries, {
      contextTokens: ROSTER_CONTEXT_TOKENS_DEFAULT,
      fraction: ACABOX_ROSTER_BUDGET_FRACTION,
    });
    expect(widened.budget).toBe(40000);
    expect(widened.fits).toBe(true);
  });

  it('reports no per-skill description over the 1536-char cap', () => {
    // Nothing shipped is individually truncated — the pressure is the total.
    const usage = computeRosterUsage(entries, { contextTokens: ROSTER_CONTEXT_TOKENS_DEFAULT });
    expect(usage.descCappedIds).toEqual([]);
  });
});

describe('rosterBudgetChars', () => {
  it('follows the CLI formula: contextTokens * 4 * fraction', () => {
    expect(rosterBudgetChars({ contextTokens: 200_000, fraction: 0.01 })).toBe(8000);
    expect(rosterBudgetChars({ contextTokens: 200_000, fraction: 0.05 })).toBe(40_000);
    expect(rosterBudgetChars({ contextTokens: 1_000_000, fraction: 0.01 })).toBe(40_000);
  });

  it('falls back to 8000 * (fraction / 0.01) when the context size is unknown', () => {
    expect(rosterBudgetChars({})).toBe(8000);
    expect(rosterBudgetChars({ fraction: 0.05 })).toBe(40_000);
  });

  it('lets SLASH_COMMAND_TOOL_CHAR_BUDGET win unconditionally', () => {
    // The CLI checks the env var first and returns immediately. It is the
    // documented fallback if `skillListingBudgetFraction` is ever ignored.
    expect(rosterBudgetChars({ contextTokens: 200_000, fraction: 0.05, envBudgetChars: 1234 })).toBe(1234);
  });
});

describe('rosterLine', () => {
  it('builds the CLI\'s `- name: description` form', () => {
    expect(rosterLine({ id: 'pdf', description: 'Work with PDFs.' })).toBe('- pdf: Work with PDFs.');
  });

  it('concatenates when_to_use the way the CLI does', () => {
    expect(rosterLine({ id: 'pdf', description: 'A.', whenToUse: 'B.' })).toBe('- pdf: A. - B.');
  });

  it('caps an over-long description at exactly maxDescChars', () => {
    const line = rosterLine({ id: 'x', description: 'y'.repeat(2000) }, ROSTER_DEFAULT_MAX_DESC_CHARS);
    expect(line).toHaveLength(2 + 1 + 2 + ROSTER_DEFAULT_MAX_DESC_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('buildSkillRuntimeConfig', () => {
  const entry = (over: Partial<SkillStateEntry> = {}): SkillStateEntry => ({
    origin: 'builtin',
    enabled: true,
    ...over,
  });

  const state = (skills: Record<string, SkillStateEntry>): SkillsState => ({
    ...emptySkillsState(),
    skills,
  });

  it('returns only enabled, non-removed store ids, plus the bundled allowlist', () => {
    const result = buildSkillRuntimeConfig(
      state({
        xlsx: entry(),
        pdf: entry(),
        'airtable-cli': entry({ origin: 'imported', enabled: false }),
        'differential-expression': entry({ removed: true }),
      }),
    );
    expect(result).toEqual(['pdf', 'xlsx', 'claude-api']);
  });

  it('suppresses the bundled skills we do not want, and keeps the one we do', () => {
    const result = buildSkillRuntimeConfig(state({ xlsx: entry() }));
    // update-config's whole purpose is to rewrite settings.json, which is
    // where Acabox's install-blocking and secret-blocking hooks live.
    expect(result).not.toContain('update-config');
    for (const bundled of BUNDLED_SDK_SKILLS) {
      if (BUNDLED_ALLOW.includes(bundled)) continue;
      expect(result).not.toContain(bundled);
    }
    expect(result).toEqual(expect.arrayContaining([...BUNDLED_ALLOW]));
  });

  it('is never empty, even with an empty store', () => {
    // `Options.skills: []` means "load no skills" and makes every Skill() call
    // fail with errorCode 8; omitting the option means "load everything". The
    // bundled allowlist keeps those two cases from ever being confused.
    expect(buildSkillRuntimeConfig(emptySkillsState())).toEqual(['claude-api']);
  });

  it('is deterministic, so the live and crash-restart configs cannot diverge', () => {
    // The connector work already shipped this bug once: two call sites
    // computing the same list differently meant a crash silently changed which
    // tools were auto-approved.
    const a = buildSkillRuntimeConfig(state({ xlsx: entry(), acabox: entry(), pdf: entry() }));
    const b = buildSkillRuntimeConfig(state({ pdf: entry(), xlsx: entry(), acabox: entry() }));
    expect(a).toEqual(b);
    expect(a).toEqual(['acabox', 'pdf', 'xlsx', 'claude-api']);
  });

  it('does not duplicate an allowed bundled name that also exists in the store', () => {
    const result = buildSkillRuntimeConfig(state({ 'claude-api': entry({ origin: 'custom' }) }));
    expect(result).toEqual(['claude-api']);
  });
});
