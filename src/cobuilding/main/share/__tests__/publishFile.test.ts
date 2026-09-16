/**
 * @jest-environment node
 *
 * `main/share/publishFile.ts` — publish / status / unpublish for a single
 * shared file (ticket M6, contracts C1, C2, C4 in
 * `docs/design/sharing-tickets.md`).
 *
 * Real temp-dir fixtures (`fs.mkdtempSync`) for the file under test, and a
 * `FakeShareApi` implementing the real `ShareApi` interface (rather than a
 * jest mock) so the calls recorded below are exactly the shape the real
 * `ShareApiClient` would see.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ArtifactMeta, PublishedInfo, ShareIndex, ShareKind } from '../../../shared/share';
import type { ShareApi } from '../shareApiClient';
import { computeFileStatus, hashFile, MAX_SHARED_FILE_BYTES, publishFile, unpublishFile } from '../publishFile';

type Call =
  | { op: 'health' }
  | { op: 'listArtifacts' }
  | { op: 'getArtifact'; kind: ShareKind; id: string }
  | { op: 'putFile'; kind: ShareKind; id: string; hash: string; relPath: string; contentType: string; bytes: Uint8Array }
  | { op: 'commit'; meta: ArtifactMeta }
  | { op: 'remove'; kind: ShareKind; id: string };

/** Records every call, in order, so tests can assert both count and sequence. */
class FakeShareApi implements ShareApi {
  calls: Call[] = [];

  async health(): Promise<void> {
    this.calls.push({ op: 'health' });
  }

  async listArtifacts(): Promise<ShareIndex> {
    this.calls.push({ op: 'listArtifacts' });
    return { updatedAt: new Date().toISOString(), artifacts: [] };
  }

  async getArtifact(kind: ShareKind, id: string): Promise<ArtifactMeta | null> {
    this.calls.push({ op: 'getArtifact', kind, id });
    return null;
  }

  async putFile(
    kind: ShareKind,
    id: string,
    hash: string,
    relPath: string,
    body: Uint8Array | ReadableStream,
    contentType: string,
  ): Promise<void> {
    if (!(body instanceof Uint8Array)) {
      throw new Error('publishFile must pass putFile a Uint8Array, never a stream (see the module header).');
    }
    // Copy the bytes now — the caller's buffer is not guaranteed to live on.
    this.calls.push({ op: 'putFile', kind, id, hash, relPath, contentType, bytes: new Uint8Array(body) });
  }

  async commit(meta: ArtifactMeta): Promise<void> {
    this.calls.push({ op: 'commit', meta });
  }

  async remove(kind: ShareKind, id: string): Promise<void> {
    this.calls.push({ op: 'remove', kind, id });
  }
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('publishFile', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publishFile-test-'));
    filePath = path.join(tmpDir, 'results.csv');
    fs.writeFileSync(filePath, 'a,b\n1,2\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('hashFile streams a sha256 hex digest and the real size', async () => {
    const { hash, size } = await hashFile(filePath);
    expect(hash).toBe(sha256Hex('a,b\n1,2\n'));
    expect(size).toBe(Buffer.byteLength('a,b\n1,2\n'));
  });

  test('publishing a new file does exactly one putFile then one commit, with the expected fields', async () => {
    const api = new FakeShareApi();
    const { hash } = await hashFile(filePath);

    const { published, unchanged } = await publishFile(api, {
      absPath: filePath,
      siteUrl: 'https://acabox-share.example.workers.dev',
      existing: null,
    });

    expect(unchanged).toBe(false);
    expect(api.calls.map((c) => c.op)).toEqual(['putFile', 'commit']);

    const put = api.calls[0];
    if (put.op !== 'putFile') throw new Error('expected putFile');
    expect(put.kind).toBe('file');
    expect(put.relPath).toBe('results.csv');
    expect(put.hash).toBe(hash);
    expect(put.contentType).toBe('text/csv; charset=utf-8');
    expect(Buffer.from(put.bytes).toString('utf8')).toBe('a,b\n1,2\n');

    const commit = api.calls[1];
    if (commit.op !== 'commit') throw new Error('expected commit');
    expect(commit.meta.kind).toBe('file');
    expect(commit.meta.entry).toBe('results.csv');
    expect(commit.meta.title).toBe('results.csv');
    expect(commit.meta.description).toBeNull();
    expect(commit.meta.hash).toBe(hash);
    expect(commit.meta.id).toBe(put.id);
    expect(commit.meta.files).toEqual([{ path: 'results.csv', size: Buffer.byteLength('a,b\n1,2\n'), sha256: hash }]);

    expect(published.kind).toBe('file');
    expect(published.hash).toBe(hash);
    expect(published.id).toBe(put.id);
    expect(published.url).toBe(`https://acabox-share.example.workers.dev/f/${put.id}/`);
  });

  test('an explicit title overrides the basename default', async () => {
    const api = new FakeShareApi();
    const { published } = await publishFile(api, {
      absPath: filePath,
      siteUrl: 'https://acabox-share.example.workers.dev',
      existing: null,
      title: 'Q3 results',
    });
    const commit = api.calls.find((c) => c.op === 'commit');
    if (!commit || commit.op !== 'commit') throw new Error('expected commit');
    expect(commit.meta.title).toBe('Q3 results');
    expect(published.hash).toBeDefined();
  });

  test('republishing an unchanged file makes zero API calls and returns the existing record', async () => {
    const api = new FakeShareApi();
    const { hash } = await hashFile(filePath);
    const existing: PublishedInfo = {
      id: 'existingid1234',
      kind: 'file',
      url: 'https://acabox-share.example.workers.dev/f/existingid1234/',
      hash,
      publishedAt: '2026-01-01T00:00:00.000Z',
    };

    const { published, unchanged } = await publishFile(api, {
      absPath: filePath,
      siteUrl: 'https://acabox-share.example.workers.dev',
      existing,
    });

    expect(unchanged).toBe(true);
    expect(published).toEqual(existing);
    expect(api.calls).toEqual([]);
  });

  test('computeFileStatus reports behind:true after the file changes, and republishing reuses the id', async () => {
    const api = new FakeShareApi();
    const { hash: originalHash } = await hashFile(filePath);
    const existing: PublishedInfo = {
      id: 'reuseid12345678',
      kind: 'file',
      url: 'https://acabox-share.example.workers.dev/f/reuseid12345678/',
      hash: originalHash,
      publishedAt: '2026-01-01T00:00:00.000Z',
    };

    const before = await computeFileStatus({ absPath: filePath, existing });
    expect(before.behind).toBe(false);
    expect(before.hash).toBe(originalHash);

    fs.writeFileSync(filePath, 'a,b\n1,2\n3,4\n');

    const after = await computeFileStatus({ absPath: filePath, existing });
    expect(after.behind).toBe(true);
    expect(after.hash).not.toBe(originalHash);

    const { published, unchanged } = await publishFile(api, {
      absPath: filePath,
      siteUrl: 'https://acabox-share.example.workers.dev',
      existing,
    });

    expect(unchanged).toBe(false);
    expect(published.id).toBe(existing.id); // same id reused, not re-minted
    expect(published.hash).toBe(after.hash);
    expect(api.calls.map((c) => c.op)).toEqual(['putFile', 'commit']);
    const put = api.calls[0];
    if (put.op !== 'putFile') throw new Error('expected putFile');
    expect(put.id).toBe(existing.id);
  });

  test('computeFileStatus never reports behind for a file that has never been published', async () => {
    const status = await computeFileStatus({ absPath: filePath, existing: null });
    expect(status.behind).toBe(false);
  });

  test('an oversize file is refused before any API call, without reading its full contents', async () => {
    const api = new FakeShareApi();
    const bigPath = path.join(tmpDir, 'huge.bin');
    // Sparse file: sets the logical size via truncate without writing
    // MAX_SHARED_FILE_BYTES of real bytes to disk.
    const fd = fs.openSync(bigPath, 'w');
    fs.closeSync(fd);
    fs.truncateSync(bigPath, MAX_SHARED_FILE_BYTES + 1);

    await expect(
      publishFile(api, {
        absPath: bigPath,
        siteUrl: 'https://acabox-share.example.workers.dev',
        existing: null,
      }),
    ).rejects.toThrow(/limit/i);

    expect(api.calls).toEqual([]);
  });

  test('a file exactly at the limit is not refused', async () => {
    const api = new FakeShareApi();
    const exactPath = path.join(tmpDir, 'exact.bin');
    const fd = fs.openSync(exactPath, 'w');
    fs.closeSync(fd);
    fs.truncateSync(exactPath, MAX_SHARED_FILE_BYTES);

    const { unchanged } = await publishFile(api, {
      absPath: exactPath,
      siteUrl: 'https://acabox-share.example.workers.dev',
      existing: null,
    });
    expect(unchanged).toBe(false);
    expect(api.calls.map((c) => c.op)).toEqual(['putFile', 'commit']);
  });

  test('unpublishFile calls remove with the existing kind and id, nothing else', async () => {
    const api = new FakeShareApi();
    const existing: PublishedInfo = {
      id: 'toremove123456',
      kind: 'file',
      url: 'https://acabox-share.example.workers.dev/f/toremove123456/',
      hash: sha256Hex('irrelevant'),
      publishedAt: '2026-01-01T00:00:00.000Z',
    };

    await unpublishFile(api, existing);

    expect(api.calls).toEqual([{ op: 'remove', kind: 'file', id: 'toremove123456' }]);
  });
});
