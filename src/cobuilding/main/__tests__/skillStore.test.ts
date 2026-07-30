/**
 * The skill store, exercised against REAL temp trees — a real pristine
 * directory, a real store, a real trash, a real state file written through
 * `manifestIO`. `skills.ts` has zero tests today and it is the module that
 * silently deletes a user's edits at every boot, so nothing here is mocked
 * except Electron's path lookup and the logger.
 *
 * The property under test throughout is the same one sentence: **nothing the
 * user wrote is ever silently destroyed.** Every reconcile row, the adoption
 * inversion, the revert model and `restoreAllBuiltins`' structural guarantee
 * are all restatements of it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-skillstore-'));
const userData = path.join(tmpRoot, 'userData');
const appRoot = path.join(tmpRoot, 'app');
const pristineRoot = path.join(appRoot, 'src', 'cobuilding', 'skills');
const storeRoot = path.join(userData, 'skills');
const trashRoot = path.join(userData, 'skills-trash');
const stateFile = path.join(userData, 'skills-state.json');

let appVersion = '1.0.0';

jest.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getAppPath: () => appRoot,
    getVersion: () => appVersion,
    isPackaged: false,
  },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { buildSkillRuntimeConfig } from '../../shared/skills';
import { hashFile } from '../skillHash';
import {
  createSkill,
  deleteSkill,
  dismissFileUpdate,
  listSkills,
  modifiedFiles,
  pruneSkillsTrash,
  readSkillFile,
  readSkillsState,
  reconcile,
  restoreAllBuiltins,
  revertFile,
  revertSkill,
  setSkillEnabled,
  skillFileHash,
  summarizeBuiltinRestore,
  writeSkillFile,
} from '../skillStore';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const skillMd = (id: string, extra = '') =>
  `---\nname: ${id}\ndescription: Does ${id} things.\n---\n\n# ${id}\n\n${extra}`;

/** Write a shipped skill. Always gets a SKILL.md unless one is supplied. */
function putPristine(id: string, files: Record<string, string> = {}): void {
  const dir = path.join(pristineRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  if (!('SKILL.md' in files)) fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd(id));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

const dropPristine = (id: string) =>
  fs.rmSync(path.join(pristineRoot, id), { recursive: true, force: true });

const storePath = (id: string, rel = '') => path.join(storeRoot, id, rel);
const storeRead = (id: string, rel: string) => fs.readFileSync(storePath(id, rel), 'utf-8');
const storeExists = (id: string, rel = '') => fs.existsSync(storePath(id, rel));

function storeWrite(id: string, rel: string, content: string): void {
  const abs = storePath(id, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function descriptorFor(id: string) {
  return (await listSkills()).find((s) => s.id === id);
}

async function entryFor(id: string) {
  return (await readSkillsState()).skills[id];
}

/** Simulate a release: change what ships, then reconcile at a new version. */
async function upgrade(version = '1.1.0') {
  appVersion = version;
  return reconcile();
}

beforeEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(appRoot, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(pristineRoot, { recursive: true });
  appVersion = '1.0.0';
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('first run and idempotence', () => {
  it('seeds every shipped skill into the store with a per-file baseline', async () => {
    putPristine('acabox');
    putPristine('xlsx', { 'scripts/recalc.py': 'print(1)\n' });

    const result = await reconcile();

    expect(result.seeded.sort()).toEqual(['acabox', 'xlsx']);
    expect(result.upgraded).toBe(true); // nothing seeded yet, so everything moved
    expect(storeRead('xlsx', 'scripts/recalc.py')).toBe('print(1)\n');

    const entry = await entryFor('xlsx');
    expect(entry!.origin).toBe('builtin');
    expect(entry!.enabled).toBe(true);
    expect(Object.keys(entry!.baseline!).sort()).toEqual(['SKILL.md', 'scripts/recalc.py']);
    expect(entry!.baseline!['scripts/recalc.py']).toBe(
      hashFile(path.join(pristineRoot, 'xlsx', 'scripts', 'recalc.py')),
    );
  });

  it('leaves the pristine tree untouched', async () => {
    putPristine('acabox');
    const before = fs.readFileSync(path.join(pristineRoot, 'acabox', 'SKILL.md'), 'utf-8');
    await reconcile();
    await writeSkillFile('acabox', 'SKILL.md', 'rewritten by the user');
    expect(fs.readFileSync(path.join(pristineRoot, 'acabox', 'SKILL.md'), 'utf-8')).toBe(before);
  });

  it('is a no-op on the next boot', async () => {
    putPristine('acabox', { 'scripts/run.py': 'x' });
    await reconcile();

    const second = await reconcile();
    expect(second.upgraded).toBe(false);
    expect(second.seeded).toEqual([]);
    expect(second.fastForwarded).toEqual([]);
    expect(second.conflicts).toEqual([]);
  });

  it('reports a shipped, untouched skill as unmodified', async () => {
    putPristine('acabox');
    await reconcile();
    expect((await descriptorFor('acabox'))!.modified).toBe(false);
  });

  /** A custom skill has no pristine counterpart, so both `true` and `false`
   *  would be a claim we cannot support. The UI renders no chip on undefined. */
  it('reports `modified` as undefined for a custom skill', async () => {
    await createSkill('my-lab-protocol');
    expect((await descriptorFor('my-lab-protocol'))!.modified).toBeUndefined();
  });

  it('self-heals a built-in whose directory was deleted out from under it', async () => {
    putPristine('acabox');
    await reconcile();
    fs.rmSync(storePath('acabox'), { recursive: true, force: true });

    const result = await reconcile();
    expect(result.seeded).toEqual(['acabox']);
    expect(storeExists('acabox', 'SKILL.md')).toBe(true);
  });

  /**
   * A store entry that is not a directory is not a skill, and "something
   * exists at that path" is the wrong question to gate the re-seed on. Left
   * unhealed, the render still symlinks it and the CLI drops the skill
   * silently, because `<link>/SKILL.md` is ENOTDIR — a skill that is simply
   * absent from every session with nothing anywhere saying why.
   */
  it('self-heals a built-in whose directory was replaced by a regular file', async () => {
    putPristine('acabox');
    await reconcile();
    fs.rmSync(storePath('acabox'), { recursive: true, force: true });
    fs.writeFileSync(storePath('acabox'), 'not a directory');

    const result = await reconcile();
    expect(result.seeded).toEqual(['acabox']);
    expect(fs.statSync(storePath('acabox')).isDirectory()).toBe(true);
    expect(storeExists('acabox', 'SKILL.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('a local edit', () => {
  beforeEach(async () => {
    putPristine('acabox', { 'scripts/run.py': 'original\n' });
    await reconcile();
  });

  it('survives an ordinary boot — the headline win over copySkillsToWorkspace', async () => {
    storeWrite('acabox', 'SKILL.md', 'MY OWN VERSION');
    await reconcile();
    expect(storeRead('acabox', 'SKILL.md')).toBe('MY OWN VERSION');
  });

  it('makes the skill read MODIFIED, naming the file', async () => {
    storeWrite('acabox', 'scripts/run.py', 'edited\n');
    expect(modifiedFiles('acabox', (await entryFor('acabox'))!)).toEqual(['scripts/run.py']);
    expect((await descriptorFor('acabox'))!.modified).toBe(true);
  });

  it('clears by itself when the user edits it back', async () => {
    storeWrite('acabox', 'scripts/run.py', 'edited\n');
    expect((await descriptorFor('acabox'))!.modified).toBe(true);
    storeWrite('acabox', 'scripts/run.py', 'original\n');
    expect((await descriptorFor('acabox'))!.modified).toBe(false);
  });

  it('counts a deleted file and a user-added file as modifications', async () => {
    fs.rmSync(storePath('acabox', 'scripts/run.py'));
    storeWrite('acabox', 'notes.md', 'mine');
    expect(modifiedFiles('acabox', (await entryFor('acabox'))!)).toEqual([
      'notes.md',
      'scripts/run.py',
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('the reconcile table, one row at a time', () => {
  /** Row 1: B / B / B. */
  it('row 1 — nothing changed anywhere: no-op', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();
    const result = await upgrade();
    expect(result.fastForwarded).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(storeRead('s', 'f.txt')).toBe('v1');
  });

  /** Row 2: B / B / ≠B — the user edited, upstream did not. */
  it('row 2 — user edited, upstream unchanged: keep, reads MODIFIED', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();
    storeWrite('s', 'f.txt', 'mine');

    await upgrade();
    expect(storeRead('s', 'f.txt')).toBe('mine');
    expect((await descriptorFor('s'))!.modified).toBe(true);
  });

  /** Row 3: B / B / missing. */
  it('row 3 — user deleted, upstream unchanged: stays deleted and reads MODIFIED', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();
    fs.rmSync(storePath('s', 'f.txt'));

    await upgrade();
    expect(storeExists('s', 'f.txt')).toBe(false);
    expect((await descriptorFor('s'))!.modified).toBe(true);
  });

  /** Row 4: B / ≠B / B — the 99%-of-an-upgrade case. */
  it('row 4 — upstream changed, user did not: fast-forward silently', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();

    putPristine('s', { 'f.txt': 'v2' });
    const result = await upgrade();

    expect(result.fastForwarded).toEqual([{ id: 's', relPath: 'f.txt' }]);
    expect(storeRead('s', 'f.txt')).toBe('v2');
    expect((await descriptorFor('s'))!.modified).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  /** Row 5: B / ≠B / ∉{B,Pn} — the case a merge would get wrong. */
  it('row 5 — both changed: CONFLICT, the user keeps their bytes', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();
    storeWrite('s', 'f.txt', 'mine');

    putPristine('s', { 'f.txt': 'v2' });
    const result = await upgrade();

    expect(result.conflicts).toEqual([
      {
        id: 's',
        relPath: 'f.txt',
        kind: 'changed-upstream',
        upstreamHash: hashFile(path.join(pristineRoot, 's', 'f.txt')),
      },
    ]);
    expect(storeRead('s', 'f.txt')).toBe('mine');
    expect((await entryFor('s'))!.updateAvailable!['f.txt']).toBe(
      hashFile(path.join(pristineRoot, 's', 'f.txt')),
    );
  });

  /** Row 6: B / ≠B / missing. */
  it('row 6 — user deleted a file upstream then changed: conflict, stays deleted', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();
    fs.rmSync(storePath('s', 'f.txt'));

    putPristine('s', { 'f.txt': 'v2' });
    const result = await upgrade();

    expect(result.conflicts.map((c) => c.kind)).toEqual(['user-deleted-and-changed']);
    expect(storeExists('s', 'f.txt')).toBe(false);
  });

  /** Row 7: — / Pn / missing. */
  it('row 7 — a new file upstream is written and baselined', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();

    putPristine('s', { 'f.txt': 'v1', 'scripts/new.py': 'fresh' });
    await upgrade();

    expect(storeRead('s', 'scripts/new.py')).toBe('fresh');
    expect((await descriptorFor('s'))!.modified).toBe(false);
  });

  /** Row 8: — / Pn / present. */
  it('row 8 — the user got there first at a path upstream now ships: conflict', async () => {
    putPristine('s');
    await reconcile();
    storeWrite('s', 'notes.md', 'my notes');

    putPristine('s', { 'notes.md': 'shipped notes' });
    const result = await upgrade();

    expect(result.conflicts.map((c) => c.kind)).toEqual(['user-created-at-upstream-path']);
    expect(storeRead('s', 'notes.md')).toBe('my notes');
  });

  /** Addition to the table: identical bytes are not a conflict. Raising one
   *  would put UPDATE AVAILABLE on a file that is already up to date. */
  it('row 8b — the user created the same bytes upstream ships: adopt, no conflict', async () => {
    putPristine('s');
    await reconcile();
    storeWrite('s', 'notes.md', 'identical');

    putPristine('s', { 'notes.md': 'identical' });
    const result = await upgrade();

    expect(result.conflicts).toEqual([]);
    expect((await descriptorFor('s'))!.modified).toBe(false);
  });

  /** Row 9: B / — / B. */
  it('row 9 — dropped upstream and untouched: the file goes', async () => {
    putPristine('s', { 'f.txt': 'v1', 'old.txt': 'gone soon' });
    await reconcile();

    fs.rmSync(path.join(pristineRoot, 's', 'old.txt'));
    await upgrade();

    expect(storeExists('s', 'old.txt')).toBe(false);
    expect((await descriptorFor('s'))!.modified).toBe(false);
  });

  /** Row 10: B / — / ≠B. Upstream dropping a file is not consent to delete
   *  what the user wrote into it. */
  it('row 10 — dropped upstream but edited: the file stays', async () => {
    putPristine('s', { 'f.txt': 'v1', 'old.txt': 'shipped' });
    await reconcile();
    storeWrite('s', 'old.txt', 'my version');

    fs.rmSync(path.join(pristineRoot, 's', 'old.txt'));
    await upgrade();

    expect(storeRead('s', 'old.txt')).toBe('my version');
    expect((await entryFor('s'))!.baseline!['old.txt']).toBeUndefined();
  });

  /** Addition to the table: "keep mine" has to survive the next boot or the
   *  chip returns forever. */
  it('a dismissed conflict does not come back at the next reconcile', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();
    storeWrite('s', 'f.txt', 'mine');
    putPristine('s', { 'f.txt': 'v2' });
    await upgrade('1.1.0');

    expect(await dismissFileUpdate('s', 'f.txt')).toEqual({ ok: true, id: 's' });
    expect((await entryFor('s'))!.updateAvailable).toBeUndefined();

    const again = await upgrade('1.2.0');
    expect(again.conflicts).toEqual([]);
    expect(storeRead('s', 'f.txt')).toBe('mine');
  });

  it('a dismissal expires when the NEXT release moves that file again', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();
    storeWrite('s', 'f.txt', 'mine');
    putPristine('s', { 'f.txt': 'v2' });
    await upgrade('1.1.0');
    await dismissFileUpdate('s', 'f.txt');

    putPristine('s', { 'f.txt': 'v3' });
    const result = await upgrade('1.2.0');
    expect(result.conflicts.map((c) => c.kind)).toEqual(['changed-upstream']);
  });

  /** A dev `git pull` does not bump the version, so the tree hash has to be
   *  what triggers the pass. */
  it('runs on a pristine change with no version bump at all', async () => {
    putPristine('s', { 'f.txt': 'v1' });
    await reconcile();

    putPristine('s', { 'f.txt': 'v2' });
    const result = await reconcile(); // same appVersion
    expect(result.upgraded).toBe(true);
    expect(storeRead('s', 'f.txt')).toBe('v2');
  });
});

// ---------------------------------------------------------------------------

describe('skill-level upgrade outcomes', () => {
  it('seeds a built-in that appears in a new release', async () => {
    putPristine('a');
    await reconcile();

    putPristine('b');
    const result = await upgrade();
    expect(result.seeded).toEqual(['b']);
    expect(storeExists('b', 'SKILL.md')).toBe(true);
  });

  it('removes a built-in dropped upstream when nothing was edited', async () => {
    putPristine('a');
    putPristine('doomed');
    await reconcile();

    dropPristine('doomed');
    const result = await upgrade();

    expect(result.removedUpstream).toEqual(['doomed']);
    expect(storeExists('doomed')).toBe(false);
    expect(await entryFor('doomed')).toBeUndefined();
  });

  it('keeps a dropped built-in the user had edited, retagged as theirs', async () => {
    // `survivor` is not decoration. Dropping the only shipped skill would leave
    // an EMPTY pristine tree, which reconcile now treats as "the tree could not
    // be read" and refuses to act on — see `PristineManifest.available`. A real
    // release that drops one skill still ships the others, so this is the
    // faithful fixture.
    putPristine('survivor');
    putPristine('doomed', { 'SKILL.md': skillMd('doomed', 'shipped body') });
    await reconcile();
    storeWrite('doomed', 'SKILL.md', skillMd('doomed', 'MY body'));

    dropPristine('doomed');
    const result = await upgrade();

    expect(result.keptAsCustom).toEqual(['doomed']);
    const entry = await entryFor('doomed');
    expect(entry!.origin).toBe('custom');
    expect(entry!.formerlyBuiltin).toBe(true);
    expect(entry!.baseline).toBeUndefined();
    expect(storeRead('doomed', 'SKILL.md')).toContain('MY body');
    // No baseline means no comparison, so no chip — not a false "unmodified".
    expect((await descriptorFor('doomed'))!.modified).toBeUndefined();
  });

  it('does not re-seed a built-in the user removed', async () => {
    putPristine('unwanted');
    await reconcile();
    await deleteSkill('unwanted');

    const result = await upgrade();
    expect(result.seeded).toEqual([]);
    expect(storeExists('unwanted')).toBe(false);
    expect((await entryFor('unwanted'))!.removed).toBe(true);
  });

  /** Reconcile compares hashes, never version numbers, so an older shipped
   *  file is just another changed-upstream row. */
  it('treats a downgrade as an ordinary change', async () => {
    putPristine('s', { 'f.txt': 'v2' });
    await reconcile();

    putPristine('s', { 'f.txt': 'v1' });
    appVersion = '0.9.0';
    const result = await reconcile();
    expect(result.fastForwarded).toEqual([{ id: 's', relPath: 'f.txt' }]);
    expect(storeRead('s', 'f.txt')).toBe('v1');
  });
});

// ---------------------------------------------------------------------------

describe('host-owned paths', () => {
  it('are never baselined and never read as a modification', async () => {
    putPristine('ledger-skill');
    await reconcile();
    storeWrite('ledger-skill', 'references/findings/index.md', '| F-001 | … |');

    const entry = await entryFor('ledger-skill');
    expect(modifiedFiles('ledger-skill', entry!)).toEqual([]);
    expect((await descriptorFor('ledger-skill'))!.modified).toBe(false);
  });

  it('survive an upgrade untouched', async () => {
    putPristine('ledger-skill', { 'f.txt': 'v1' });
    await reconcile();
    storeWrite('ledger-skill', 'references/findings/messages.md', 'sixty findings');

    putPristine('ledger-skill', { 'f.txt': 'v2' });
    await upgrade();

    expect(storeRead('ledger-skill', 'references/findings/messages.md')).toBe('sixty findings');
    expect((await entryFor('ledger-skill'))!.baseline!['references/findings/messages.md'])
      .toBeUndefined();
  });

  /** The whole reason `hostOwnedPaths` is specified this early: a user who
   *  grew sixty findings inside a skill must not lose them to a Revert. */
  it('survive revertSkill, which wipes everything else the user added', async () => {
    putPristine('ledger-skill', { 'f.txt': 'v1' });
    await reconcile();
    storeWrite('ledger-skill', 'references/findings/index.md', 'F-001 … F-060');
    storeWrite('ledger-skill', 'my-notes.md', 'these do go');
    storeWrite('ledger-skill', 'f.txt', 'edited');

    expect((await revertSkill('ledger-skill')).ok).toBe(true);

    expect(storeRead('ledger-skill', 'references/findings/index.md')).toBe('F-001 … F-060');
    expect(storeExists('ledger-skill', 'my-notes.md')).toBe(false);
    expect(storeRead('ledger-skill', 'f.txt')).toBe('v1');
  });

  it('cannot be reverted individually', async () => {
    putPristine('ledger-skill');
    await reconcile();
    storeWrite('ledger-skill', 'references/findings/index.md', 'mine');
    const result = await revertFile('ledger-skill', 'references/findings/index.md');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/written by Acabox/);
  });

  /**
   * `restoreAllBuiltins` is the riskiest caller — one click, every built-in —
   * and it reaches the ledger through `revertSkill` rather than through any
   * host-owned check of its own. Both shapes are covered because they take
   * different branches: `edited` is reverted, `pristine-body` is not touched
   * at all (findings are excluded from `modifiedFiles`, so it reads unmodified).
   */
  it('survive restoreAllBuiltins, whether or not the skill was also edited', async () => {
    putPristine('edited', { 'f.txt': 'shipped' });
    putPristine('pristine-body');
    await reconcile();
    storeWrite('edited', 'references/findings/index.md', 'F-001 … F-060');
    storeWrite('edited', 'f.txt', 'my edit');
    storeWrite('pristine-body', 'references/findings/index.md', 'F-100 … F-140');

    const result = await restoreAllBuiltins();

    expect(result.errors).toEqual([]);
    expect(result.reverted).toEqual(['edited']);
    expect(storeRead('edited', 'references/findings/index.md')).toBe('F-001 … F-060');
    expect(storeRead('edited', 'f.txt')).toBe('shipped');
    expect(storeRead('pristine-body', 'references/findings/index.md')).toBe('F-100 … F-140');
  });
});

// ---------------------------------------------------------------------------

/**
 * An unreadable shipped tree and a shipped tree that dropped every skill are
 * the SAME empty map, and reconcile draws a destructive conclusion from
 * absence. The root lives inside the app bundle, which can be on an ejected
 * volume, translocated, dragged to the Trash while running, or (in dev) taken
 * away by a branch switch — so this is a real runtime state, not a fixture.
 */
describe('an unreadable shipped tree is not "upstream dropped everything"', () => {
  it('does not delete an unmodified built-in', async () => {
    putPristine('acabox');
    await reconcile();
    fs.rmSync(pristineRoot, { recursive: true, force: true });

    const result = await upgrade();

    expect(result.pristineUnavailable).toBe(true);
    expect(result.removedUpstream).toEqual([]);
    expect(storeExists('acabox', 'SKILL.md')).toBe(true);
  });

  /** The worse half: retagging is PERMANENT. `origin: custom` with no baseline
   *  never becomes a built-in again, so Revert is gone even once the tree is
   *  back — which for a transient unmount would be an absurd price. */
  it('does not permanently retag an edited built-in as custom', async () => {
    putPristine('acabox');
    await reconcile();
    storeWrite('acabox', 'SKILL.md', 'MY WORK');
    fs.rmSync(pristineRoot, { recursive: true, force: true });

    const result = await upgrade();

    expect(result.keptAsCustom).toEqual([]);
    const entry = await entryFor('acabox');
    expect(entry!.origin).toBe('builtin');
    expect(entry!.baseline).toBeDefined();
    expect(storeRead('acabox', 'SKILL.md')).toBe('MY WORK');
  });

  it('does not classify existing store directories as custom when state is lost', async () => {
    putPristine('acabox');
    await reconcile();
    fs.rmSync(stateFile);
    fs.rmSync(pristineRoot, { recursive: true, force: true });

    await reconcile();

    // Not recovered at all, rather than recovered under the wrong origin: the
    // next boot with a readable tree classifies it correctly.
    expect(await entryFor('acabox')).toBeUndefined();
    expect(storeExists('acabox', 'SKILL.md')).toBe(true);
  });

  it('recovers completely once the tree is readable again', async () => {
    putPristine('acabox');
    await reconcile();
    storeWrite('acabox', 'SKILL.md', 'MY WORK');
    const saved = fs.readFileSync(path.join(pristineRoot, 'acabox', 'SKILL.md'), 'utf-8');
    fs.rmSync(pristineRoot, { recursive: true, force: true });
    await upgrade();

    putPristine('acabox', { 'SKILL.md': saved });
    const result = await reconcile();

    expect(result.pristineUnavailable).toBe(false);
    expect((await descriptorFor('acabox'))!.modified).toBe(true);
    expect((await revertSkill('acabox')).ok).toBe(true);
    expect(storeRead('acabox', 'SKILL.md')).toBe(saved);
  });
});

// ---------------------------------------------------------------------------

describe('adoption — the inversion of the destructive prune', () => {
  const workspaceDir = path.join(tmpRoot, 'workspace');
  const renderDir = path.join(workspaceDir, '.claude', 'skills');

  const putWorkspaceDir = (name: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(renderDir, name, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  };

  beforeEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.mkdirSync(renderDir, { recursive: true });
  });

  it('adopts a directory the agent created instead of deleting it', async () => {
    putPristine('acabox');
    putWorkspaceDir('agent-made-this', { 'SKILL.md': skillMd('agent-made-this', 'invented') });

    const result = await reconcile({ workspaceDir });

    expect(result.adopted).toEqual([{ id: 'agent-made-this', fromName: 'agent-made-this' }]);
    expect(storeRead('agent-made-this', 'SKILL.md')).toContain('invented');
    expect((await entryFor('agent-made-this'))!.origin).toBe('custom');
    expect(fs.existsSync(path.join(renderDir, 'agent-made-this'))).toBe(false);
  });

  it('deletes a byte-identical pre-migration copy and re-seeds from pristine', async () => {
    putPristine('acabox');
    putWorkspaceDir('acabox', { 'SKILL.md': skillMd('acabox') });

    const result = await reconcile({ workspaceDir });

    expect(result.migrated).toEqual(['acabox']);
    expect(result.adopted).toEqual([]);
    expect(result.seeded).toEqual(['acabox']);
    expect((await descriptorFor('acabox'))!.modified).toBe(false);
  });

  /** The migration case that matters: someone edited a shipped skill under the
   *  old force-copy regime. Their bytes become the store copy, MODIFIED and
   *  revertible — not a `-recovered-1` orphan with no baseline. */
  it('adopts an EDITED pre-migration copy as the built-in itself', async () => {
    putPristine('acabox');
    putWorkspaceDir('acabox', { 'SKILL.md': skillMd('acabox', 'I EDITED THIS') });

    const result = await reconcile({ workspaceDir });

    expect(result.adopted).toEqual([{ id: 'acabox', fromName: 'acabox' }]);
    expect(storeRead('acabox', 'SKILL.md')).toContain('I EDITED THIS');
    const descriptor = await descriptorFor('acabox');
    expect(descriptor!.origin).toBe('builtin');
    expect(descriptor!.modified).toBe(true);

    expect((await revertSkill('acabox')).ok).toBe(true);
    expect(storeRead('acabox', 'SKILL.md')).not.toContain('I EDITED THIS');
  });

  it('suffixes -recovered-N when the store id is already taken', async () => {
    putPristine('acabox');
    await reconcile();
    putWorkspaceDir('acabox', { 'SKILL.md': 'something else entirely' });

    const result = await reconcile({ workspaceDir });
    expect(result.adopted).toEqual([{ id: 'acabox-recovered-1', fromName: 'acabox' }]);
    expect(storeRead('acabox-recovered-1', 'SKILL.md')).toBe('something else entirely');
    expect((await entryFor('acabox-recovered-1'))!.origin).toBe('custom');
  });

  it('never touches a symlink in the render target', async () => {
    putPristine('acabox');
    await reconcile();
    fs.symlinkSync(storePath('acabox'), path.join(renderDir, 'acabox'), 'dir');

    const result = await reconcile({ workspaceDir });
    expect(result.adopted).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(fs.lstatSync(path.join(renderDir, 'acabox')).isSymbolicLink()).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the state file is a rebuildable cache', () => {
  it('recovers a fork rather than re-seeding over it when the file is deleted', async () => {
    putPristine('acabox', { 'scripts/run.py': 'shipped' });
    await reconcile();
    storeWrite('acabox', 'scripts/run.py', 'MY WORK');

    fs.rmSync(stateFile);
    const result = await reconcile();

    expect(result.recovered).toEqual(['acabox']);
    expect(result.seeded).toEqual([]);
    expect(storeRead('acabox', 'scripts/run.py')).toBe('MY WORK');
    expect((await descriptorFor('acabox'))!.modified).toBe(true);
  });

  it('recovers from a corrupt state file the same way', async () => {
    putPristine('acabox');
    await reconcile();
    storeWrite('acabox', 'SKILL.md', 'MY WORK');
    fs.writeFileSync(stateFile, '{ this is not json');

    await reconcile();
    expect(storeRead('acabox', 'SKILL.md')).toBe('MY WORK');
    expect((await descriptorFor('acabox'))!.modified).toBe(true);
  });

  it('re-registers a custom skill with no pristine counterpart', async () => {
    // A shipped skill has to exist for recovery to run at all: an empty
    // pristine tree is indistinguishable from an unreadable one, and reconcile
    // deliberately does nothing in that case rather than classify every store
    // directory as `custom` on the strength of a tree it could not read.
    putPristine('acabox');
    await createSkill('my-lab-protocol');
    fs.rmSync(stateFile);

    await reconcile();
    const entry = await entryFor('my-lab-protocol');
    expect(entry!.origin).toBe('custom');
    expect(entry!.baseline).toBeUndefined();
  });

  /** Bytes survive; pure intent does not. Stated as a test so the cost is
   *  known rather than discovered. */
  it('cannot recover `enabled: false`, which has no evidence on disk', async () => {
    putPristine('acabox');
    await reconcile();
    await setSkillEnabled('acabox', false);

    fs.rmSync(stateFile);
    await reconcile();
    expect((await entryFor('acabox'))!.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('revert', () => {
  beforeEach(async () => {
    putPristine('xlsx', { 'SKILL.md': skillMd('xlsx'), 'scripts/recalc.py': 'shipped\n' });
    await reconcile();
  });

  it('moves the fork to trash rather than deleting it', async () => {
    storeWrite('xlsx', 'scripts/recalc.py', 'my careful edit\n');
    const result = await revertFile('xlsx', 'scripts/recalc.py');

    expect(result.ok).toBe(true);
    expect(storeRead('xlsx', 'scripts/recalc.py')).toBe('shipped\n');
    expect(fs.readFileSync(path.join(result.trashPath!, 'scripts/recalc.py'), 'utf-8')).toBe(
      'my careful edit\n',
    );
  });

  it('puts the trash beside the store, never inside it', async () => {
    storeWrite('xlsx', 'SKILL.md', 'edited');
    const result = await revertFile('xlsx', 'SKILL.md');
    expect(result.trashPath!.startsWith(trashRoot + path.sep)).toBe(true);
    expect(result.trashPath!.startsWith(storeRoot + path.sep)).toBe(false);
  });

  it('clears the MODIFIED state and the pending update together', async () => {
    storeWrite('xlsx', 'SKILL.md', 'mine');
    putPristine('xlsx', { 'SKILL.md': skillMd('xlsx', 'v2') });
    await upgrade();
    expect((await entryFor('xlsx'))!.updateAvailable!['SKILL.md']).toBeDefined();

    await revertFile('xlsx', 'SKILL.md');
    expect((await entryFor('xlsx'))!.updateAvailable).toBeUndefined();
    expect((await descriptorFor('xlsx'))!.modified).toBe(false);
  });

  it('refuses when there is nothing to revert to, with a real message', async () => {
    storeWrite('xlsx', 'mine-only.md', 'not shipped');
    const result = await revertFile('xlsx', 'mine-only.md');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not part of the shipped xlsx skill/);
    expect(storeRead('xlsx', 'mine-only.md')).toBe('not shipped');
  });

  it('refuses on a custom skill', async () => {
    await createSkill('mine');
    const result = await revertFile('mine', 'SKILL.md');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a built-in/);
  });

  it('refuses a path that escapes the skill directory', async () => {
    const result = await revertFile('xlsx', '../../escape.txt');
    expect(result.ok).toBe(false);
  });

  it('revertSkill restores every file and trashes what the user added', async () => {
    storeWrite('xlsx', 'SKILL.md', 'mine');
    fs.rmSync(storePath('xlsx', 'scripts/recalc.py'));
    storeWrite('xlsx', 'extra.md', 'added by me');

    const result = await revertSkill('xlsx');
    expect(result.ok).toBe(true);
    expect(storeRead('xlsx', 'SKILL.md')).toBe(skillMd('xlsx'));
    expect(storeRead('xlsx', 'scripts/recalc.py')).toBe('shipped\n');
    expect(storeExists('xlsx', 'extra.md')).toBe(false);
    expect(fs.readFileSync(path.join(result.trashPath!, 'xlsx', 'extra.md'), 'utf-8')).toBe(
      'added by me',
    );
    expect((await descriptorFor('xlsx'))!.modified).toBe(false);
  });

  it('two reverts in the same second do not collide in the trash', async () => {
    storeWrite('xlsx', 'SKILL.md', 'a');
    const first = await revertFile('xlsx', 'SKILL.md');
    storeWrite('xlsx', 'SKILL.md', 'b');
    const second = await revertFile('xlsx', 'SKILL.md');
    expect(first.trashPath).not.toBe(second.trashPath);
    expect(fs.readFileSync(path.join(first.trashPath!, 'SKILL.md'), 'utf-8')).toBe('a');
    expect(fs.readFileSync(path.join(second.trashPath!, 'SKILL.md'), 'utf-8')).toBe('b');
  });
});

// ---------------------------------------------------------------------------

describe('restoreAllBuiltins', () => {
  beforeEach(async () => {
    putPristine('a', { 'f.txt': 'shipped-a' });
    putPristine('b', { 'f.txt': 'shipped-b' });
    await reconcile();
  });

  /** The guarantee comes from the data model — the loop iterates entries
   *  filtered by origin — not from care inside it. */
  it('is structurally incapable of touching a custom skill', async () => {
    await createSkill('my-lab-protocol');
    await writeSkillFile('my-lab-protocol', 'SKILL.md', 'PRECIOUS');
    storeWrite('a', 'f.txt', 'edited');

    const result = await restoreAllBuiltins();

    expect(result.reverted).toEqual(['a']);
    expect(storeRead('my-lab-protocol', 'SKILL.md')).toBe('PRECIOUS');
    expect((await entryFor('my-lab-protocol'))!.origin).toBe('custom');
  });

  it('brings back a removed built-in and re-enables a disabled one', async () => {
    await deleteSkill('a');
    await setSkillEnabled('b', false);

    const result = await restoreAllBuiltins();

    expect(result.restored).toEqual(['a']);
    expect(storeRead('a', 'f.txt')).toBe('shipped-a');
    expect((await entryFor('a'))!.removed).toBeFalsy();
    expect((await entryFor('b'))!.enabled).toBe(true);
  });

  it('leaves an unmodified built-in alone rather than re-copying it', async () => {
    const result = await restoreAllBuiltins();
    expect(result.reverted).toEqual([]);
    expect(result.restored).toEqual([]);
  });

  /** The confirm dialog quotes these numbers, so they are measured before the
   *  call rather than described afterwards. */
  it('summarizes with real counts for the confirm dialog', async () => {
    storeWrite('a', 'f.txt', 'edited');
    await deleteSkill('b');
    await createSkill('mine');

    expect(await summarizeBuiltinRestore()).toEqual({
      modified: ['a'],
      removed: ['b'],
      unaffected: ['mine'],
    });
  });
});

// ---------------------------------------------------------------------------

describe('create, write, delete, enable', () => {
  it('creates a custom skill with parseable frontmatter', async () => {
    expect(await createSkill('my-lab-protocol', { description: 'How we run qPCR here.' }))
      .toEqual({ ok: true, id: 'my-lab-protocol' });

    const descriptor = await descriptorFor('my-lab-protocol');
    expect(descriptor!.frontmatterOk).toBe(true);
    expect(descriptor!.description).toBe('How we run qPCR here.');
    expect(descriptor!.origin).toBe('custom');
  });

  it('refuses a reserved, malformed or duplicate id', async () => {
    expect((await createSkill('update-config')).error).toMatch(/Claude Agent SDK ships/);
    expect((await createSkill('My Skill')).error).toMatch(/Invalid name/);
    await createSkill('taken');
    expect((await createSkill('taken')).error).toMatch(/already exists/);
  });

  it('creates the skill on a write to a name that does not exist yet', async () => {
    expect((await writeSkillFile('brand-new', 'SKILL.md', skillMd('brand-new'))).ok).toBe(true);
    expect((await entryFor('brand-new'))!.origin).toBe('custom');
    expect(await readSkillFile('brand-new', 'SKILL.md')).toBe(skillMd('brand-new'));
  });

  it('refuses a write that escapes the skill directory', async () => {
    await createSkill('mine');
    for (const rel of ['../escape.txt', '/etc/passwd', 'a/../../escape.txt']) {
      expect((await writeSkillFile('mine', rel, 'x')).ok).toBe(false);
    }
    expect(fs.existsSync(path.join(storeRoot, 'escape.txt'))).toBe(false);
  });

  it('deletes a custom skill outright but only removes a built-in', async () => {
    putPristine('shipped');
    await reconcile();
    await createSkill('mine');

    const custom = await deleteSkill('mine');
    expect(custom.ok).toBe(true);
    expect(await entryFor('mine')).toBeUndefined();

    const builtin = await deleteSkill('shipped');
    expect(builtin.ok).toBe(true);
    expect((await entryFor('shipped'))!.removed).toBe(true);
    expect(storeExists('shipped')).toBe(false);
  });

  it('keeps a deleted skill recoverable from the trash', async () => {
    await createSkill('mine');
    await writeSkillFile('mine', 'SKILL.md', 'IRREPLACEABLE');
    const result = await deleteSkill('mine');
    expect(fs.readFileSync(path.join(result.trashPath!, 'mine', 'SKILL.md'), 'utf-8')).toBe(
      'IRREPLACEABLE',
    );
  });

  it('refuses to enable a skill that was removed', async () => {
    putPristine('shipped');
    await reconcile();
    await deleteSkill('shipped');
    expect((await setSkillEnabled('shipped', true)).error).toMatch(/Restore it/);
  });

  /** The disable/roster coupling: `buildSkillRuntimeConfig` is the ONLY thing
   *  that acts on `enabled`. The render deliberately still links it. */
  it('drops a disabled skill from the runtime allowlist and nothing else', async () => {
    putPristine('a');
    putPristine('b');
    await reconcile();
    await setSkillEnabled('b', false);

    expect(buildSkillRuntimeConfig(await readSkillsState())).toEqual(['a', 'claude-api']);
    expect(storeExists('b', 'SKILL.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('descriptors', () => {
  it('reports real byte counts, file counts and exec counts', async () => {
    putPristine('s', { 'scripts/run.py': 'print(1)\n', 'scripts/lib.py': 'x' });
    fs.chmodSync(path.join(pristineRoot, 's', 'scripts', 'run.py'), 0o755);
    await reconcile();

    const descriptor = await descriptorFor('s');
    expect(descriptor!.fileCount).toBe(3);
    expect(descriptor!.execCount).toBe(1);
    expect(descriptor!.skillMdBytes).toBe(Buffer.byteLength(skillMd('s')));
    expect(descriptor!.changedAt).toBeGreaterThan(0);
  });

  /** The CLI would load this skill with a description synthesized from the
   *  first heading. The row exists precisely to break that silence. */
  it('renders a broken-frontmatter skill by directory name with the reason', async () => {
    putPristine('broken', { 'SKILL.md': '# No frontmatter here\n\nBody.\n' });
    await reconcile();

    const descriptor = await descriptorFor('broken');
    expect(descriptor!.id).toBe('broken');
    expect(descriptor!.frontmatterOk).toBe(false);
    expect(descriptor!.frontmatterError).toMatch(/frontmatter/i);
    expect(descriptor!.description).toBeUndefined();
  });

  it('surfaces a frontmatter name that disagrees with the directory, and only then', async () => {
    putPristine('box', { 'SKILL.md': '---\nname: box-content-api\ndescription: d\n---\n' });
    putPristine('agrees', { 'SKILL.md': '---\nname: agrees\ndescription: d\n---\n' });
    await reconcile();

    expect((await descriptorFor('box'))!.declaredName).toBe('box-content-api');
    expect((await descriptorFor('agrees'))!.declaredName).toBeUndefined();
  });

  it('gives the editor a hash for the save-time version check', async () => {
    putPristine('s');
    await reconcile();
    const before = skillFileHash('s', 'SKILL.md');
    storeWrite('s', 'SKILL.md', 'changed underneath the editor');
    expect(skillFileHash('s', 'SKILL.md')).not.toBe(before);
    expect(skillFileHash('s', '../escape')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('trash housekeeping', () => {
  it('prunes only entries past the age limit', async () => {
    putPristine('s');
    await reconcile();
    storeWrite('s', 'SKILL.md', 'edited');
    const old = await revertFile('s', 'SKILL.md');
    storeWrite('s', 'SKILL.md', 'edited again');
    const fresh = await revertFile('s', 'SKILL.md');

    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old.trashPath!, longAgo, longAgo);

    expect(pruneSkillsTrash()).toBe(1);
    expect(fs.existsSync(old.trashPath!)).toBe(false);
    expect(fs.existsSync(fresh.trashPath!)).toBe(true);
  });

  it('does not throw when there is no trash directory', () => {
    expect(pruneSkillsTrash()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

/**
 * Reading a file out of a skill takes TWO untrusted strings, and the id is the
 * dangerous one.
 *
 * `resolveWithin` guards `relPath` against escaping its base — but the base is
 * `join(storeDir, id)`, so an unvalidated id moves the base and every relPath
 * under the new location then passes. `id = '..'` puts it on userData, which
 * holds `agent.json` (the RAW Anthropic key, decrypted, because it is the SDK's
 * own input), `cobuilding-settings.json` and the databases. That is reachable
 * straight from the renderer over `skills:read`, and it defeats the point of
 * `secretStore` — the invariant this codebase states is that secrets never
 * cross IPC.
 */
describe('a skill id cannot walk out of the store', () => {
  const escapes = ['..', '../..', '../../..'];

  it.each(escapes)('readSkillFile refuses id %p', async (id) => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'agent.json'), '{"anthropicApiKey":"sk-ant-LEAKED"}');

    await expect(readSkillFile(id, 'agent.json')).rejects.toThrow(/Invalid name|A name is required/);
  });

  it.each(escapes)('skillFileHash refuses id %p', (id) => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'agent.json'), '{"anthropicApiKey":"sk-ant-LEAKED"}');

    // Undefined rather than a hash: existence and content of a file outside the
    // store is still an answer we must not give.
    expect(skillFileHash(id, 'agent.json')).toBeUndefined();
  });

  it('still reads an ordinary file out of an ordinary skill', async () => {
    // The guard must not be so eager it breaks the feature it protects.
    await createSkill('reader-check', { description: 'Readable.' });
    await writeSkillFile('reader-check', 'notes/inner.md', 'body\n');

    expect(await readSkillFile('reader-check', 'notes/inner.md')).toBe('body\n');
    expect(skillFileHash('reader-check', 'notes/inner.md')).toBeDefined();
    // And the relPath half of the guard is still doing its job.
    await expect(readSkillFile('reader-check', '../../agent.json')).rejects.toThrow(/Invalid path/);
  });
});
