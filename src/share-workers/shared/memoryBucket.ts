/**
 * In-memory `BucketLike`, standing in for the real R2 binding under Jest (and
 * for local exploration — nothing here talks to the network or the disk).
 *
 * The paging contract mirrors R2 closely enough for the routes this project
 * needs: `list` is prefix-filtered, sorted by key, and paged by `limit` with
 * an opaque `cursor` — here, simply the last key returned, which is enough to
 * resume a listing without the caller ever inspecting the cursor's shape.
 */

import type { BucketLike, BucketObject } from './bucket';

interface StoredObject {
  key: string;
  bytes: Uint8Array;
  contentType?: string;
}

async function toBytes(value: ReadableStream | ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  // ReadableStream — drain it into one buffer.
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    if (chunk) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toBucketObject(stored: StoredObject): BucketObject {
  const { key, bytes, contentType } = stored;
  return {
    key,
    size: bytes.byteLength,
    httpMetadata: contentType !== undefined ? { contentType } : undefined,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    async text(): Promise<string> {
      return new TextDecoder().decode(bytes);
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      // Copy so a caller mutating the returned buffer can't corrupt the store.
      return bytes.slice().buffer;
    },
  };
}

export class MemoryBucket implements BucketLike {
  private readonly store = new Map<string, StoredObject>();

  async get(key: string): Promise<BucketObject | null> {
    const stored = this.store.get(key);
    return stored ? toBucketObject(stored) : null;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | string,
    opts?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown> {
    const bytes = await toBytes(value);
    this.store.set(key, { key, bytes, contentType: opts?.httpMetadata?.contentType });
    return { key };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.store.delete(key);
    }
  }

  async list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size: number }>;
    truncated: boolean;
    cursor?: string;
  }> {
    const prefix = opts.prefix ?? '';
    const limit = opts.limit ?? 1000;

    const matching = Array.from(this.store.values())
      .filter((o) => o.key.startsWith(prefix))
      .map((o) => ({ key: o.key, size: o.bytes.byteLength }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    let startIndex = 0;
    if (opts.cursor !== undefined) {
      const idx = matching.findIndex((o) => o.key === opts.cursor);
      // An unknown cursor (e.g. the underlying object was deleted since) has
      // nothing to resume from — treat it as "already exhausted" rather than
      // silently restarting from the top.
      startIndex = idx >= 0 ? idx + 1 : matching.length;
    }

    const page = matching.slice(startIndex, startIndex + limit);
    const truncated = startIndex + page.length < matching.length;

    return {
      objects: page,
      truncated,
      cursor: truncated ? page[page.length - 1].key : undefined,
    };
  }

  /** Test-only helper, not part of `BucketLike`. */
  clear(): void {
    this.store.clear();
  }

  /** Test-only helper, not part of `BucketLike`. */
  size(): number {
    return this.store.size;
  }
}
