/**
 * Compile-time validation of the AppleScript that drives Word's find/replace.
 *
 * AppleScript Word automation is a minefield of dictionary collisions: terms
 * like `case` and `length` are exported as Word properties, so AppleScript
 * keywords (`considering case`, `length of …`) silently re-bind and fail
 * with "-2741: Expected … consideration but found property" only when the
 * script actually runs against Word. The error message gives a character
 * offset and nothing else, and every iteration costs a full Electron+Word
 * restart.
 *
 * This test pipes every permutation of buildFindReplaceScript() through
 * `osacompile`, which compiles AppleScript to a binary without running it.
 * Compilation surfaces -2741 and friends in milliseconds and from CI/dev
 * machines, so dictionary collisions never make it to a Word session again.
 *
 * `osacompile` is only present on macOS; the test no-ops elsewhere.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { buildFindReplaceScript, BuildScriptOpts } from '../wordFindReplaceScript';

const isMac = process.platform === 'darwin' && existsSync('/usr/bin/osacompile');

function compileAppleScript(script: string): { ok: true } | { ok: false; error: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'word-fr-test-'));
  const srcPath = path.join(dir, 'script.applescript');
  const outPath = path.join(dir, 'script.scpt');
  try {
    writeFileSync(srcPath, script, 'utf8');
    try {
      execFileSync('/usr/bin/osacompile', ['-o', outPath, srcPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true };
    } catch (err: any) {
      const stderr = (err.stderr ?? '').toString();
      const stdout = (err.stdout ?? '').toString();
      return { ok: false, error: `${stderr}${stdout}`.trim() || err.message };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const baseOpts: BuildScriptOpts = {
  searchPath: '/tmp/search.txt',
  replacePath: '/tmp/replace.txt',
  originalSearchPath: '/tmp/search-original.txt',
  replaceAll: false,
  matchCase: true,
  sanitizeChangedSearch: false,
  isLongSearch: false,
};

// Every distinct combination of the boolean flags that drive code-path
// inclusion in the rendered script. 16 permutations is small enough to
// exhaustively cover, and every combination has actually fired in prod.
function allPermutations(): BuildScriptOpts[] {
  const out: BuildScriptOpts[] = [];
  for (const replaceAll of [false, true]) {
    for (const matchCase of [false, true]) {
      for (const sanitizeChangedSearch of [false, true]) {
        for (const isLongSearch of [false, true]) {
          out.push({ ...baseOpts, replaceAll, matchCase, sanitizeChangedSearch, isLongSearch });
        }
      }
    }
  }
  return out;
}

describe('buildFindReplaceScript', () => {
  it('emits Pass 4 (progressive anchor + extend) only when isLongSearch is true', () => {
    // Word's find object caps at ~255 chars; the long-search path is the
    // only one allowed to fall through to anchor+extend. Short-search
    // scripts must NOT include the Pass 4 block, otherwise they'd run a
    // useless extra tell-block on every short find.
    const longScript = buildFindReplaceScript({ ...baseOpts, isLongSearch: true });
    const shortScript = buildFindReplaceScript({ ...baseOpts, isLongSearch: false });
    expect(longScript).toContain('Pass 4 progressive anchor');
    expect(longScript).toContain('anchorSizesList to {200, 120, 60}');
    expect(longScript).toContain('execute find anchorFind');
    // Pass 4 lives behind a runtime `if ... isLongSearch` guard that
    // collapses to `false` in short-search builds, so the inner text
    // ("execute find anchorFind") never reaches Word — but the literal
    // sentinel string MUST also disappear from the rendered script when
    // isLongSearch=false, since its presence would mean we're emitting
    // dead AppleScript on every short call.
    expect(shortScript).not.toContain('Pass 4 progressive anchor');
  });

  it('does not use AppleScript keywords that collide with the Word dictionary', () => {
    // Static guard: catch the common offenders without invoking the
    // compiler so this fails on any OS. Word exports `case`, `length`, and
    // `offset` as properties; AppleScript's `considering case` and
    // `length of …` collide with the first two. `offset of` is fine but
    // ONLY when used outside any `tell application "Microsoft Word"`
    // block — that scope rule is the test's job, not this static check.
    const stripComments = (s: string) =>
      s.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
    for (const opts of allPermutations()) {
      const code = stripComments(buildFindReplaceScript(opts));
      expect(code).not.toMatch(/considering\s+case\b/);
      expect(code).not.toMatch(/\blength of\b/);
    }
  });

  // Below is the real safety net — it actually compiles the script.
  // Skipped on non-macOS so the suite passes on CI Linux runners.
  (isMac ? describe : describe.skip)('osacompile (macOS)', () => {
    it.each(allPermutations())(
      'compiles cleanly for replaceAll=$replaceAll matchCase=$matchCase sanitizeChangedSearch=$sanitizeChangedSearch isLongSearch=$isLongSearch',
      (opts) => {
        const script = buildFindReplaceScript(opts);
        const result = compileAppleScript(script);
        if (!result.ok) {
          // Surface the first compile error with full context so we don't
          // have to grep through 16 failures.
          throw new Error(`osacompile failed:\n${result.error}\n\nScript was:\n${script}`);
        }
      },
    );
  });
});
