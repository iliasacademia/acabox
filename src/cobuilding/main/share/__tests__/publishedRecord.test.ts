/**
 * @jest-environment node
 *
 * `main/share/publishedRecord.ts` against a real temp workspace + real fs —
 * writes go through `manifestIO.ts`'s atomic temp-file+rename `updateManifest`,
 * so this exercises actual disk I/O rather than a mocked fs. No Electron
 * import anywhere in the chain, so nothing here needs `jest.mock('electron')`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PublishedInfo } from '../../../shared/share';
import {
  clearPublished,
  isPublishedInfo,
  manifestPathFor,
  readPublished,
  writePublished,
} from '../publishedRecord';

describe('publishedRecord', () => {
  let workspaceRoot: string;
  const dirName = 'my-tool';

  const sampleInfo: PublishedInfo = {
    id: 'abc123def456gh',
    kind: 'app',
    url: 'https://acabox-share.example.workers.dev/a/abc123def456gh',
    hash: 'a'.repeat(64),
    publishedAt: '2026-09-15T00:00:00.000Z',
  };

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-published-record-test-'));
    fs.mkdirSync(path.join(workspaceRoot, '.applications', dirName), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('round-trips a write through a read', async () => {
    await writePublished(workspaceRoot, dirName, sampleInfo);
    const read = await readPublished(workspaceRoot, dirName);
    expect(read).toEqual(sampleInfo);
  });

  it('clears back to null', async () => {
    await writePublished(workspaceRoot, dirName, sampleInfo);
    await clearPublished(workspaceRoot, dirName);
    const read = await readPublished(workspaceRoot, dirName);
    expect(read).toBeNull();
  });

  it('reads a manifest with `published: "garbage"` as null rather than throwing', async () => {
    const manifestPath = manifestPathFor(workspaceRoot, dirName);
    fs.writeFileSync(manifestPath, JSON.stringify({ name: 'My Tool', published: 'garbage' }));

    const read = await readPublished(workspaceRoot, dirName);

    expect(read).toBeNull();
    expect(isPublishedInfo('garbage')).toBe(false);
  });

  it('leaves other manifest keys untouched by a write, and clear removes only `published`', async () => {
    const manifestPath = manifestPathFor(workspaceRoot, dirName);
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'My Tool', description: 'A tool', archived: false }),
    );

    await writePublished(workspaceRoot, dirName, sampleInfo);
    const afterWrite = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(afterWrite).toEqual({
      name: 'My Tool',
      description: 'A tool',
      archived: false,
      published: sampleInfo,
    });

    await clearPublished(workspaceRoot, dirName);
    const afterClear = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(afterClear).toEqual({ name: 'My Tool', description: 'A tool', archived: false });
  });
});
