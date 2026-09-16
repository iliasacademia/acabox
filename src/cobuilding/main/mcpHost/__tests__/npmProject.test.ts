/**
 * Increment 6a (`docs/design/mcp-hosting.md`) — `mcpHost/npmProject.ts`.
 *
 * `resolveEntryFile` is the part worth pinning hardest, because getting it
 * wrong does not look like a resolution bug: the child starts, exits 0
 * immediately, and the user gets "the server did not answer initialize",
 * which points nowhere near the cause. An MCP server is a COMMAND, so `bin`
 * is its entry; `main` is the library entry and for a server is frequently
 * either absent or a module that exports helpers and starts nothing.
 *
 * Real package.json files on a real temp disk — the thing this function
 * actually reads. No mocks at all in this file.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveEntryFile, installProjectDeps } from '../npmProject';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-npmproject-'));

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Write a package dir with the given manifest and the files it references. */
function pkgDir(name: string, manifest: Record<string, unknown>, files: string[] = []): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest), 'utf-8');
  for (const f of files) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// stub\n', 'utf-8');
  }
  return dir;
}

describe('resolveEntryFile', () => {
  it('takes a string "bin"', () => {
    const dir = pkgDir('a', { name: 'a', bin: 'dist/cli.js' }, ['dist/cli.js']);
    expect(resolveEntryFile(dir, 'a')).toBe(path.join(dir, 'dist/cli.js'));
  });

  it('prefers "bin" over "main" — a server is a command, not a library', () => {
    const dir = pkgDir('b', { name: 'b', bin: 'cli.js', main: 'index.js' }, ['cli.js', 'index.js']);
    expect(resolveEntryFile(dir, 'b')).toBe(path.join(dir, 'cli.js'));
  });

  it('picks the bin whose NAME matches the package, not just the first key', () => {
    const dir = pkgDir('c', {
      name: 'c',
      bin: { 'some-helper': 'helper.js', c: 'server.js' },
    }, ['helper.js', 'server.js']);
    expect(resolveEntryFile(dir, 'c')).toBe(path.join(dir, 'server.js'));
  });

  it('falls back to the first bin when none matches the name', () => {
    const dir = pkgDir('d', { name: 'd', bin: { alpha: 'alpha.js', beta: 'beta.js' } }, ['alpha.js', 'beta.js']);
    expect(resolveEntryFile(dir, 'd')).toBe(path.join(dir, 'alpha.js'));
  });

  it('matches on the SHORT name for a scoped package', () => {
    // `@scope/server-x`'s bin is conventionally keyed `server-x`.
    const dir = pkgDir('e', { name: '@scope/server-x', bin: { 'server-x': 'run.js' } }, ['run.js']);
    expect(resolveEntryFile(dir, '@scope/server-x')).toBe(path.join(dir, 'run.js'));
  });

  it('uses "main" when there is no bin at all', () => {
    const dir = pkgDir('f', { name: 'f', main: 'lib/index.js' }, ['lib/index.js']);
    expect(resolveEntryFile(dir, 'f')).toBe(path.join(dir, 'lib/index.js'));
  });

  it('refuses a package that declares neither, instead of guessing index.js', () => {
    const dir = pkgDir('g', { name: 'g' });
    expect(() => resolveEntryFile(dir, 'g')).toThrow(/neither "bin" nor "main"/);
  });

  it('refuses when the declared entry is not actually in the package', () => {
    // A stale "bin" pointing at a file excluded from the published tarball is
    // a real and common packaging bug. Catching it here beats a spawn ENOENT.
    const dir = pkgDir('h', { name: 'h', bin: 'dist/missing.js' });
    expect(() => resolveEntryFile(dir, 'h')).toThrow(/not in the installed package/);
  });

  it('explains the unbuilt-TypeScript case instead of just naming the missing file', () => {
    // The single most likely GitHub failure, measured against
    // modelcontextprotocol/servers@d73f99ef `src/memory`: the repo ships .ts,
    // `bin` points into dist/, and Acabox never runs build scripts. "points
    // at dist/index.js" is true and useless; this says why and what to do.
    const dir = pkgDir('ts-src', { name: 'ts-src', bin: 'dist/index.js' }, ['src/index.ts', 'tsconfig.json']);
    expect(() => resolveEntryFile(dir, 'ts-src')).toThrow(/TypeScript source/);
    expect(() => resolveEntryFile(dir, 'ts-src')).toThrow(/Install this server from npm instead/);
  });

  it('detects unbuilt source from a src/*.ts tree even with no tsconfig', () => {
    const dir = pkgDir('ts-notsconfig', { name: 'ts-notsconfig', bin: 'build/main.js' }, ['src/main.ts']);
    expect(() => resolveEntryFile(dir, 'ts-notsconfig')).toThrow(/TypeScript source/);
  });

  it('does NOT blame TypeScript for a genuinely stale bin in a JS package', () => {
    // No TS anywhere: the honest message is the plain one. Guessing
    // "needs a build" here would send the user off to fix the wrong thing.
    const dir = pkgDir('js-stale', { name: 'js-stale', bin: 'dist/gone.js' }, ['index.js']);
    expect(() => resolveEntryFile(dir, 'js-stale')).toThrow(/not in the installed package/);
    expect(() => resolveEntryFile(dir, 'js-stale')).not.toThrow(/TypeScript/);
  });

  it('does not blame a build step when the entry is not a build path at all', () => {
    const dir = pkgDir('root-missing', { name: 'root-missing', bin: 'server.js' }, ['src/x.ts', 'tsconfig.json']);
    expect(() => resolveEntryFile(dir, 'root-missing')).toThrow(/not in the installed package/);
  });

  it('refuses an unreadable package.json rather than throwing a raw SyntaxError', () => {
    const dir = path.join(tmpDir, 'i');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json', 'utf-8');
    expect(() => resolveEntryFile(dir, 'i')).toThrow(/no readable package\.json/);
  });
});

describe('installProjectDeps', () => {
  // These two branches are the common case for an MCP server — the
  // `manage-mcp-server` scaffold produces a single dependency-free file — and
  // they must not shell out to npm at all. If they ever did, this test would
  // take seconds and need a network; that it is instant IS the assertion.
  it('does nothing when there is no package.json', async () => {
    const dir = path.join(tmpDir, 'no-manifest');
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    await installProjectDeps(dir, (l) => lines.push(l));
    expect(lines.join('\n')).toMatch(/nothing to install/i);
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
  });

  it('does nothing when dependencies is absent or empty', async () => {
    for (const [name, manifest] of [
      ['deps-absent', { name: 'x', version: '1.0.0' }],
      ['deps-empty', { name: 'x', version: '1.0.0', dependencies: {} }],
    ] as const) {
      const dir = pkgDir(name, manifest);
      const lines: string[] = [];
      await installProjectDeps(dir, (l) => lines.push(l));
      expect(lines.join('\n')).toMatch(/No runtime dependencies/i);
      expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    }
  });

  it('refuses a malformed package.json rather than handing it to npm', async () => {
    const dir = path.join(tmpDir, 'bad-manifest');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{{{', 'utf-8');
    await expect(installProjectDeps(dir, () => { /* ignore */ }))
      .rejects.toThrow(/not valid JSON/);
  });
});
