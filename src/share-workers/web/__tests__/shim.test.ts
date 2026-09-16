/**
 * @jest-environment node
 *
 * Exercises `viewer/shim.ts` against the REAL bundled `assets/bridge/bridge.ts`
 * (contract C6 in `docs/design/sharing-tickets.md`), not a reimplementation of
 * it — a copy of the wire protocol here would keep passing while the shipped
 * bridge drifted out from under it. Same technique as
 * `src/cobuilding/main/__tests__/miniAppLinkShim.test.ts`: bundle with the
 * real esbuild, `eval` the result in a real JSDOM window, and drive the
 * bridge's own public API (`filesAPI`, `kernel`, `hostAPI`, `anthropicAPI`)
 * rather than posting raw messages, except for the two calls the bridge does
 * not expose a method for at all (`jobs:listForApp`, `mcp:listServers`).
 *
 * A top-level window's `parent` is itself, so installing the shim with
 * `hostWindow = frameWindow = dom.window` reproduces the real
 * frame-posts-to-parent relationship inside one JSDOM window, with both the
 * bridge's own `message` listener and the shim's listening on it.
 *
 * `@jest-environment node`: this file uses the real filesystem (esbuild reads
 * `bridge.ts` and its imports off disk) and builds its own JSDOM window
 * rather than relying on Jest's ambient one, per the sharing-tickets V1 spec.
 */

import { TextEncoder, TextDecoder } from 'util';

// jsdom's URL parser needs these on globalThis; harmless to set even where
// Node already provides them. Same workaround as miniAppLinkShim.test.ts,
// applied before jsdom is required.
if (!(globalThis as any).TextEncoder) (globalThis as any).TextEncoder = TextEncoder;
if (!(globalThis as any).TextDecoder) (globalThis as any).TextDecoder = TextDecoder;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom') as typeof import('jsdom');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const esbuild = require('esbuild') as typeof import('esbuild');
import * as path from 'path';

import { installShim, sendInit } from '../viewer/shim';
import { versionedBase, SHARE_REFUSAL_MESSAGE, type ArtifactMeta } from '../../../cobuilding/shared/share';

const BRIDGE_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'cobuilding',
  'skills',
  'manage-mini-application',
  'assets',
  'bridge',
  'bridge.ts',
);

// Bundled once for the whole suite — esbuild is deterministic and the source
// doesn't change between tests, so there's no reason to pay for it per case.
const BRIDGE_SOURCE = esbuild.buildSync({
  entryPoints: [BRIDGE_PATH],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
}).outputFiles[0].text;

const HASH = 'f'.repeat(64);
const ID = 'test-id';
const DIR_NAME = 'dnaToolkit';
// `/a/test-id/v/<hash>/w` — computed with the real function rather than
// hand-typed, so a change to the URL shape shows up here too.
const BASE = versionedBase('app', ID, HASH);

interface FixtureFile {
  bytes: Uint8Array;
}

function textFile(s: string): FixtureFile {
  return { bytes: new TextEncoder().encode(s) };
}

const DATA_JSON = `${BASE}/.applications/${DIR_NAME}/output/data.json`;
const DATA_CSV = `${BASE}/.applications/${DIR_NAME}/output/data.csv`;
const DATA_TSV = `${BASE}/.applications/${DIR_NAME}/output/data.tsv`;
const NOTES_MD = `${BASE}/.applications/${DIR_NAME}/output/notes.md`;
const CHART_PNG = `${BASE}/.applications/${DIR_NAME}/output/chart.png`;
const REPORT_XLSX = `${BASE}/.applications/${DIR_NAME}/output/report.xlsx`;
const NESTED_DEEP = `${BASE}/.applications/${DIR_NAME}/output/nested/deep.txt`;

const XLSX_BYTES = new Uint8Array([80, 75, 3, 4, 9, 9, 9, 0, 0, 1, 2, 3, 4, 5]);

/** An in-memory "snapshot" the shim's `fetchImpl` serves — no real network. */
const FIXTURE: Record<string, FixtureFile> = {
  [DATA_JSON]: textFile('{"hello":"world"}'),
  [DATA_CSV]: textFile('a,b\n1,2\n'),
  [DATA_TSV]: textFile('a\tb\n1\t2\n'),
  [NOTES_MD]: textFile('# Title'),
  [CHART_PNG]: { bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]) },
  [REPORT_XLSX]: { bytes: XLSX_BYTES },
  [NESTED_DEEP]: textFile('deep'),
};

function makeMeta(): ArtifactMeta {
  const files = Object.keys(FIXTURE).map((url) => {
    const rel = url.slice(BASE.length + 1);
    return { path: `w/${rel}`, size: FIXTURE[url].bytes.byteLength, sha256: 'a'.repeat(64) };
  });
  return {
    id: ID,
    kind: 'app',
    title: 'DNA Toolkit',
    description: null,
    hash: HASH,
    publishedAt: '2026-09-15T00:00:00.000Z',
    entry: `.applications/${DIR_NAME}/src/index.html`,
    dirName: DIR_NAME,
    files,
  };
}

/** Stands in for the versioned-asset route (C5) the real Worker would serve. */
async function fakeFetch(input: unknown): Promise<Response> {
  const url = typeof input === 'string' ? input : String(input);
  const file = FIXTURE[url];
  if (!file) {
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
    } as unknown as Response;
  }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () =>
      file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength),
    text: async () => new TextDecoder().decode(file.bytes),
  } as unknown as Response;
}

interface Harness {
  window: any;
  uninstall: () => void;
  refusals: string[];
}

/** A fresh JSDOM window with the real bridge loaded and the shim installed. */
function setup(): Harness {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://localhost/',
  });

  // The bundle includes `error-capture.ts`, which unconditionally does
  // `window.fetch.bind(window)` at load time. Plain JSDOM has no `fetch` at
  // all (verified: `typeof dom.window.fetch === 'undefined'`), so without a
  // stub the whole bundle throws before any bridge API is attached. The
  // shim's own fetching goes through the explicit `fetchImpl` below, never
  // through this stub.
  (dom.window as any).fetch = () => Promise.reject(new Error('fetch is stubbed out in this test'));

  dom.window.eval(BRIDGE_SOURCE);

  const refusals: string[] = [];
  const hostWindow = dom.window as unknown as Window;
  const uninstall = installShim({
    meta: makeMeta(),
    base: BASE,
    hostWindow,
    frameWindow: () => hostWindow,
    fetchImpl: fakeFetch as unknown as typeof fetch,
    onRefused: (call) => refusals.push(call),
  });

  return { window: dom.window, uninstall, refusals };
}

function waitTicks(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('viewer shim, driven through the real bridge', () => {
  it('readFile of a json resolves to text content', async () => {
    const { window } = setup();
    const result = await window.filesAPI.readFile(`.applications/${DIR_NAME}/output/data.json`);
    expect(result).toEqual({ type: 'text', content: '{"hello":"world"}' });
  });

  it('readFile of a csv carries the auto-detect (empty) delimiter', async () => {
    const { window } = setup();
    const result = await window.filesAPI.readFile(`.applications/${DIR_NAME}/output/data.csv`);
    expect(result).toEqual({ type: 'csv', content: 'a,b\n1,2\n', delimiter: '' });
  });

  it('readFile of a tsv carries a tab delimiter', async () => {
    const { window } = setup();
    const result = await window.filesAPI.readFile(`.applications/${DIR_NAME}/output/data.tsv`);
    expect(result).toEqual({ type: 'csv', content: 'a\tb\n1\t2\n', delimiter: '\t' });
  });

  it('readFile of markdown resolves to markdown content', async () => {
    const { window } = setup();
    const result = await window.filesAPI.readFile(`.applications/${DIR_NAME}/output/notes.md`);
    expect(result).toEqual({ type: 'markdown', content: '# Title' });
  });

  it('readFile of a png resolves to a fileUrl under the versioned base', async () => {
    const { window } = setup();
    const result = await window.filesAPI.readFile(`.applications/${DIR_NAME}/output/chart.png`);
    expect(result).toEqual({ type: 'image', fileUrl: CHART_PNG });
  });

  it('readFile of an xlsx base64-encodes exactly the bytes served', async () => {
    const { window } = setup();
    const result = await window.filesAPI.readFile(`.applications/${DIR_NAME}/output/report.xlsx`);
    expect(result.type).toBe('spreadsheet');
    expect(result.ext).toBe('xlsx');
    const decoded = new Uint8Array(Buffer.from(result.base64, 'base64'));
    expect(decoded).toEqual(XLSX_BYTES);
  });

  it('readFile of a missing file rejects with the exact not-found message', async () => {
    const { window } = setup();
    const missing = `.applications/${DIR_NAME}/output/missing.json`;
    await expect(window.filesAPI.readFile(missing)).rejects.toThrow(`File not found: ${missing}`);
  });

  it('./-prefixed and /-prefixed paths resolve to the same file', async () => {
    const { window } = setup();
    const a = await window.filesAPI.readFile(`./.applications/${DIR_NAME}/output/data.json`);
    const b = await window.filesAPI.readFile(`/.applications/${DIR_NAME}/output/data.json`);
    expect(a).toEqual({ type: 'text', content: '{"hello":"world"}' });
    expect(b).toEqual(a);
  });

  it('a path containing .. is refused outright, never resolved', async () => {
    const { window } = setup();
    const dotDot = `.applications/${DIR_NAME}/output/../output/data.json`;
    await expect(window.filesAPI.readFile(dotDot)).rejects.toThrow(`File not found: ${dotDot}`);
  });

  it('readDirectory lists depth-one entries, directories first then localeCompare', async () => {
    const { window } = setup();
    const result = await window.filesAPI.readDirectory(`.applications/${DIR_NAME}/output`);
    const prefix = `/.applications/${DIR_NAME}/output`;
    expect(result).toEqual([
      { name: 'nested', path: `${prefix}/nested`, isDirectory: true },
      { name: 'chart.png', path: `${prefix}/chart.png`, isDirectory: false },
      { name: 'data.csv', path: `${prefix}/data.csv`, isDirectory: false },
      { name: 'data.json', path: `${prefix}/data.json`, isDirectory: false },
      { name: 'data.tsv', path: `${prefix}/data.tsv`, isDirectory: false },
      { name: 'notes.md', path: `${prefix}/notes.md`, isDirectory: false },
      { name: 'report.xlsx', path: `${prefix}/report.xlsx`, isDirectory: false },
    ]);
  });

  it('readDirectory of an unknown directory rejects with the not-found message', async () => {
    const { window } = setup();
    const bogus = `.applications/${DIR_NAME}/does-not-exist`;
    await expect(window.filesAPI.readDirectory(bogus)).rejects.toThrow(`Directory not found: ${bogus}`);
  });

  it('kernel.executeCode is refused and reported to onRefused', async () => {
    const { window, refusals } = setup();
    await expect(window.kernel.executeCode('print(1)')).rejects.toThrow(SHARE_REFUSAL_MESSAGE);
    expect(refusals).toEqual(['executeCode']);
  });

  it('hostAPI.exec is refused and reported to onRefused', async () => {
    const { window, refusals } = setup();
    await expect(window.hostAPI.exec('ls', ['-la'])).rejects.toThrow(SHARE_REFUSAL_MESSAGE);
    expect(refusals).toEqual(['executeCommand']);
  });

  it('an arbitrary unhandled call (writeFile) is refused and reported', async () => {
    const { window, refusals } = setup();
    await expect(window.filesAPI.writeFile('a.txt', 'x')).rejects.toThrow(SHARE_REFUSAL_MESSAGE);
    expect(refusals).toEqual(['writeFile']);
  });

  it('anthropicAPI.stream is refused via the anthropic:error path, not onRefused', async () => {
    const { window, refusals } = setup();
    const onChunk = jest.fn();
    await expect(window.anthropicAPI.stream({ messages: [] }, onChunk)).rejects.toThrow(SHARE_REFUSAL_MESSAGE);
    expect(onChunk).not.toHaveBeenCalled();
    // The stream refusal is a distinct wire message (`anthropic:error`), not
    // the generic `{type:'response', error}` shape every other refused call
    // gets — so it must not be counted alongside them.
    expect(refusals).toEqual([]);
  });

  it('jobs:listForApp answers [] to a raw postMessage (the bridge exposes no method for it)', async () => {
    const { window } = setup();
    const reply = await new Promise((resolve) => {
      const handler = (event: any) => {
        if (event.data?.type === 'response' && event.data.id === 'raw-jobs-1') {
          window.removeEventListener('message', handler);
          resolve(event.data);
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'jobs:listForApp', id: 'raw-jobs-1' }, '*');
    });
    expect(reply).toEqual({ type: 'response', id: 'raw-jobs-1', result: [] });
  });

  it('mcp:listServers answers [] to a raw postMessage', async () => {
    const { window } = setup();
    const reply = await new Promise((resolve) => {
      const handler = (event: any) => {
        if (event.data?.type === 'response' && event.data.id === 'raw-mcp-1') {
          window.removeEventListener('message', handler);
          resolve(event.data);
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'mcp:listServers', id: 'raw-mcp-1' }, '*');
    });
    expect(reply).toEqual({ type: 'response', id: 'raw-mcp-1', result: [] });
  });

  it('ignores messages with no id (e.g. its own anthropic:error reply) and with type "response"', async () => {
    const { window } = setup();
    const seen: any[] = [];
    window.addEventListener('message', (event: any) => seen.push(event.data));

    window.postMessage({ type: 'jobs:listForApp' }, '*'); // no id
    window.postMessage({ type: 'response', id: 'whatever', result: 'x' }, '*'); // a "response"
    await waitTicks();

    // Neither should have produced a second reply beyond the messages we sent
    // ourselves — i.e. the shim never answered either one.
    const replies = seen.filter((m) => m.type === 'response' && m.id !== 'whatever');
    expect(replies).toHaveLength(0);
  });

  it('uninstall stops the shim from replying', async () => {
    const { window, uninstall } = setup();
    uninstall();

    const seen: any[] = [];
    window.addEventListener('message', (event: any) => seen.push(event.data));
    window.postMessage({ type: 'jobs:listForApp', id: 'raw-after-uninstall' }, '*');
    await waitTicks();

    expect(seen.some((m) => m.type === 'response' && m.id === 'raw-after-uninstall')).toBe(false);
  });

  it('sendInit posts the init message with an empty workspacePath', async () => {
    const { window } = setup();
    const received = await new Promise((resolve) => {
      window.addEventListener('message', function handler(event: any) {
        if (event.data?.type === 'init') {
          window.removeEventListener('message', handler);
          resolve(event.data);
        }
      });
      sendInit(window as unknown as Window);
    });
    expect(received).toEqual({ type: 'init', workspacePath: '' });
    // And the bridge itself picks it up, per its own `init` listener.
    await waitTicks(0);
    expect(window.getWorkspacePath()).toBe('');
  });
});
