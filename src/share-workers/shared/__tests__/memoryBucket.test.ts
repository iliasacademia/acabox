/**
 * @jest-environment node
 *
 * `MemoryBucket` stands in for R2 everywhere else in this project's test
 * suite (W2/W3/W4), so its own contract needs to be pinned first. It relies
 * on `ReadableStream`/`TextEncoder`/`TextDecoder`, which the default jsdom
 * test environment does not provide (verified: all three are absent on
 * `window` under jsdom 26, unlike `crypto`) — hence node, per the
 * ticket's "touches real … " rule extended to the Web platform globals a
 * Worker actually runs with.
 */

import { MemoryBucket } from '../memoryBucket';

describe('MemoryBucket', () => {
  it('round-trips a put through get, preserving content type and bytes', async () => {
    const bucket = new MemoryBucket();
    await bucket.put('a/1/meta.json', '{"ok":true}', { httpMetadata: { contentType: 'application/json' } });

    const obj = await bucket.get('a/1/meta.json');
    expect(obj).not.toBeNull();
    expect(obj!.key).toBe('a/1/meta.json');
    expect(obj!.httpMetadata?.contentType).toBe('application/json');
    expect(obj!.size).toBe(Buffer.byteLength('{"ok":true}', 'utf-8'));
    await expect(obj!.text()).resolves.toBe('{"ok":true}');
  });

  it('round-trips Uint8Array and ArrayBuffer bodies via arrayBuffer()', async () => {
    const bucket = new MemoryBucket();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await bucket.put('f/1/v/h/file.bin', bytes);

    const obj = await bucket.get('f/1/v/h/file.bin');
    const buf = new Uint8Array(await obj!.arrayBuffer());
    expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
  });

  it('accepts a ReadableStream body and drains it', async () => {
    const bucket = new MemoryBucket();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([72, 105])); // "Hi"
        controller.close();
      },
    });
    await bucket.put('f/2/v/h/name.txt', stream, { httpMetadata: { contentType: 'text/plain' } });

    const obj = await bucket.get('f/2/v/h/name.txt');
    await expect(obj!.text()).resolves.toBe('Hi');
  });

  it('returns null for a missing key', async () => {
    const bucket = new MemoryBucket();
    await expect(bucket.get('nope')).resolves.toBeNull();
  });

  it('lists only keys under the given prefix, sorted', async () => {
    const bucket = new MemoryBucket();
    await bucket.put('a/1/meta.json', 'x');
    await bucket.put('a/1/v/h/w/b.js', 'x');
    await bucket.put('a/1/v/h/w/a.js', 'x');
    await bucket.put('a/2/meta.json', 'x');

    const result = await bucket.list({ prefix: 'a/1/' });
    expect(result.objects.map((o) => o.key)).toEqual(['a/1/meta.json', 'a/1/v/h/w/a.js', 'a/1/v/h/w/b.js']);
    expect(result.truncated).toBe(false);
    expect(result.cursor).toBeUndefined();
  });

  it('pages a listing with limit and cursor until truncated is false', async () => {
    const bucket = new MemoryBucket();
    for (const n of [3, 1, 4, 2, 5]) {
      await bucket.put(`a/1/v/h/w/${n}.txt`, 'x');
    }

    const page1 = await bucket.list({ prefix: 'a/1/', limit: 2 });
    expect(page1.objects.map((o) => o.key)).toEqual(['a/1/v/h/w/1.txt', 'a/1/v/h/w/2.txt']);
    expect(page1.truncated).toBe(true);
    expect(page1.cursor).toBe('a/1/v/h/w/2.txt');

    const page2 = await bucket.list({ prefix: 'a/1/', limit: 2, cursor: page1.cursor });
    expect(page2.objects.map((o) => o.key)).toEqual(['a/1/v/h/w/3.txt', 'a/1/v/h/w/4.txt']);
    expect(page2.truncated).toBe(true);
    expect(page2.cursor).toBe('a/1/v/h/w/4.txt');

    const page3 = await bucket.list({ prefix: 'a/1/', limit: 2, cursor: page2.cursor });
    expect(page3.objects.map((o) => o.key)).toEqual(['a/1/v/h/w/5.txt']);
    expect(page3.truncated).toBe(false);
    expect(page3.cursor).toBeUndefined();
  });

  it('deletes an array of keys, leaving the rest untouched', async () => {
    const bucket = new MemoryBucket();
    await bucket.put('a/1/meta.json', 'x');
    await bucket.put('a/1/v/h/w/a.js', 'x');
    await bucket.put('a/2/meta.json', 'x');

    await bucket.delete(['a/1/meta.json', 'a/1/v/h/w/a.js']);

    expect(await bucket.get('a/1/meta.json')).toBeNull();
    expect(await bucket.get('a/1/v/h/w/a.js')).toBeNull();
    expect(await bucket.get('a/2/meta.json')).not.toBeNull();
  });

  it('deletes a single key given as a string', async () => {
    const bucket = new MemoryBucket();
    await bucket.put('solo', 'x');
    await bucket.delete('solo');
    expect(await bucket.get('solo')).toBeNull();
  });

  it('delete is a no-op for keys that do not exist', async () => {
    const bucket = new MemoryBucket();
    await expect(bucket.delete(['nope', 'also-nope'])).resolves.toBeUndefined();
  });

  it('list on an empty bucket returns an empty, non-truncated page', async () => {
    const bucket = new MemoryBucket();
    const result = await bucket.list({ prefix: '' });
    expect(result.objects).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.cursor).toBeUndefined();
  });
});
