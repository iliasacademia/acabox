/**
 * `provisionWorkspace` against a REAL temp tree — a real pristine
 * `src/cobuilding`, a real store, a real workspace.
 *
 * The property under test is the one this module used to violate on every
 * boot: **an edit we did not make is never silently destroyed.** The workspace
 * `CLAUDE.md`, `settings.json` and the hook scripts were force-copied over
 * whatever was there, exactly like the skills were, and nobody had noticed only
 * because nobody edits them yet.
 *
 * The one deliberate exception — `settings.json` and the hooks are restored
 * rather than kept, because they are the PreToolUse gate and the agent has
 * `Write` inside the workspace — is pinned here too, together with the backup
 * that makes it a restore rather than a deletion.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-provision-'));
const userData = path.join(tmpRoot, 'userData');
const appRoot = path.join(tmpRoot, 'app');
const sourceRoot = path.join(appRoot, 'src', 'cobuilding');
const pristineRoot = path.join(sourceRoot, 'skills');
const workspace = path.join(tmpRoot, 'workspace');

jest.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getAppPath: () => appRoot,
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The only thing `WorkspaceController.create` needs that is not a filesystem:
// its four DB writes. Everything else in the test below — the reconciler, the
// renderer, the provisioned-file pass, the `_bridge` assertion — is real.
const fakeWorkspace = { id: 'ws-1', name: 'Workspace' };
jest.mock('../db/workspaceRepository', () => ({
  createWorkspace: jest.fn(),
  getActiveWorkspace: jest.fn(() => fakeWorkspace),
  touchWorkspace: jest.fn(),
  addWorkspaceDirectory: jest.fn(),
  removeWorkspaceDirectory: jest.fn(),
  listWorkspaceDirectories: jest.fn(() => []),
  listWorkspaceDirectoriesBySource: jest.fn(() => []),
  updateWorkspaceDirectoryPermission: jest.fn(),
}));

import { provisionWorkspace, syncMiniAppAssets } from '../skills';
import { skillStorePath } from '../skillStore';
import { WorkspaceController } from '../controllers/WorkspaceController';

const write = (abs: string, body: string): void => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

const read = (abs: string): string => fs.readFileSync(abs, 'utf8');

/** A minimal but structurally real shipped tree. */
function seedPristine(claudeMd = '# workspace rules v1\n'): void {
  fs.rmSync(sourceRoot, { recursive: true, force: true });
  write(path.join(sourceRoot, 'CLAUDE.md'), claudeMd);
  write(path.join(sourceRoot, 'settings.json'), '{"hooks":{"PreToolUse":[]}}\n');
  write(path.join(sourceRoot, 'hooks', 'block-secret-reads.sh'), '#!/bin/bash\nexit 0\n');
  write(path.join(sourceRoot, 'hooks', 'block-host-installs.sh'), '#!/bin/bash\nexit 0\n');

  // The mini-app assets skill. `syncMiniAppAssets` reads these out of the
  // STORE, so they have to travel through the reconciler to get there.
  const mini = path.join(pristineRoot, 'manage-mini-application');
  write(path.join(mini, 'SKILL.md'), '---\nname: manage-mini-application\ndescription: Build mini-apps.\n---\n\nBody.\n');
  write(path.join(mini, 'assets', 'bridge', 'bridge.ts'), 'export const bridge = 1;\n');
  write(path.join(mini, 'assets', 'reusable', 'useAppState.ts'), 'export const useAppState = () => 1;\n');
  write(path.join(mini, 'assets', 'install'), '#!/bin/bash\necho install\n');

  write(path.join(pristineRoot, 'acabox', 'SKILL.md'), '---\nname: acabox\ndescription: About Acabox.\n---\n\nBody.\n');
}

function resetAll(claudeMd?: string): void {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  seedPristine(claudeMd);
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('provisionWorkspace', () => {
  beforeEach(() => resetAll());

  it('seeds the workspace files, the store and the render on a fresh install', async () => {
    const result = await provisionWorkspace(workspace);

    expect(result.errors).toEqual([]);
    expect(read(path.join(workspace, '.claude', 'CLAUDE.md'))).toBe('# workspace rules v1\n');
    expect(fs.existsSync(path.join(workspace, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.claude', 'hooks', 'block-secret-reads.sh'))).toBe(true);
    // Hooks must stay executable — a hook that lost +x fails the turn.
    expect(fs.statSync(path.join(workspace, '.claude', 'hooks', 'block-secret-reads.sh')).mode & 0o111).not.toBe(0);

    expect(result.reconcile?.seeded.sort()).toEqual(['acabox', 'manage-mini-application']);
    // Skills reach the workspace as symlinks, not copies.
    const link = path.join(workspace, '.claude', 'skills', 'acabox');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(skillStorePath('acabox'));
  });

  it('is a no-op on the second boot', async () => {
    await provisionWorkspace(workspace);
    const second = await provisionWorkspace(workspace);
    expect(second.errors).toEqual([]);
    expect(second.reconcile?.seeded).toEqual([]);
    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);
  });

  it('keeps a local CLAUDE.md edit instead of overwriting it', async () => {
    await provisionWorkspace(workspace);
    const dest = path.join(workspace, '.claude', 'CLAUDE.md');
    fs.writeFileSync(dest, '# workspace rules v1\n\nMy own note.\n');

    const again = await provisionWorkspace(workspace);
    expect(read(dest)).toContain('My own note.');
    expect(again.files.find((f) => f.dest.endsWith('CLAUDE.md'))?.action).toBe('kept-local');
  });

  it('fast-forwards CLAUDE.md when the user has NOT edited it', async () => {
    await provisionWorkspace(workspace);
    // A new release changes the shipped copy.
    write(path.join(sourceRoot, 'CLAUDE.md'), '# workspace rules v2\n');

    const again = await provisionWorkspace(workspace);
    expect(read(path.join(workspace, '.claude', 'CLAUDE.md'))).toBe('# workspace rules v2\n');
    expect(again.files.find((f) => f.dest.endsWith('CLAUDE.md'))?.action).toBe('fast-forward');
  });

  it('restores a tampered hook but keeps a copy of what it replaced', async () => {
    await provisionWorkspace(workspace);
    const hook = path.join(workspace, '.claude', 'hooks', 'block-secret-reads.sh');
    // What an agent with Write in the workspace would do to the gate.
    fs.writeFileSync(hook, '#!/bin/bash\n# neutered\nexit 0\n');

    const again = await provisionWorkspace(workspace);
    expect(read(hook)).toBe('#!/bin/bash\nexit 0\n');

    const outcome = again.files.find((f) => f.dest.endsWith('block-secret-reads.sh'));
    expect(outcome?.action).toBe('restored');
    // Restored, not deleted: the divergent bytes survive somewhere findable.
    expect(outcome?.backupPath).toBeTruthy();
    expect(read(outcome!.backupPath!)).toContain('# neutered');
  });

  it('reinstates the exec bit on a hook that lost it, without rewriting the file', async () => {
    await provisionWorkspace(workspace);
    const hook = path.join(workspace, '.claude', 'hooks', 'block-host-installs.sh');
    fs.chmodSync(hook, 0o644);

    const again = await provisionWorkspace(workspace);
    expect(fs.statSync(hook).mode & 0o111).not.toBe(0);
    // The bytes never changed, so this is not a restore.
    expect(again.files.find((f) => f.dest.endsWith('block-host-installs.sh'))?.action).toBe('unchanged');
  });

  it('adopts a destination that already holds the shipped bytes', async () => {
    // The pre-store world: the file is there because the old force-copy put it
    // there, and there is no baseline recorded. It must not read as an edit.
    write(path.join(workspace, '.claude', 'CLAUDE.md'), '# workspace rules v1\n');
    const first = await provisionWorkspace(workspace);
    expect(first.files.find((f) => f.dest.endsWith('CLAUDE.md'))?.action).toBe('unchanged');

    write(path.join(sourceRoot, 'CLAUDE.md'), '# workspace rules v2\n');
    const second = await provisionWorkspace(workspace);
    expect(second.files.find((f) => f.dest.endsWith('CLAUDE.md'))?.action).toBe('fast-forward');
  });

  it('drops a hook the shipped tree no longer names, and provisions a new one', async () => {
    await provisionWorkspace(workspace);
    fs.rmSync(path.join(sourceRoot, 'hooks', 'block-host-installs.sh'));
    write(path.join(sourceRoot, 'hooks', 'new-guard.sh'), '#!/bin/bash\nexit 0\n');

    const again = await provisionWorkspace(workspace);
    expect(fs.existsSync(path.join(workspace, '.claude', 'hooks', 'new-guard.sh'))).toBe(true);
    // Nothing removes the stale copy — deleting a file in the agent's cwd on
    // the strength of it having vanished upstream is exactly the behaviour
    // this module is being cured of. Recorded so the choice is deliberate.
    expect(fs.existsSync(path.join(workspace, '.claude', 'hooks', 'block-host-installs.sh'))).toBe(true);
    expect(again.errors).toEqual([]);
  });

  it('keeps going when one step fails', async () => {
    // A pristine tree with no CLAUDE.md: the file step has nothing to copy,
    // and the rest must still land. Before this, one throw out of the
    // hardcoded SKILLS array took out provisionWorkspace two lines above
    // createMainWindow() and produced an app with no window.
    fs.rmSync(path.join(sourceRoot, 'CLAUDE.md'));
    const result = await provisionWorkspace(workspace);
    expect(fs.existsSync(path.join(workspace, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.applications', '_bridge'))).toBe(true);
    expect(result.reconcile?.seeded.length).toBe(2);
  });

  it('throws when provisioning did not produce .applications/_bridge', async () => {
    // The boot assertion. `_bridge` now comes out of the STORE, so a
    // mis-ordering (render before reconcile, or a store the reconciler failed
    // to seed) would silently break every mini-app build on a fresh install.
    fs.rmSync(path.join(pristineRoot, 'manage-mini-application'), { recursive: true });
    await expect(provisionWorkspace(workspace)).rejects.toThrow(/_bridge/);
  });

  it('serialises overlapping calls', async () => {
    const [a, b, c] = await Promise.all([
      provisionWorkspace(workspace),
      provisionWorkspace(workspace),
      provisionWorkspace(workspace),
    ]);
    // Exactly one run does the seeding; the other two find a settled store.
    const seeds = [a, b, c].map((r) => r.reconcile?.seeded.length ?? 0);
    expect(seeds.filter((n) => n > 0)).toHaveLength(1);
    for (const r of [a, b, c]) expect(r.errors).toEqual([]);
  });
});

describe('syncMiniAppAssets', () => {
  beforeEach(() => resetAll());

  it('reads from the STORE, so a store edit reaches .applications', async () => {
    await provisionWorkspace(workspace);
    // What the skills UI's Edit does: write into the store. It shows MODIFIED
    // and a Revert button against these bytes, so if provisioning read from
    // pristine the UI would assert an edit took effect while the next boot
    // silently overwrote the copy every mini-app actually builds against.
    fs.writeFileSync(
      path.join(skillStorePath('manage-mini-application'), 'assets', 'reusable', 'useAppState.ts'),
      'export const useAppState = () => 42;\n',
    );

    await provisionWorkspace(workspace);
    expect(read(path.join(workspace, '.applications', '_reusable', 'useAppState.ts'))).toContain('42');
  });

  it('refuses to run before the store is seeded rather than silently copying nothing', () => {
    expect(() => syncMiniAppAssets(workspace)).toThrow(/reconcile\(\) must run before/);
  });
});

// ---------------------------------------------------------------------------

/**
 * The FRESH-INSTALL boot path.
 *
 * `main/index.ts` creates a blank workspace when there is no active one, and
 * that call is two above `createMainWindow()`. `WorkspaceController.create`
 * provisions, and provisioning ends in a deliberate throw when the mini-app
 * assets are missing — so on first launch, where the store has never been
 * seeded and is therefore the most likely place to fail, an uncaught throw
 * here is an app with no window at all. That is the exact failure the old
 * hardcoded `SKILLS` array produced, and the boot site's own
 * `provisionWorkspace` call is wrapped for precisely this reason.
 */
describe('WorkspaceController.create survives a provisioning failure', () => {
  beforeEach(() => resetAll());

  it('returns the workspace even when provisioning throws', async () => {
    // Remove the skill the mini-app assets live in. `_bridge` then cannot be
    // produced from the store and the real boot assertion fires.
    fs.rmSync(path.join(pristineRoot, 'manage-mini-application'), { recursive: true, force: true });

    const controller = new WorkspaceController();
    const created = await controller.create([], 'test-key');

    expect(created).toEqual(fakeWorkspace);
    expect(controller.activeWorkspace).toEqual(fakeWorkspace);
    // Not just "did not throw": the controller has to be fully built, or every
    // later `workspacePath` read is wrong while the DB says a workspace exists.
    expect(controller.workspacePath).toContain(userData);
  });

  it('still provisions everything it can on the way through', async () => {
    fs.rmSync(path.join(pristineRoot, 'manage-mini-application'), { recursive: true, force: true });

    const controller = new WorkspaceController();
    await controller.create([], 'test-key');

    // The steps that CAN run did: one failure does not cost the user the rest.
    const dir = controller.workspacePath;
    expect(fs.existsSync(path.join(dir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'acabox'))).toBe(true);
  });

  it('provisions a fresh install completely when nothing is broken', async () => {
    const controller = new WorkspaceController();
    await controller.create([], 'test-key');

    const dir = controller.workspacePath;
    expect(fs.existsSync(path.join(dir, '.applications', '_bridge', 'bridge.ts'))).toBe(true);
    expect(fs.lstatSync(path.join(dir, '.claude', 'skills', 'acabox')).isSymbolicLink()).toBe(true);
  });
});
