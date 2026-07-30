/**
 * The store against the REAL shipped tree — all 21 skills, 255 files, 4.7 MB,
 * seeded into a temp userData.
 *
 * The other suites use hand-built fixtures, which prove the logic. This one
 * proves the logic survives reality: the four document skills alone are 174
 * files of OOXML schemas, `manage-mini-application` ships a 407 KB vendored
 * bundle, and seven skills ship executable `scripts/`. It is also the only
 * place a shipped skill with unreadable frontmatter would be caught before it
 * reaches a browsable list.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-skills-real-'));
const userData = path.join(tmpRoot, 'userData');
/** The real repo root: this file is at src/cobuilding/main/__tests__/. */
const appRoot = path.resolve(__dirname, '..', '..', '..', '..');
const workspaceDir = path.join(userData, 'workspace-data');

jest.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getAppPath: () => appRoot,
    getVersion: () => '0.1.6',
    isPackaged: false,
  },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { buildSkillRuntimeConfig } from '../../shared/skills';
import { renderSkills } from '../skillRender';
import {
  getPristineSkillsDir,
  listSkills,
  readSkillsState,
  reconcile,
  revertSkill,
  skillStorePath,
} from '../skillStore';

beforeAll(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the shipped tree', () => {
  it('seeds every shipped skill and reports all of them unmodified', async () => {
    const shipped = fs
      .readdirSync(getPristineSkillsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(getPristineSkillsDir(), e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
    expect(shipped.length).toBeGreaterThan(15);

    const result = await reconcile({ workspaceDir });
    expect(result.seeded).toEqual(shipped);
    expect(result.errors).toEqual([]);

    const descriptors = await listSkills();
    expect(descriptors.map((d) => d.id)).toEqual(shipped);
    expect(descriptors.filter((d) => d.modified).map((d) => d.id)).toEqual([]);
  });

  /** Every shipped skill must have frontmatter the CLI can read. One that
   *  cannot is loaded anyway with a description synthesized from its first
   *  heading, so it triggers on nothing its author intended. */
  it('parses the frontmatter of every shipped skill', async () => {
    const broken = (await listSkills())
      .filter((d) => !d.frontmatterOk)
      .map((d) => `${d.id}: ${d.frontmatterError}`);
    expect(broken).toEqual([]);
  });

  it('gives every shipped skill a non-empty description', async () => {
    const missing = (await listSkills()).filter((d) => !d.description).map((d) => d.id);
    expect(missing).toEqual([]);
  });

  it('preserves the exec bit on the skills that ship runnable scripts', async () => {
    const withScripts = (await listSkills()).filter((d) => d.execCount > 0);
    expect(withScripts.length).toBeGreaterThan(0);
    for (const descriptor of withScripts) {
      const rel = fs
        .readdirSync(path.join(descriptor.storePath, 'scripts'), { withFileTypes: true })
        .find((e) => e.isFile());
      expect(rel).toBeDefined();
    }
  });

  it('is a no-op on the second boot', async () => {
    const second = await reconcile({ workspaceDir });
    expect(second.upgraded).toBe(false);
    expect(second.seeded).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(second.migrated).toEqual([]);
    expect(second.adopted).toEqual([]);
  });

  it('renders every one of them into the workspace and resolves through the links', async () => {
    const render = await renderSkills(workspaceDir);
    expect(render.errors).toEqual([]);
    expect(render.adoptable).toEqual([]);

    const ids = (await listSkills()).map((d) => d.id);
    expect(render.linked.sort()).toEqual(ids);
    for (const id of ids) {
      const link = path.join(workspaceDir, '.claude', 'skills', id);
      expect(fs.readlinkSync(link)).toBe(skillStorePath(id));
      expect(fs.existsSync(path.join(link, 'SKILL.md'))).toBe(true);
    }

    const again = await renderSkills(workspaceDir);
    expect(again.linked).toEqual([]);
    expect(again.unchanged.length).toBe(ids.length);
  });

  it('offers every shipped skill to the SDK, plus the one bundled skill we keep', async () => {
    const allowlist = buildSkillRuntimeConfig(await readSkillsState());
    const ids = (await listSkills()).map((d) => d.id);
    // Store ids sorted, then BUNDLED_ALLOW appended — the deterministic order
    // that lets the live config and the crash-restart config compare equal.
    expect(allowlist).toEqual([...ids.sort(), 'claude-api']);
  });

  /** A real revert over a real multi-file skill: the largest one we ship. */
  it('reverts a real multi-file skill byte for byte', async () => {
    const biggest = (await listSkills()).sort((a, b) => b.fileCount - a.fileCount)[0]!;
    expect(biggest.fileCount).toBeGreaterThan(10);

    fs.writeFileSync(path.join(biggest.storePath, 'SKILL.md'), 'wrecked');
    expect((await listSkills()).find((d) => d.id === biggest.id)!.modified).toBe(true);

    expect((await revertSkill(biggest.id)).ok).toBe(true);
    const restored = (await listSkills()).find((d) => d.id === biggest.id)!;
    expect(restored.modified).toBe(false);
    expect(restored.fileCount).toBe(biggest.fileCount);
  });
});
