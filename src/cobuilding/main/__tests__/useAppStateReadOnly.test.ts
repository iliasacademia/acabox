/**
 * `useAppState` must not attempt to persist inside a published, read-only
 * snapshot.
 *
 * Asserted against the SHIPPED SOURCE rather than by running the hook. The
 * file is a mini-app asset: it is not in the tsc project and is bundled
 * per-app by esbuild at build time, so nothing else in this repo would catch
 * a guard being dropped. The same technique, and the same reason, as the
 * mini-app selection shim's "no requestAnimationFrame" test.
 *
 * Why it matters: the save is DEBOUNCED OFF STATE CHANGES, so it fires on
 * load with nobody touching the page. In a snapshot the shim refuses every
 * write, so an unguarded attempt reaches the viewer as a console error for
 * something they never did — which is exactly what a real share did on
 * 2026-09-16.
 */

import * as fs from 'fs';
import * as path from 'path';

const USE_APP_STATE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'manage-mini-application',
  'assets',
  'reusable',
  'useAppState.ts',
);

const source = fs.readFileSync(USE_APP_STATE_PATH, 'utf8');

/** Every `window.filesAPI.writeFile` call site, with its preceding context. */
function writeFileCallSites(): string[] {
  const lines = source.split('\n');
  const sites: string[] = [];
  lines.forEach((line, i) => {
    // `.writeFile(` with the leading dot, so the `filesAPI` type
    // declaration at the top of the file ("writeFile(path: string, …") is
    // not counted as a call site.
    if (!line.includes('.writeFile(')) return;
    // A window of preceding lines is enough to see the guard: both call
    // sites are within a few lines of theirs.
    sites.push(lines.slice(Math.max(0, i - 8), i + 1).join('\n'));
  });
  return sites;
}

describe('useAppState read-only guard', () => {
  it('defines the snapshot predicate through an optional bridge call', () => {
    // Optional, because a bundle built before the flag existed has no
    // `isReadOnly` at all; a bare call would throw inside Acabox too.
    expect(source).toContain('function isSharedSnapshot()');
    expect(source).toContain('typeof window.isReadOnly === "function"');
  });

  it('has exactly the three writeFile call sites this test knows about', () => {
    // A fourth one would be unreviewed by the assertion below. This count is
    // load-bearing: it is what caught `markRunComplete`, the one site missed
    // when the guard was first written.
    expect(writeFileCallSites()).toHaveLength(3);
  });

  it('guards every writeFile call site with the snapshot check', () => {
    for (const site of writeFileCallSites()) {
      expect(site).toContain('isSharedSnapshot()');
    }
  });

  it('still writes when not a snapshot — the guard is not an unconditional skip', () => {
    // Pins the polarity. `if (isSharedSnapshot()) return;` and
    // `if (!isSharedSnapshot()) { …write… }` are both correct; `return` with
    // no condition, or a negated debounce guard, would disable saving inside
    // Acabox and no other test here would notice.
    expect(source).toContain('if (isSharedSnapshot()) return;');
    expect(source).toContain('if (!isSharedSnapshot()) {');
  });
});
