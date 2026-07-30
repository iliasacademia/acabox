/**
 * Hashing for the skill store, against REAL temp trees.
 *
 * A mocked `fs` would only prove the mock agrees with itself, and every claim
 * here is a claim about the filesystem: that a rename registers, that `touch`
 * does not, that the exec bit is part of a skill's identity, and — the one
 * that couples two files together — that a copy with `preserveTimestamps`
 * leaves the >5 MB fallback hash unchanged.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  LARGE_FILE_FALLBACK_BYTES,
  hashFile,
  hashFileIf,
  hashSkillFiles,
  hashTree,
  readPristineManifest,
  readSkillTree,
} from '../skillHash';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-skillhash-'));
const dir = path.join(tmpRoot, 'tree');

function write(rel: string, content: string | Buffer, mode?: number): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mode !== undefined) fs.chmodSync(abs, mode);
  return abs;
}

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('hashFile', () => {
  it('is a plain sha256 of the bytes, self-labelled', () => {
    const abs = write('SKILL.md', 'hello');
    expect(hashFile(abs)).toBe(
      `sha256:${crypto.createHash('sha256').update('hello').digest('hex')}`,
    );
  });

  /** The whole "modified is derived" property: same bytes, same answer, no
   *  matter which of the four write paths produced them. */
  it('ignores mtime, so touching a file is not a modification', () => {
    const abs = write('a.txt', 'same');
    const before = hashFile(abs);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(abs, future, future);
    expect(hashFile(abs)).toBe(before);
  });

  it('hashes a symlink as its target STRING, never as what it points at', () => {
    write('real.txt', 'contents of the target');
    const link = path.join(dir, 'link');
    fs.symlinkSync('real.txt', link);
    expect(hashFile(link)).toBe(
      `link:${crypto.createHash('sha256').update('real.txt').digest('hex')}`,
    );
    // Changing what it points AT must not change the link's own hash — the
    // link is part of the skill's shape; the target may be outside it.
    fs.writeFileSync(path.join(dir, 'real.txt'), 'rewritten');
    expect(hashFile(link)).toBe(
      `link:${crypto.createHash('sha256').update('real.txt').digest('hex')}`,
    );
  });

  it('samples a file past the large-file threshold instead of reading it whole', () => {
    const abs = write('data.csv', Buffer.alloc(LARGE_FILE_FALLBACK_BYTES + 1, 0x61));
    expect(hashFile(abs)).toMatch(
      new RegExp(`^partial-sha256:${LARGE_FILE_FALLBACK_BYTES + 1}:[0-9a-f]{64}$`),
    );
  });

  /**
   * WHY THE FALLBACK IS NOT "size + mtime", which is what the design doc says.
   *
   * The store is seeded and reverted with `preserveTimestamps: true`, and that
   * option ROUNDS mtime to whole milliseconds — measured here, not assumed. A
   * size+mtime hash would therefore differ between pristine and store on the
   * very copy that seeds the store, so a large built-in file would read
   * MODIFIED forever behind a Revert button that could never clear it.
   */
  it('cpSync does not preserve mtime exactly, which is why mtime is not hashed', () => {
    const src = write('big.bin', Buffer.alloc(LARGE_FILE_FALLBACK_BYTES + 4096, 0x62));
    const dest = path.join(tmpRoot, 'copy-of-big.bin');
    fs.cpSync(src, dest, { preserveTimestamps: true });

    const srcMtime = fs.statSync(src).mtimeMs;
    const destMtime = fs.statSync(dest).mtimeMs;

    // Assert the INVARIANT, not one runtime's rounding. `mtimeMs` is a float
    // derived from a nanosecond stat field, and how it lands differs between
    // the Node the app runs on (22.17, via Electron 37) and a modern standalone
    // Node: measured, `Math.round(srcMtime) === destMtime` holds on 25.x but
    // is off by 0.001ms on 22.17. Pinning either one makes this test a tripwire
    // for the runtime rather than for the product.
    //
    // What actually matters is only this: the copy's mtime is CLOSE but NOT
    // BIT-IDENTICAL, so a size+mtime fallback hash would differ between
    // pristine and store on the very copy that seeds the store — a large
    // built-in file would read MODIFIED forever behind a Revert that could
    // never clear it.
    expect(destMtime).not.toBe(srcMtime);
    expect(Math.abs(destMtime - srcMtime)).toBeLessThan(1);

    // …and the hash is identical anyway, because it does not look at mtime.
    expect(hashFile(dest)).toBe(hashFile(src));
    fs.rmSync(dest, { force: true });
  });

  it('notices a change at either end of an oversized file', () => {
    const size = LARGE_FILE_FALLBACK_BYTES + 4096;
    const abs = write('big.bin', Buffer.alloc(size, 0x62));
    const before = hashFile(abs);

    const fd = fs.openSync(abs, 'r+');
    fs.writeSync(fd, Buffer.from('HEAD'), 0, 4, 0);
    fs.closeSync(fd);
    const afterHead = hashFile(abs);
    expect(afterHead).not.toBe(before);

    const fd2 = fs.openSync(abs, 'r+');
    fs.writeSync(fd2, Buffer.from('TAIL'), 0, 4, size - 4);
    fs.closeSync(fd2);
    expect(hashFile(abs)).not.toBe(afterHead);
  });

  /** The accepted cost, pinned so nobody discovers it as a surprise: a
   *  same-length edit in the middle of an oversized file is invisible. */
  it('does not see a same-length edit in the middle of an oversized file', () => {
    const size = LARGE_FILE_FALLBACK_BYTES + 4 * 64 * 1024;
    const abs = write('big.bin', Buffer.alloc(size, 0x62));
    const before = hashFile(abs);
    const fd = fs.openSync(abs, 'r+');
    fs.writeSync(fd, Buffer.from('MIDDLE'), 0, 6, Math.floor(size / 2));
    fs.closeSync(fd);
    expect(hashFile(abs)).toBe(before);
  });

  it('reports undefined rather than throwing for a path that is not there', () => {
    expect(hashFileIf(path.join(dir, 'nope'))).toBeUndefined();
    expect(() => hashFile(path.join(dir, 'nope'))).toThrow();
  });
});

describe('readSkillTree', () => {
  it('walks recursively, sorted by POSIX-relative path', () => {
    write('SKILL.md', 'a');
    write('scripts/b.py', 'b');
    write('scripts/a.py', 'c');
    write('references/findings/index.md', 'd');
    expect(readSkillTree(dir).map((f) => f.relPath)).toEqual([
      'SKILL.md',
      'references/findings/index.md',
      'scripts/a.py',
      'scripts/b.py',
    ]);
  });

  it('records the exec bit for regular files', () => {
    write('plain.py', 'x', 0o644);
    write('runnable.py', 'x', 0o755);
    const byPath = Object.fromEntries(readSkillTree(dir).map((f) => [f.relPath, f.exec]));
    expect(byPath).toEqual({ 'plain.py': false, 'runnable.py': true });
  });

  /**
   * macOS reports mode 0o755 on a symlink's own lstat, so counting it would
   * claim every skill that ships a link also ships an executable — and the
   * import flow states an exec count to the user before they commit.
   */
  it('never counts a symlink as executable', () => {
    write('real.txt', 'x', 0o644);
    fs.symlinkSync('real.txt', path.join(dir, 'link'));
    expect((fs.lstatSync(path.join(dir, 'link')).mode & 0o111) !== 0).toBe(true);
    expect(readSkillTree(dir).find((f) => f.relPath === 'link')!.exec).toBe(false);
  });

  it('treats a symlinked directory as a leaf and does not walk through it', () => {
    fs.mkdirSync(path.join(tmpRoot, 'outside', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'outside', 'deep', 'secret.txt'), 'x');
    write('SKILL.md', 'a');
    fs.symlinkSync(path.join(tmpRoot, 'outside'), path.join(dir, 'elsewhere'), 'dir');

    const rels = readSkillTree(dir).map((f) => f.relPath);
    expect(rels).toEqual(['SKILL.md', 'elsewhere']);
    expect(rels).not.toContain('elsewhere/deep/secret.txt');
    fs.rmSync(path.join(tmpRoot, 'outside'), { recursive: true, force: true });
  });
});

describe('hashTree', () => {
  it('changes when content changes', () => {
    write('SKILL.md', 'one');
    const before = hashTree(dir);
    write('SKILL.md', 'two');
    expect(hashTree(dir)).not.toBe(before);
  });

  /** The path is in the hash, so a rename is a change even though every byte
   *  in the tree is identical. */
  it('changes when a file is renamed', () => {
    write('scripts/run.py', 'same bytes');
    const before = hashTree(dir);
    fs.renameSync(path.join(dir, 'scripts/run.py'), path.join(dir, 'scripts/go.py'));
    expect(hashTree(dir)).not.toBe(before);
  });

  /** `chmod +x scripts/*.py` is a real difference for a skill that ships
   *  runnable scripts, so it is in the hash. */
  it('changes when the exec bit changes', () => {
    const abs = write('scripts/run.py', 'x', 0o644);
    const before = hashTree(dir);
    fs.chmodSync(abs, 0o755);
    expect(hashTree(dir)).not.toBe(before);
  });

  it('does not change when a file is merely touched', () => {
    const abs = write('SKILL.md', 'stable');
    const before = hashTree(dir);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(abs, future, future);
    expect(hashTree(dir)).toBe(before);
  });

  it('is stable across two reads of the same tree', () => {
    write('SKILL.md', 'a');
    write('scripts/x.py', 'b', 0o755);
    expect(hashTree(dir)).toBe(hashTree(dir));
  });

  it('hashes a missing directory as an empty tree', () => {
    expect(hashTree(path.join(tmpRoot, 'not-there'))).toBe(hashTree(dir));
  });
});

describe('hashSkillFiles', () => {
  it('is the relPath -> hash shape a baseline is stored in', () => {
    write('SKILL.md', 'a');
    write('scripts/run.py', 'b');
    expect(hashSkillFiles(dir)).toEqual({
      'SKILL.md': hashFile(path.join(dir, 'SKILL.md')),
      'scripts/run.py': hashFile(path.join(dir, 'scripts/run.py')),
    });
  });
});

describe('readPristineManifest', () => {
  const root = path.join(tmpRoot, 'pristine');

  const putSkill = (id: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, id, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  };

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  it('counts a directory as a skill only when it contains SKILL.md', () => {
    putSkill('real-skill', { 'SKILL.md': 'x' });
    putSkill('not-a-skill', { 'README.md': 'x' });
    const manifest = readPristineManifest(root);
    expect([...manifest.skills.keys()]).toEqual(['real-skill']);
  });

  it('carries per-file hashes ready to seed a baseline', () => {
    putSkill('s', { 'SKILL.md': 'x', 'scripts/run.py': 'y' });
    expect(readPristineManifest(root).skills.get('s')!.files).toEqual({
      'SKILL.md': hashFile(path.join(root, 's', 'SKILL.md')),
      'scripts/run.py': hashFile(path.join(root, 's', 'scripts', 'run.py')),
    });
  });

  /**
   * `rootHash` is the reconcile trigger that makes a dev `git pull` behave
   * identically to a release: the version string does not move, the tree does.
   */
  it('moves rootHash when any shipped skill changes', () => {
    putSkill('a', { 'SKILL.md': 'x' });
    putSkill('b', { 'SKILL.md': 'y' });
    const before = readPristineManifest(root).rootHash;

    putSkill('b', { 'SKILL.md': 'y2' });
    const afterEdit = readPristineManifest(root).rootHash;
    expect(afterEdit).not.toBe(before);

    putSkill('c', { 'SKILL.md': 'z' });
    expect(readPristineManifest(root).rootHash).not.toBe(afterEdit);
  });

  it('returns an empty manifest rather than throwing when nothing ships', () => {
    const manifest = readPristineManifest(path.join(tmpRoot, 'absent'));
    expect(manifest.skills.size).toBe(0);
    expect(manifest.rootHash).toMatch(/^sha256:/);
  });
});
