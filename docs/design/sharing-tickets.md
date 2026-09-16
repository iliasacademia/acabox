# Sharing — implementation tickets

> Companion to `docs/design/sharing.md` (the why). This file is the what.
> **Orchestration model:** Fable reads, plans, reviews and verifies; each
> ticket below is dispatched to a **Sonnet 5** subagent that implements only
> that ticket. A ticket is sized so one agent finishes it in one sitting with
> no design decisions left to make. If a ticket turns out to need a decision,
> the implementer stops and reports instead of guessing.
>
> Written 2026-09-10. Status column is maintained by the orchestrator.
>
> | # | Ticket | Depends on | Status |
> |---|---|---|---|
> | S1 | Shared types, ids, URLs, content types | — | Done 2026-09-15, reviewed |
> | S2 | Move file-kind extension sets to `shared/` | — | Done 2026-09-15, reviewed |
> | M1 | Snapshot source enumeration + hash | S1 | Done 2026-09-15, reviewed |
> | M2 | `local-file://` rewrite | S1 | Done 2026-09-15, reviewed |
> | M3 | Stage a snapshot on disk | S1 M1 M2 | Done 2026-09-15, reviewed |
> | M4 | Share API HTTP client | S1 | Done 2026-09-15, reviewed |
> | M5 | App publisher + status | M3 M4 | Done 2026-09-15, reviewed |
> | M6 | File publisher + status | M4 | Done 2026-09-15, reviewed |
> | M7 | Share settings store (token encrypted) + published-files registry | S1 | Done 2026-09-15, reviewed |
> | M8 | `published` on the manifest and in `miniApps:list` | S1 | Done 2026-09-15, reviewed |
> | M9 | IPC handlers, preload, types | M5 M6 M7 M8 | Done 2026-09-15, reviewed |
> | M10 | Recompute "behind" after a build or a run | M9 | Done 2026-09-15, reviewed |
> | W1 | Workers scaffold, bucket interface, README | S1 | Done 2026-09-15, reviewed |
> | W2 | `acabox-share-api` Worker | W1 | Done 2026-09-15, reviewed |
> | W3 | Access JWT verification | W1 | Done 2026-09-15, reviewed |
> | W4 | `acabox-share` web Worker routes + listing page | W1 W3 | Done 2026-09-15, reviewed |
> | V1 | Viewer shim (bridge stand-in), tested against the real bridge | S1 S2 W1 | Done 2026-09-15, reviewed |
> | V2 | Viewer page (banner, iframe, states) | V1 W4 | Done 2026-09-15, reviewed |
> | U1 | Renderer share store + hook | M9 | Done 2026-09-15, reviewed |
> | U2 | Settings → Sharing | M9 | Done 2026-09-15, reviewed |
> | U3 | Publish dialog | U1 M9 | Done 2026-09-15, reviewed |
> | U4 | Tools page: sharing block | U3 | Done 2026-09-15, reviewed |
> | U5 | Tool header: SHARED chip + share button | U3 | Done 2026-09-15, reviewed |
> | U6 | Files tab: Share / Copy link / Unpublish | M9 | Done 2026-09-15, reviewed |
> | D1 | `hostAPI.fileUrl()` + SKILL.md guidance | — | Done 2026-09-15, reviewed |
> | X1 | End-to-end verification (orchestrator, manual) | all | In progress |

---

## Rules for every ticket

Read `CLAUDE.md` → *Conventions* before touching anything. Then:

1. **Scope.** Create or modify only the files the ticket lists. If you find you
   must touch another file, do the minimum and call it out in your report.
2. **Verify, then report.** Before reporting: `npx tsc --noEmit` is clean;
   `npm test -- <path-to-your-test-file>` is green; then the full `npm test` is
   green. **Never run bare `npx jest`** — it uses the wrong Node ABI and fails
   on an unrelated suite.
3. **Tests live in `__tests__/` beside the module.** Tests that touch the real
   filesystem, `http`, or `crypto.subtle` start with
   `/** @jest-environment node */` (the default environment is jsdom).
4. **No new root dependencies.** `src/share-workers/package.json` is the one
   place a dev dependency (wrangler) may be added; it is never installed at the
   repo root.
5. **Electron-free where the ticket says so.** Modules marked *electron-free*
   must not import `electron` or `electron-log`; they take paths and callbacks
   as arguments. That is what makes them testable under Jest.
6. **Secrets.** The publish token is decrypted only in main, never sent to the
   renderer (the UI receives `hasToken: boolean`), never logged, never written
   to the workspace.
7. **No mocks in prod UI.** A UI element shows a real value from IPC or is not
   rendered. No placeholder counts, no fabricated statuses.
8. **Style.** Match the neighbouring code. Reuse existing CSS classes and
   `--cd-*` tokens; new classes only when nothing fits. You cannot take
   screenshots; the orchestrator will, so say which layouts need one.
9. **Do not commit.** Leave the working tree for review.
10. **Report** in this shape: files changed; what each does in one line;
    exact commands run and their counts; anything that deviates from the ticket
    and why; open questions.

---

## Contracts (referenced by tickets — do not redefine)

### C1. Shared types — `src/cobuilding/shared/share.ts` (created by S1)

```ts
export type ShareKind = 'app' | 'file';

export interface ShareSettings {
  siteUrl: string;       // https://acabox-share.<acct>.workers.dev  (no trailing slash)
  apiUrl: string;        // https://acabox-share-api.<acct>.workers.dev
  publishToken: string;  // decrypted in main only; '' on the UI side
}

export interface PublishedInfo {
  id: string;            // slug, see mintShareId
  kind: ShareKind;
  url: string;           // artifactUrl(siteUrl, kind, id)
  hash: string;          // snapshot hash at publish time (64 hex chars)
  publishedAt: string;   // ISO 8601
  includeInput?: boolean; // apps only
}

/** One file in a snapshot. `path` is posix, relative to the version root, e.g. `w/.applications/x/output/a.json`. */
export interface SnapshotFile { path: string; size: number; sha256: string; }

export interface SnapshotGroup { count: number; bytes: number; }
export interface SnapshotSummary {
  code: SnapshotGroup;    // everything under w/.applications/<dir>/ except input/ and output/
  output: SnapshotGroup;  // w/.applications/<dir>/output/**
  input: SnapshotGroup;   // w/.applications/<dir>/input/**
  vendor: SnapshotGroup;  // w/.applications/_vendor/**
  total: SnapshotGroup;
}

/** Stored in R2 at metaKey(kind, id). Read by the viewer shim and the listing page. */
export interface ArtifactMeta {
  id: string;
  kind: ShareKind;
  title: string;
  description: string | null;
  hash: string;
  publishedAt: string;
  /** app: `.applications/<dir>/src/index.html` (relative to `w/`). file: the file's basename. */
  entry: string;
  dirName?: string;      // apps only
  files: SnapshotFile[];
}

export interface ShareIndexEntry {
  id: string; kind: ShareKind; title: string; description: string | null;
  publishedAt: string; hash: string;
}
export interface ShareIndex { updatedAt: string; artifacts: ShareIndexEntry[]; }

export const SHARE_REFUSAL_MESSAGE =
  'This is a shared, read-only snapshot. Open the tool in Acabox to run it.';
```

Functions (all pure; `globalThis.crypto.getRandomValues` is the only platform call):

```ts
export function mintShareId(): string;                 // 16 chars, [a-z0-9], from getRandomValues
export function isValidShareId(id: string): boolean;   // /^[a-z0-9]{10,32}$/
export function isValidHash(hash: string): boolean;    // /^[a-f0-9]{64}$/
export function normalizeBaseUrl(url: string): string; // trim, strip trailing slashes
export function validateShareSettings(s: { siteUrl: string; apiUrl: string }): { ok: true } | { ok: false; error: string };
  // both must parse; https: only, except http: on 127.0.0.1 / localhost (tests, local wrangler dev); no userinfo; no query/hash
export function artifactUrl(siteUrl: string, kind: ShareKind, id: string): string;   // `${base}/a/${id}/` | `${base}/f/${id}/`
export function kindPrefix(kind: ShareKind): 'a' | 'f';
export function metaKey(kind: ShareKind, id: string): string;                         // `a/<id>/meta.json`
export function versionPrefix(kind: ShareKind, id: string, hash: string): string;    // `a/<id>/v/<hash>/`
export function versionedBase(kind: ShareKind, id: string, hash: string): string;    // app: `/a/<id>/v/<hash>/w`   file: `/f/<id>/v/<hash>`
export const INDEX_KEY = 'index.json';
export function summarizeSnapshot(files: SnapshotFile[], dirName: string): SnapshotSummary;
export function contentTypeFor(path: string): string;
  // html js mjs css json png jpg jpeg gif webp svg ico pdf csv tsv txt md xlsx xls woff woff2 ttf map wasm → the usual types
  // (text types carry `; charset=utf-8`); anything else → application/octet-stream
export function normalizeSnapshotPath(input: string): string | null;
  // for the shim and the web Worker: strip leading './' and '/', collapse '//' , resolve '.' segments,
  // return null if any '..' segment remains or the result is empty
```

### C2. R2 layout

```
index.json                              ShareIndex (maintained by the api Worker)
a/<id>/meta.json                        ArtifactMeta for an app   (Cache-Control: no-store)
a/<id>/v/<hash>/w/.applications/<dir>/src/index.html
a/<id>/v/<hash>/w/.applications/<dir>/dist/bundle.js       (after the local-file:// rewrite)
a/<id>/v/<hash>/w/.applications/<dir>/output/**            (symlinks dereferenced)
a/<id>/v/<hash>/w/.applications/<dir>/input/**             (only when includeInput)
a/<id>/v/<hash>/w/.applications/<dir>/**                   (the rest of the app dir; see M1 exclusions)
a/<id>/v/<hash>/w/.applications/_vendor/**
f/<id>/meta.json                        ArtifactMeta for a file
f/<id>/v/<hash>/<basename>
```

Versioned objects are immutable (`Cache-Control: public, max-age=31536000, immutable`).
`meta.json`, `index.json` and the viewer assets are `no-store`.

### C3. Snapshot hash

Sources are enumerated per M1. For each file compute `sha256hex(fileBytes)`. Sort files by `path`. The snapshot hash is `sha256hex` of the concatenation, over all files in that order, of the line `<path> <sha256hex>` followed by a newline.

The hash covers **source bytes, before the rewrite** (the rewrite embeds the hash, so it cannot be inside it). `SnapshotFile.sha256` is likewise the source digest.

### C4. `acabox-share-api` HTTP contract (W2 implements, M4 consumes)

Every route requires `Authorization: Bearer <PUBLISH_TOKEN>` (constant-time compare) → otherwise `401 {"error":"unauthorized"}`.
`:kind` is `app` or `file`. All responses are JSON unless noted.

| Method | Route | Body | Response |
|---|---|---|---|
| GET | `/v1/health` | — | `200 {"ok":true}` |
| GET | `/v1/artifacts` | — | `200 ShareIndex` (empty index if none) |
| GET | `/v1/artifacts/:kind/:id` | — | `200 ArtifactMeta` or `404 {"error":"not-found"}` |
| PUT | `/v1/artifacts/:kind/:id/v/:hash/*` | raw bytes, `Content-Type` header | stores at `versionPrefix + *`; `200 {"ok":true,"key":"..."}` |
| PUT | `/v1/artifacts/:kind/:id` | `ArtifactMeta` JSON; `id`/`kind` must match URL, `hash` valid | writes meta.json; upserts `index.json`; deletes every other `…/v/<otherHash>/` prefix; `200 {"ok":true}` |
| DELETE | `/v1/artifacts/:kind/:id` | — | deletes `<a or f>/<id>/**`; removes from `index.json`; `200 {"ok":true}` even if absent |

Validation failures → `400 {"error":"<reason>"}`. Path segments in `*` go through `normalizeSnapshotPath`; null → 400.

### C5. `acabox-share` web routes (W4)

All routes require a valid Access JWT (W3) unless `env.ACCESS_DISABLED === 'true'`.

| Route | Serves | Cache |
|---|---|---|
| `GET /` | HTML listing built from `index.json` | no-store |
| `GET /a/:id/` | `viewer.html` static asset | no-store |
| `GET /a/:id/meta.json` | R2 `a/<id>/meta.json` (404 JSON if missing) | no-store |
| `GET /a/:id/v/:hash/w/*` | R2 object; `Content-Type` from `contentTypeFor` | immutable |
| `GET /f/:id/` | `302` → `/f/<id>/v/<meta.hash>/<meta.entry>` | no-store |
| `GET /f/:id/v/:hash/:name` | R2 object, `Content-Disposition: inline` | immutable |
| `GET /viewer.js`, `/viewer.css` | static assets | no-store |
| anything else | `404` | — |

### C6. Bridge wire protocol (from `assets/bridge/bridge.ts`, do not change it)

- Frame → host request: `{ type: '<call>', id: 'req-N', ...args }` via `window.parent.postMessage(msg, '*')`.
- Host → frame reply: `{ type: 'response', id, result }` or `{ type: 'response', id, error: string }`.
- Host → frame once after load: `{ type: 'init', workspacePath: string }`.
- Streaming (`anthropic:stream`) is keyed on `requestId`, not `id`: refuse with `{ type: 'anthropic:error', requestId: <id>, error }`.
- Calls and their args: `readFile{path}` `writeFile{path,content}` `copyFile{sourcePath,destinationDir}` `deleteFile{path}` `downloadFile{filename,content}` `showInFinder{path}` `selectFile{filters}` `selectDirectory{}` `readDirectory{path}` `connectKernel{kernelName}` `executeCode{code}` `executeCommand{command,args}` `api:request{apiId,path,method,headers,body}` `anthropic:complete{...}` `anthropic:stream{...}` `requestFix{...}` `academia:fetch{...}` `openExternal{url}` `jobs:listForApp{}` `mcp:listServers{}` `mcp:callTool{...}` `setComposerText{...}` `quoteSelection{...}`.

`readFile` result shapes the shim must mirror (from `main/fileHandlers.ts` `files:readFile`):
`{type:'image', fileUrl}` · `{type:'pdf', fileUrl}` · `{type:'spreadsheet', base64, ext}` · `{type:'markdown', content}` · `{type:'csv', content, delimiter}` (a tab character for `.tsv`, else the empty string) · `{type:'text', content}`.
`readDirectory` result: `Array<{ name, path, isDirectory }>`, directories first, then `localeCompare` on name.

### C7. Worker environment (local interfaces — no `@cloudflare/workers-types`)

```ts
// src/share-workers/shared/bucket.ts (W1)
export interface BucketObject {
  key: string; size: number;
  httpMetadata?: { contentType?: string };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface BucketLike {
  get(key: string): Promise<BucketObject | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string,
      opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(opts: { prefix: string; cursor?: string; limit?: number }):
      Promise<{ objects: Array<{ key: string; size: number }>; truncated: boolean; cursor?: string }>;
}
export interface AssetsLike { fetch(request: Request): Promise<Response>; }
export interface ApiEnv { BUCKET: BucketLike; PUBLISH_TOKEN: string; }
export interface WebEnv { BUCKET: BucketLike; ASSETS: AssetsLike; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; ACCESS_DISABLED?: string; }
```

---

## Tickets

Template: **Goal · Read first · Create / Modify · Spec · Tests · Acceptance · Out of scope.**

---

### S1 — Shared types, ids, URLs, content types

**Goal.** Create `src/cobuilding/shared/share.ts` exactly as in C1, with tests.

**Read first.** `src/cobuilding/shared/apis.ts` (style of a shared module with validation), `src/cobuilding/shared/__tests__/`.

**Create.** `src/cobuilding/shared/share.ts`, `src/cobuilding/shared/__tests__/share.test.ts`.

**Spec.** C1 verbatim. Notes:
- `mintShareId` uses `globalThis.crypto.getRandomValues(new Uint8Array(16))` mapped to `[a-z0-9]` via modulo 36 per byte; length 16.
- `validateShareSettings` rejects: empty; unparsable; scheme not https (except http on `127.0.0.1` or `localhost`); userinfo present; search or hash present. Error strings are user-facing and short ("Site URL must start with https://").
- `summarizeSnapshot` groups by prefix: `w/.applications/<dirName>/output/`, `…/input/`, `w/.applications/_vendor/`, else code. `total` is the sum.
- `normalizeSnapshotPath('./.applications/x/output/../a.json')` → `null` (a `..` is refused, never resolved).

**Tests** (at least 25 cases): each validator's accept and reject cases; `artifactUrl` trims trailing slashes; `versionedBase` for both kinds; `contentTypeFor` for 8 extensions + unknown + uppercase extension; `normalizeSnapshotPath` for leading `./`, leading `/`, `//`, embedded `/./`, `..`, empty; `summarizeSnapshot` on a 6-file list; `mintShareId` returns 16 valid chars and 100 mints are distinct.

**Acceptance.** `npm test -- src/cobuilding/shared/__tests__/share.test.ts` green; tsc clean.

**Out of scope.** Anything that touches the filesystem, IPC or React.

---

### S2 — Move file-kind extension sets to `shared/`

**Goal.** The viewer shim (V1) must classify files exactly as `files:readFile` does. Give both one source of truth.

**Read first.** `src/cobuilding/main/fileHandlers.ts` — the `IMAGE_EXTENSIONS`, `PDF_EXTENSIONS`, `SPREADSHEET_EXTENSIONS`, `MARKDOWN_EXTENSIONS`, `CSV_EXTENSIONS` constants and the `files:readFile` handler.

**Create.** `src/cobuilding/shared/fileKinds.ts`, `src/cobuilding/shared/__tests__/fileKinds.test.ts`.
**Modify.** `src/cobuilding/main/fileHandlers.ts` (import the sets instead of defining them; behaviour unchanged).

**Spec.**
```ts
export const IMAGE_EXTENSIONS: ReadonlySet<string>; // etc. — the exact same members as today
export type BridgeFileKind = 'image' | 'pdf' | 'spreadsheet' | 'markdown' | 'csv' | 'text';
export function classifyForBridge(filePath: string): BridgeFileKind; // by lowercase extension, same precedence as the handler
export function csvDelimiterFor(filePath: string): string;           // a tab for .tsv, '' otherwise
```

**Tests.** One case per kind, an uppercase extension, no extension → text; a test that `fileHandlers.ts` no longer contains `new Set([` for those five names (read the source with `fs`, assert the import is present instead).

**Acceptance.** Full `npm test` green (the existing FilesTab/fileHandlers tests must still pass unchanged); tsc clean.

---

### M1 — Snapshot source enumeration + hash *(electron-free)*

**Goal.** Enumerate exactly the files that make up an app's snapshot, and hash them per C3.

**Read first.** C1, C2, C3. `src/cobuilding/main/fileHandlers.ts` `miniApps:export` (the `cp` with `dereference: true` — that is the model for symlink handling). `src/cobuilding/main/toolDataMigration.ts` (how `input`/`output` are symlinks into `tool-data/`).

**Create.** `src/cobuilding/main/share/snapshotSources.ts`, `src/cobuilding/main/share/__tests__/snapshotSources.test.ts`.

**Spec.**
```ts
export interface SnapshotSourceSpec { workspaceRoot: string; dirName: string; includeInput: boolean; }
export interface SnapshotSource { snapshotPath: string; sourcePath: string; size: number; } // snapshotPath per C2 (`w/…`), posix
export async function listSnapshotSources(spec: SnapshotSourceSpec): Promise<SnapshotSource[]>;   // sorted by snapshotPath
export async function hashSnapshotSources(sources: SnapshotSource[]): Promise<{ hash: string; files: SnapshotFile[] }>;
```
- Roots: `<workspaceRoot>/.applications/<dirName>` and `<workspaceRoot>/.applications/_vendor`. Missing `_vendor` is not an error (empty). Missing app dir → throw `Error('App not found: <dirName>')`.
- Walk with `fs.promises.readdir({withFileTypes:true})`. **Follow symlinks** (`fs.promises.stat`, not `lstat`) — `input`/`output` are symlinks. Skip broken symlinks silently. Skip: `node_modules/`, `.git/`, `.DS_Store`, and `input/**` when `includeInput` is false. Do not follow a symlink whose realpath is outside `workspaceRoot` (skip it).
- Reject `dirName` containing `/`, `\`, or starting with `.` → throw.
- Hash: sha256 via `crypto.createHash`, streaming (`fs.createReadStream`) — a 15 MB bundle must not be read into a string.

**Tests** (`@jest-environment node`, temp dir via `fs.mkdtempSync`): build a fixture workspace with `.applications/x/{src/index.html,dist/bundle.js,manifest.json,node_modules/junk.js}`, `tool-data/x/{input/i.csv,output/o.json}` and symlinks `.applications/x/input → ../../tool-data/x/input`, same for output, plus `.applications/_vendor/acabox.css`. Assert: exact sorted `snapshotPath` list with and without `includeInput`; `node_modules` absent; a broken symlink is skipped; a symlink to `/etc` is skipped; hash is stable across two calls; changes when one byte of `o.json` changes; identical for a copy of the fixture at a different absolute path (paths in the hash are snapshot-relative).

**Acceptance.** Test green; tsc clean.

---

### M2 — `local-file://` rewrite *(electron-free, pure)*

**Goal.** Mini-apps build image URLs as `` `local-file://${workspacePath}/.applications/…` `` (see `skills/manage-mini-application/SKILL.md` lines ~672–693). Browsers cannot serve that scheme. Replace the literal at publish time.

**Create.** `src/cobuilding/main/share/rewriteLocalFileUrls.ts`, `__tests__/rewriteLocalFileUrls.test.ts`.

**Spec.**
```ts
export const REWRITABLE_EXTENSIONS: ReadonlySet<string>; // js mjs html css
export function rewriteLocalFileUrls(source: string, base: string): { output: string; count: number };
export function shouldRewrite(snapshotPath: string, dirName: string): boolean;
  // true only for files under `w/.applications/<dirName>/` with a rewritable extension — never `_vendor`
```
Replace every occurrence of the exact literal `local-file://` with `base` (e.g. `/a/abc/v/<hash>/w`). No regex beyond a global literal replace. Note in a comment why the shim sends `workspacePath: ''` — the app's template then resolves to `<base>/.applications/…`.

**Tests.** Template literal form, string concatenation form, three occurrences, none, `shouldRewrite` for `dist/bundle.js` (true), `src/index.html` (true), `output/data.json` (false — json is not rewritable), `_vendor/tailwind.js` (false), another app's `bundle.js` (false).

---

### M3 — Stage a snapshot on disk *(electron-free)*

**Goal.** Materialise the snapshot into a staging directory, laid out per C2, with the rewrite applied.

**Read first.** M1, M2 outputs; `src/cobuilding/main/share/snapshotSources.ts`.

**Create.** `src/cobuilding/main/share/stageSnapshot.ts`, `__tests__/stageSnapshot.test.ts`.

**Spec.**
```ts
export interface StagedFile { snapshotPath: string; absPath: string; contentType: string; size: number; }
export async function stageSnapshot(input: {
  sources: SnapshotSource[]; dirName: string; kind: 'app'; id: string; hash: string; stagingDir: string;
}): Promise<StagedFile[]>;
```
- Copies each source to `<stagingDir>/<snapshotPath>` (mkdir -p). For files where `shouldRewrite` is true: read as utf-8, `rewriteLocalFileUrls(text, versionedBase('app', id, hash))`, write the output. Others: `fs.promises.copyFile`.
- `contentType` from `contentTypeFor`. `size` is the staged size (post-rewrite).
- Returns staged files sorted by `snapshotPath`. Does not delete `stagingDir` (the caller owns it).

**Tests** (node env, temp dirs): run M1's fixture through `listSnapshotSources` → `stageSnapshot`; assert every file exists at its path; `bundle.js` no longer contains `local-file://` and contains the versioned base; `_vendor/tailwind.js` byte-identical to the source even if it contains `local-file://`; `output/o.json` byte-identical; count matches sources.

---

### M4 — Share API HTTP client *(electron-free)*

**Goal.** A small typed client for C4 with retries, tested against a real local HTTP server.

**Read first.** C4. `src/cobuilding/main/__tests__/apiProxy.test.ts` (how this repo runs a real `http.createServer` in a test).

**Create.** `src/cobuilding/main/share/shareApiClient.ts`, `__tests__/shareApiClient.test.ts`.

**Spec.**
```ts
export class ShareApiError extends Error { constructor(public status: number, message: string) }
export interface ShareApi {
  health(): Promise<void>;
  listArtifacts(): Promise<ShareIndex>;
  getArtifact(kind: ShareKind, id: string): Promise<ArtifactMeta | null>;   // null on 404
  putFile(kind: ShareKind, id: string, hash: string, relPath: string, body: Uint8Array | ReadableStream, contentType: string): Promise<void>;
  commit(meta: ArtifactMeta): Promise<void>;
  remove(kind: ShareKind, id: string): Promise<void>;
}
export class ShareApiClient implements ShareApi {
  constructor(opts: { apiUrl: string; token: string; fetchImpl?: typeof fetch; maxAttempts?: number /* default 3 */; baseDelayMs?: number /* default 250 */ });
}
```
- `Authorization: Bearer <token>` on every request. URL = `normalizeBaseUrl(apiUrl) + route`. `relPath` segments are URL-encoded individually.
- Retry on network error, 429, and 5xx with exponential backoff (`baseDelayMs * 2^attempt`). Never retry 4xx other than 429. After the last attempt throw `ShareApiError`.
- Non-2xx → `ShareApiError(status, body.error ?? statusText)`.
- Use global `fetch` (Electron's Node 22 has it). For a `Uint8Array` body send it directly; for a stream set `duplex: 'half'`.

**Tests** (node env): spin up `http.createServer` on `127.0.0.1:0` that records requests and scripts responses. Cases: bearer header present; `health` ok; `getArtifact` 404 → null; `putFile` sends bytes + content-type to the right path (with a space in `relPath` encoded); `commit` PUTs JSON; `remove` DELETEs; 500 then 200 → succeeds on retry (assert 2 hits); 400 → no retry, throws with the server's `error`; three 503s → throws after exactly 3 hits.

---

### M5 — App publisher + status *(electron-free)*

**Goal.** Orchestrate hash → stage → upload → commit, and answer "is the shared copy behind".

**Read first.** M1–M4 modules and their tests.

**Create.** `src/cobuilding/main/share/publishApp.ts`, `__tests__/publishApp.test.ts`.

**Spec.**
```ts
export interface PublishAppInput {
  workspaceRoot: string; dirName: string; includeInput: boolean; siteUrl: string;
  title: string; description: string | null;
  existing: PublishedInfo | null;                 // reuse its id when present
  stagingRoot?: string;                            // default os.tmpdir()
  concurrency?: number;                            // default 4
  onProgress?: (p: { uploaded: number; total: number }) => void;
}
export async function publishApp(api: ShareApi, input: PublishAppInput): Promise<{ published: PublishedInfo; unchanged: boolean }>;
export async function computeAppStatus(input: { workspaceRoot: string; dirName: string; includeInput: boolean; existing: PublishedInfo | null })
  : Promise<{ hash: string; behind: boolean; summary: SnapshotSummary; files: SnapshotFile[] }>;
export async function unpublishApp(api: ShareApi, existing: PublishedInfo): Promise<void>;
```
- `publishApp`: sources → hash. If `existing && existing.hash === hash` → return `{ published: existing, unchanged: true }` without uploading. Else `id = existing?.id ?? mintShareId()`; stage into `<stagingRoot>/acabox-share-<randomUUID>`; upload all staged files with a bounded worker pool (`concurrency`), calling `onProgress` after each; then `api.commit(meta)` with `entry = '.applications/<dirName>/src/index.html'`; finally `rm -rf` the staging dir (also on failure). Return `PublishedInfo` with `url = artifactUrl(siteUrl, 'app', id)`.
- `computeAppStatus`: `behind = existing !== null && existing.hash !== hash`. No network.
- Never write the manifest here (M8/M9 do).

**Tests** (node env): a `FakeShareApi` implementing `ShareApi` that records calls in order and can be told to fail `putFile` once. Against M1's fixture: publish → assert order is N×putFile then exactly one commit; commit meta has the right `entry`, `dirName`, `files.length`, `hash`; all `putFile` `relPath`s equal the staged paths; `onProgress` reaches `{uploaded: N, total: N}`; staging dir removed afterwards (also when `putFile` throws); second publish with `existing.hash === hash` → `unchanged: true` and zero API calls; after editing `o.json`, `computeAppStatus(...).behind === true` and a publish reuses the id; `unpublishApp` calls `remove('app', id)`.

---

### M6 — File publisher + status *(electron-free)*

**Goal.** Same as M5 for a single workspace file.

**Create.** `src/cobuilding/main/share/publishFile.ts`, `__tests__/publishFile.test.ts`.

**Spec.**
```ts
export const MAX_SHARED_FILE_BYTES = 100 * 1024 * 1024;
export async function hashFile(absPath: string): Promise<{ hash: string; size: number }>;  // sha256 of contents, streaming
export async function publishFile(api: ShareApi, input: {
  absPath: string; siteUrl: string; existing: PublishedInfo | null; title?: string;
}): Promise<{ published: PublishedInfo; unchanged: boolean }>;
export async function computeFileStatus(input: { absPath: string; existing: PublishedInfo | null }): Promise<{ hash: string; behind: boolean }>;
export async function unpublishFile(api: ShareApi, existing: PublishedInfo): Promise<void>;
```
- One `putFile('file', id, hash, basename, bytes, contentTypeFor(basename))`, then `commit` with `entry = basename`, `title = title ?? basename`, `files = [{ path: basename, size, sha256: hash }]`.
- Refuse files over `MAX_SHARED_FILE_BYTES` with a clear `Error` (Workers request bodies are capped) before any API call.

**Tests** (node env): temp file; publish → one putFile + one commit with expected fields; unchanged path; behind after modification; oversize refused without any API call.

---

### M7 — Share settings store + published-files registry

**Goal.** Persist `ShareSettings` (token encrypted at rest) and the map of published files, in `cobuilding-settings.json`.

**Read first.** `src/cobuilding/main/apiStore.ts` and `src/cobuilding/main/__tests__/apiStore.test.ts` (this is the pattern: settings file under `app.getPath('userData')`, `secretStore` encryption, blank-means-keep, boot migration, and how the test mocks `electron`). `src/cobuilding/main/secretStore.ts`.

**Create.** `src/cobuilding/main/share/shareStore.ts`, `__tests__/shareStore.test.ts`.

**Spec.** Settings key `sharing`:
```json
{ "sharing": { "siteUrl": "", "apiUrl": "", "publishToken": "enc:v1:…", "files": { "<workspace-relative posix path>": PublishedInfo } } }
```
```ts
export interface ShareSettingsForUi { siteUrl: string; apiUrl: string; hasToken: boolean; }
export function getShareSettings(): ShareSettings;                 // decrypted; main-only
export function getShareSettingsForUi(): ShareSettingsForUi;
export function saveShareSettings(patch: { siteUrl: string; apiUrl: string; publishToken?: string; clearToken?: boolean }): { ok: true } | { ok: false; error: string };
  // validateShareSettings first; blank/undefined publishToken keeps the stored one; clearToken removes it
export function isShareConfigured(): boolean;                      // all three non-empty
export function migratePlaintextShareToken(): void;                // re-encrypt a legacy plaintext token once; call after whenReady
export function getPublishedFile(relPath: string): PublishedInfo | null;
export function setPublishedFile(relPath: string, info: PublishedInfo): void;
export function removePublishedFile(relPath: string): void;
export function listPublishedFiles(): Array<{ relPath: string; info: PublishedInfo }>;
```
Writes are atomic (temp file + rename) as in `apiStore.ts`. Do not log the token, ever — not even at debug level.

**Tests** (node env, mocked `electron` exactly like `apiStore.test.ts`): save → file has `enc:v1:` and no plaintext token anywhere in the file text; `getShareSettingsForUi().hasToken === true` and carries no token field; blank token on second save keeps the stored one; `clearToken` removes it; invalid URL rejected with the validator's message and nothing written; published-files CRUD round-trips; migration re-encrypts a hand-written plaintext token.

---

### M8 — `published` on the manifest and in `miniApps:list`

**Goal.** Persist an app's `PublishedInfo` in its `manifest.json` and surface it to the renderer.

**Read first.** `src/cobuilding/main/manifestIO.ts` (`updateManifest` — all manifest writes go through it), `stampToolLastRun` in `src/cobuilding/main/index.ts` (~line 749, the model for a by-dirName manifest write), the `miniApps:list` handler in `src/cobuilding/main/fileHandlers.ts` (~line 438), `MiniAppEntry` in `src/cobuilding/renderer/types.d.ts` (~line 801).

**Create.** `src/cobuilding/main/share/publishedRecord.ts`, `__tests__/publishedRecord.test.ts`.
**Modify.** `fileHandlers.ts` (`miniApps:list` adds `published`), `renderer/types.d.ts` (`MiniAppEntry.published: PublishedInfo | null`), and every test fixture that constructs a `MiniAppEntry` (add `published: null`).

**Spec.**
```ts
export function manifestPathFor(workspaceRoot: string, dirName: string): string;
export async function readPublished(workspaceRoot: string, dirName: string): Promise<PublishedInfo | null>;  // validates shape; malformed → null
export async function writePublished(workspaceRoot: string, dirName: string, info: PublishedInfo): Promise<void>;  // via updateManifest
export async function clearPublished(workspaceRoot: string, dirName: string): Promise<void>;
```
`miniApps:list` returns `published` only when the stored object has string `id`, `kind`, `url`, `hash`, `publishedAt`; otherwise `null`.

**Tests** (node env, temp dir): write → read round-trip; clear → null; a manifest with `published: "garbage"` reads as null; other manifest keys survive a write (read the JSON and compare).

**Acceptance.** Full `npm test` green — the `MiniAppEntry` change touches existing renderer tests.

---

### M9 — IPC handlers, preload, types

**Goal.** Wire M5–M8 to the renderer.

**Read first.** How `apis:*` handlers are registered in `src/cobuilding/main/index.ts` (~lines 2787–2930) and exposed in `src/cobuilding/main/preload.ts` (`apisAPI`, ~line 66) and typed in `renderer/types.d.ts` (`ApisAPI`); the `scheduledTasks:changed` broadcast (~line 1044) and `jobsAPI.onChanged` in preload (~line 195); `assertWithinAllowedDirs` in `fileHandlers.ts:43`.

**Create.** `src/cobuilding/main/share/shareHandlers.ts`, `__tests__/shareHandlers.test.ts` (pure parts only — see below).
**Modify.** `main/index.ts` (one `registerShareHandlers(...)` call beside `registerFileHandlers`, plus `migratePlaintextShareToken()` after `whenReady` next to the other migrations), `main/preload.ts` (`shareAPI`), `renderer/types.d.ts` (`ShareAPI` + `window.shareAPI`).

**Spec.**
```ts
export function registerShareHandlers(deps: {
  getWorkspaceRoot: () => string | null;
  getAllowedPaths: () => string[];
  broadcast: (channel: string, payload: unknown) => void;   // to all windows
}): void;
export async function recomputeAndBroadcastApp(dirName: string): Promise<void>;  // used by M10; reads manifest, computes status, broadcasts share:changed
```
Channels (all `ipcMain.handle`), shapes as in `ShareAPI` below:
- `share:getSettings` → `ShareSettingsForUi`
- `share:saveSettings(patch)` → `{ok,error?}`
- `share:test` → `{ ok, status, error }` (calls `health()`; a `ShareApiError` maps to its status; a missing configuration → `{ok:false,status:0,error:'Sharing is not configured'}`)
- `share:planApp(dirName, includeInput)` → `{ ok:true, summary, hash, published, behind } | { ok:false, error }`
- `share:publishApp(dirName, {includeInput})` → runs `publishApp` with title/description read from the manifest; on success `writePublished`; emits `share:progress {dirName, uploaded, total}` during upload; broadcasts `share:changed {dirName}`; returns `{ ok:true, published, unchanged } | { ok:false, error }`
- `share:unpublishApp(dirName)` → `unpublishApp` then `clearPublished`; broadcast
- `share:statusApp(dirName)` → `{ published, behind }` (`behind` uses `published.includeInput ?? true`)
- `share:publishFile(filePath)` / `share:unpublishFile` / `share:statusFile` — `filePath` is absolute; `assertWithinAllowedDirs(filePath, getAllowedPaths())` first; registry key is the workspace-relative posix path
- Every mutation broadcasts `share:changed` with `{dirName}` or `{filePath}`.
- Errors are returned as `{ok:false,error}` with the message from the thrown `Error` — never rethrown across IPC (Electron prefixes rethrown messages with plumbing text; see the `chat:send` note in CLAUDE.md).
```ts
interface ShareAPI {
  getSettings(): Promise<ShareSettingsForUi>;
  saveSettings(patch: { siteUrl: string; apiUrl: string; publishToken?: string; clearToken?: boolean }): Promise<{ ok: boolean; error?: string }>;
  test(): Promise<{ ok: boolean; status: number; error: string | null }>;
  planApp(dirName: string, includeInput: boolean): Promise<{ ok: true; summary: SnapshotSummary; hash: string; published: PublishedInfo | null; behind: boolean } | { ok: false; error: string }>;
  publishApp(dirName: string, opts: { includeInput: boolean }): Promise<{ ok: true; published: PublishedInfo; unchanged: boolean } | { ok: false; error: string }>;
  unpublishApp(dirName: string): Promise<{ ok: boolean; error?: string }>;
  statusApp(dirName: string): Promise<{ published: PublishedInfo | null; behind: boolean }>;
  publishFile(filePath: string): Promise<{ ok: true; published: PublishedInfo; unchanged: boolean } | { ok: false; error: string }>;
  unpublishFile(filePath: string): Promise<{ ok: boolean; error?: string }>;
  statusFile(filePath: string): Promise<{ published: PublishedInfo | null; behind: boolean }>;
  onChanged(cb: (evt: { dirName?: string; filePath?: string }) => void): () => void;
  onProgress(cb: (p: { dirName: string; uploaded: number; total: number }) => void): () => void;
}
```
Split the handler bodies into exported functions that take `deps` so the test can call them without `ipcMain` (mock `electron` as `apiStore.test.ts` does).

**Tests.** `planApp` on M1's fixture returns a summary and `behind:false` when unpublished; `publishApp` with a `FakeShareApi` writes `published` into the manifest and calls `broadcast('share:changed', {dirName})`; `unpublishApp` clears it; `publishFile` with a path outside allowed dirs returns `{ok:false}` and makes no API call; `test()` without configuration returns the not-configured error.

**Acceptance.** tsc clean; full `npm test` green; `npm start -- -- --smoke-test` exits 0.

---

### M10 — Recompute "behind" after a build or a run

**Goal.** The two moments a snapshot changes are a successful build and a finished run. Announce at the write.

**Read first.** `src/cobuilding/main/miniAppBuilder.ts` (`recordBuildResult(dirName, true)` at ~line 96), `setRunCompletedHandler` in `main/index.ts` (~line 998), `recomputeAndBroadcastApp` from M9.

**Modify.** `miniAppBuilder.ts` — add `export function setBuildSucceededHandler(fn: (dirName: string) => void)` and call it after the success `recordBuildResult` (a setter, not an import of `shareHandlers`, to avoid a cycle). `main/index.ts` — register it, and inside the existing `setRunCompletedHandler` callback add `void recomputeAndBroadcastApp(dirName)`.

**Tests.** Extend the existing builder test if one exists (`ls src/cobuilding/main/__tests__ | grep -i build`), else add a small test that the handler fires once on success and not on failure (stub esbuild the way the existing builder tests do it — check first).

**Acceptance.** tsc clean; full `npm test` green.

---

### W1 — Workers scaffold, bucket interface, README

**Goal.** Create the `src/share-workers/` tree so W2–W4 and V1–V2 have somewhere to land, and write the operator's setup guide.

**Read first.** C2, C4, C5, C7; `docs/design/sharing.md` → *Auth* and *Increments → 0*.

**Create.**
```
src/share-workers/README.md
src/share-workers/package.json            (private; devDependencies: wrangler; scripts: build:viewer, deploy:api, deploy:web, dev:api, dev:web)
src/share-workers/shared/bucket.ts        (C7 interfaces)
src/share-workers/shared/memoryBucket.ts  (in-memory BucketLike for tests: get/put/delete/list with prefix + cursor paging at limit)
src/share-workers/shared/__tests__/memoryBucket.test.ts
src/share-workers/api/wrangler.toml       name acabox-share-api; main src/index.ts; [[r2_buckets]] binding BUCKET bucket_name acabox-share
src/share-workers/api/src/index.ts        (export default { fetch } stub returning 501 — W2 fills it)
src/share-workers/web/wrangler.toml       name acabox-share; same bucket; [assets] directory ./public, binding ASSETS, run_worker_first = true; [vars] ACCESS_TEAM_DOMAIN, ACCESS_AUD placeholders
src/share-workers/web/src/index.ts        (stub 501 — W4)
src/share-workers/web/public/.gitkeep
```
**Modify.** `.gitignore` — add `src/share-workers/web/public/viewer.js`, `src/share-workers/web/public/viewer.css` and `src/share-workers/node_modules/`.

**Spec.**
- `compatibility_date` = a date no newer than the wrangler release you pin (wrangler refuses future dates); note this in a comment.
- `build:viewer` script: `../../node_modules/.bin/esbuild web/viewer/viewer.ts --bundle --format=iife --target=es2020 --outfile=web/public/viewer.js && cp web/viewer/viewer.css web/public/viewer.css` (uses the repo's esbuild; nothing new at root).
- README sections, in order: What gets deployed · Prerequisites (free Cloudflare account, `npm install` in this dir) · Create the bucket · Deploy `acabox-share-api` + set `PUBLISH_TOKEN` (`wrangler secret put`) · Deploy `acabox-share` · Zero Trust: add Google as IdP (the Google Cloud OAuth client + the `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` redirect URI) · Access application on the `acabox-share.<acct>.workers.dev` hostname with one Allow policy, *Emails ending in* `@academia.edu` · copy the application's AUD tag and team domain into `[vars]` and redeploy · Paste site URL, API URL and token into Acabox → Settings → Sharing → Test · Local dev with `wrangler dev` and `ACCESS_DISABLED=true`. Flag the **50-seat free limit** in a callout.
- Jest already picks up `src/**/__tests__`, tsc already includes `src/**`. Confirm both by running them.

**Tests.** `memoryBucket.test.ts`: put/get round-trip with content type; `list` by prefix, `limit` paging with `cursor`, `truncated` flag; `delete` of an array; get of a missing key → null.

**Acceptance.** tsc clean; full `npm test` green; `cd src/share-workers && npm install && npx wrangler --version` prints a version.

---

### W2 — `acabox-share-api` Worker

**Goal.** Implement C4 over `BucketLike`.

**Read first.** C1, C2, C4, C7; W1's `memoryBucket.ts`.

**Create.** `src/share-workers/api/src/routes.ts` (all logic, `handleApiRequest(request: Request, env: ApiEnv): Promise<Response>`), `src/share-workers/api/__tests__/routes.test.ts`.
**Modify.** `api/src/index.ts` → `export default { fetch: (req, env) => handleApiRequest(req, env) }`.

**Spec.**
- Bearer check: constant-time compare (equal length + XOR accumulate). Missing/mismatch → 401.
- Route table exactly as C4. `:kind` must be `app|file` else 404. `:id` via `isValidShareId`, `:hash` via `isValidHash` else 400. The `*` tail is decoded per segment then `normalizeSnapshotPath`; null → 400.
- `PUT file`: `bucket.put(versionPrefix(kind,id,hash) + rel, request.body, { httpMetadata: { contentType: request.headers.get('content-type') ?? contentTypeFor(rel) } })`.
- `PUT meta`: parse JSON; require `id`/`kind` equal to URL, `isValidHash(hash)`, non-empty `entry`, array `files`. Write `metaKey`. Then load `index.json` (or empty), upsert the entry by `id`, write it. Then list `<a or f>/<id>/v/` and delete every key whose version segment is not `hash` (page with cursor; delete in batches of at most 1000).
- `DELETE`: list `<a or f>/<id>/` and delete all (paged), remove from index, `200 {ok:true}` even when nothing existed.
- All JSON responses `content-type: application/json; charset=utf-8`.

**Tests** (node env, `MemoryBucket`, `new Request(...)`): 401 without/with wrong bearer; health; put file lands at the exact key with the content type; commit writes meta and index; second commit with a new hash deletes the old version's objects but not the new; delete removes everything for the id and updates the index, and is idempotent; bad id → 400; `..` in tail → 400; meta whose `id` mismatches URL → 400; `kind=bogus` → 404.

---

### W3 — Access JWT verification

**Goal.** Fail-closed verification of Cloudflare Access's `Cf-Access-Jwt-Assertion` using only WebCrypto.

**Read first.** `docs/design/sharing.md` → *Auth*. Cloudflare's JWT has `alg: RS256`, `kid`; JWKS at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (`{ keys: [{ kid, kty:'RSA', n, e, alg }] }`); claims `aud: string[]`, `iss: 'https://<team>.cloudflareaccess.com'`, `exp`, `email`.

**Create.** `src/share-workers/web/src/accessJwt.ts`, `src/share-workers/web/__tests__/accessJwt.test.ts`.

**Spec.**
```ts
export interface Jwks { keys: Array<{ kid: string; kty: string; n: string; e: string; alg?: string }>; }
export type VerifyResult = { ok: true; email: string | null } | { ok: false; reason: string };
export async function verifyAccessJwt(token: string, opts: { jwks: Jwks; aud: string; issuer: string; nowSeconds?: number; subtle?: SubtleCrypto }): Promise<VerifyResult>;
export function extractAccessToken(request: Request): string | null;   // header first, then `CF_Authorization` cookie
export function createJwksCache(fetchImpl: typeof fetch, teamDomain: string, ttlMs?: number /* default 1h */): { get(): Promise<Jwks>; invalidate(): void };
```
- Reject: malformed (not 3 parts), `alg !== 'RS256'`, unknown `kid`, bad signature, `exp <= now`, `iss` mismatch, `aud` not containing `opts.aud`. Each with a distinct `reason`.
- Import keys with `subtle.importKey('jwk', …, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])`.
- base64url decoding without Node's `Buffer` (Workers have none): use `atob` after padding/char replacement.
- If verification fails with unknown `kid`, the caller should `invalidate()` the cache and retry once (document; implement in W4).

**Tests** (node env; `globalThis.crypto.subtle` exists on Node 22 — pass it as `subtle`): generate an RSA-2048 keypair in the test, export the public JWK, sign a token with the private key; assert `ok` with `email`; then one failing case per rejection reason; the cookie fallback in `extractAccessToken`; the cache returns the same object within TTL and refetches after `invalidate()`.

**Note for the orchestrator.** If open decision 1 in `sharing.md` lands on self-rolled Google OAuth instead of Access, this module is what gets replaced; W4's call site stays.

---

### W4 — `acabox-share` web Worker routes + listing page

**Goal.** Implement C5 over `BucketLike` + `AssetsLike`, gated by W3.

**Read first.** C1, C2, C5, C7, W2 (mirror its structure), W3.

**Create.** `src/share-workers/web/src/routes.ts` (`handleWebRequest(request, env, deps?)`), `src/share-workers/web/src/listingPage.ts` (`renderListing(index: ShareIndex): string` — escaped HTML, DM Sans / IBM Plex Mono stacks with system fallbacks, no external assets), `src/share-workers/web/__tests__/routes.test.ts`, `__tests__/listingPage.test.ts`.
**Modify.** `web/src/index.ts` → wire `handleWebRequest` with a module-level JWKS cache.

**Spec.**
- Auth first for every route: `ACCESS_DISABLED === 'true'` skips; else `extractAccessToken` → missing → `401` text "Sign in required"; `verifyAccessJwt`; on unknown-kid failure invalidate the cache and retry once; still failing → `403` with the reason in the body.
- Route table per C5. `:id` and `:hash` validated as in W2. Tail via `normalizeSnapshotPath`; null → 404.
- R2 objects: `new Response(obj.body, { headers })` with `content-type` = `obj.httpMetadata?.contentType ?? contentTypeFor(key)`; versioned → `cache-control: public, max-age=31536000, immutable`; `meta.json` → `no-store`.
- `/f/:id/`: read meta; `302` with `Location: /f/<id>/v/<hash>/<encodeURIComponent(entry)>`; missing meta → 404.
- Static assets: `env.ASSETS.fetch(new Request(new URL('/viewer.html', request.url)))` for `/a/:id/`; `/viewer.js`, `/viewer.css` pass straight through to `ASSETS`; set `cache-control: no-store` on all of them.
- Security headers on HTML responses: `x-content-type-options: nosniff`, `referrer-policy: no-referrer`.
- Listing: title "Shared from Acabox", one row per artifact (kind badge, title, description, published date, link to `/a/<id>/` or `/f/<id>/`), sorted newest first, empty state "Nothing published yet."

**Tests** (node env, `MemoryBucket`, a fake `AssetsLike` that returns a canned body per path, `ACCESS_DISABLED: 'true'` for routing cases, plus one real-JWT case using W3's test helper to prove the gate is wired): every row of C5 including 404s, cache headers, content types, the redirect for `/f/:id/`, `..` refused, unauthenticated → 401 when Access is enabled, listing HTML escapes `<script>` in a title.

---

### V1 — Viewer shim (bridge stand-in), tested against the real bridge

**Goal.** A browser module that answers the C6 protocol for a read-only snapshot, exercised by the **real** `bridge.ts`, not a reimplementation.

**Read first.** C6; `src/cobuilding/skills/manage-mini-application/assets/bridge/bridge.ts` (all of it — it is short); the `readFile` / `readDirectory` handlers in `main/fileHandlers.ts`; `src/cobuilding/main/__tests__/miniAppLinkShim.test.ts` (JSDOM with `runScripts: 'dangerously'`, and the `TextEncoder` workaround at its top); `shared/fileKinds.ts` (S2); `shared/share.ts` (S1).

**Create.** `src/share-workers/web/viewer/shim.ts`, `src/share-workers/web/__tests__/shim.test.ts`.

**Spec.**
```ts
export interface ShimOptions {
  meta: ArtifactMeta;
  base: string;                       // versionedBase('app', id, hash)
  hostWindow: Window;                 // where the bridge posts (the frame's parent)
  frameWindow: () => Window | null;   // where replies go
  fetchImpl?: typeof fetch;
  onRefused?: (call: string) => void; // for the page to show a hint
}
export function installShim(opts: ShimOptions): () => void;   // returns uninstall
export function sendInit(frameWindow: Window): void;          // posts { type:'init', workspacePath: '' }
```
- Listen for `message` on `hostWindow`; ignore events whose `data.type` is `'response'` or lacks `id`. Reply with `{type:'response', id, result}` or `{…, error}` via `frameWindow().postMessage(reply, '*')`.
- Path resolution: `normalizeSnapshotPath(args.path)` → look up `meta.files` by `path === 'w/' + rel`. URL = `${base}/${rel}`.
- `readFile`: not found → `error: 'File not found: <path>'`. Otherwise by `classifyForBridge(rel)`: image/pdf → `{type, fileUrl: url}`; spreadsheet → fetch `arrayBuffer` → base64 (no `Buffer`) → `{type:'spreadsheet', base64, ext}`; markdown/csv/text → fetch text → shapes per C6 (`csv` includes `delimiter` via `csvDelimiterFor`).
- `readDirectory`: entries whose path starts with `w/<rel>/` at depth one; directories inferred from deeper paths; `{ name, path: '/' + rel + '/' + name, isDirectory }`; sort dirs first then `localeCompare`. Unknown dir → `error: 'Directory not found: <path>'`.
- `downloadFile`: create a Blob + anchor click → `result: { ok: true }`.
- `openExternal`: `hostWindow.open(url, '_blank', 'noopener')` → `{ ok: true }`.
- `jobs:listForApp`, `mcp:listServers` → `result: []`.
- `anthropic:stream` → post `{ type:'anthropic:error', requestId: id, error: SHARE_REFUSAL_MESSAGE }`.
- Every other call → `error: SHARE_REFUSAL_MESSAGE` and `onRefused(type)`.

**Tests** (node env + JSDOM as in the link-shim test). Setup: bundle the real bridge once with esbuild (`require('esbuild').buildSync({ entryPoints:[bridgePath], bundle:true, write:false, format:'iife' })`) and `eval` it in a JSDOM window; since a top-level window's `parent` is itself, install the shim with `hostWindow = frameWindow = dom.window`; provide a `fetchImpl` that serves a small in-memory snapshot. Then drive `dom.window.filesAPI` / `kernel` / `hostAPI` / `anthropicAPI` **through the bridge** and await the promises. Cases: `readFile` of a json → `{type:'text', content}`; csv → delimiter; png → `fileUrl` equals `${base}/…`; xlsx → base64 round-trips to the bytes served; missing → rejects with the not-found message; `readDirectory` of `output` lists files and a subdir, sorted; `./`-prefixed and `/`-prefixed paths resolve to the same file; `..` → not found; `kernel.executeCode` rejects with `SHARE_REFUSAL_MESSAGE` and `onRefused('executeCode')` fired; `hostAPI.exec` rejects likewise; `anthropicAPI.stream` rejects (the stream path); `jobs:listForApp` via a raw postMessage → `[]`; uninstall stops replies.

---

### V2 — Viewer page (banner, iframe, states)

**Goal.** The page a viewer lands on at `/a/<id>/`.

**Read first.** V1; C5; `src/cobuilding/renderer/commandDesk.css` (the `--cd-*` tokens — copy the handful you use into `viewer.css`, do not import the file).

**Create.** `src/share-workers/web/viewer/viewer.ts`, `src/share-workers/web/viewer/viewer.css`, `src/share-workers/web/public/viewer.html`, `src/share-workers/web/__tests__/viewer.test.ts`.

**Spec.**
- `viewer.html`: minimal shell; `<link href="/viewer.css">`, `<script src="/viewer.js">`, a `<header id="banner">` and `<main id="frame-host">`.
- `viewer.ts` on load: parse `id` from `location.pathname` (`/a/<id>/`); fetch `/a/<id>/meta.json` (`cache: 'no-store'`); on 404 render the state *"This link has been unpublished."*; on other failure *"Could not load this shared tool."* with a Retry button. On success: banner = `<title> · Shared from Acabox · read-only snapshot · published <local date>` with a link "All shared" → `/`; create `<iframe sandbox="allow-scripts allow-same-origin allow-downloads" src="${base}/${meta.entry}">`; `installShim({ meta, base, hostWindow: window, frameWindow: () => iframe.contentWindow, onRefused })`; on iframe `load` → `sendInit(iframe.contentWindow)`; `onRefused` shows a one-line hint under the banner once ("This tool tried to run something; shared copies are read-only.").
- Export `mountViewer(root: Document, opts: { fetchImpl?: typeof fetch; location?: { pathname: string } })` so the test can drive it; the auto-mount runs only when `typeof window !== 'undefined' && !window.__ACABOX_VIEWER_TEST__`.
- No external fonts or scripts; system font fallbacks.

**Tests** (JSDOM): unpublished → the exact message; success → banner text contains the title and the iframe `src` equals `${base}/${entry}`; a refused call sets the hint once, not twice.

**Acceptance.** `npm run build:viewer` in `src/share-workers` produces `public/viewer.js` and `public/viewer.css`; tsc clean; tests green.

---

### U1 — Renderer share store + hook

**Goal.** One place in the renderer that knows each tool's share status and re-reads on `share:changed`.

**Read first.** `src/cobuilding/renderer/toolStatusStore.ts` (the `useSyncExternalStore` pattern and its test), M9's `ShareAPI`.

**Create.** `src/cobuilding/renderer/shareStore.ts`, `src/cobuilding/renderer/__tests__/shareStore.test.tsx`.

**Spec.**
```ts
export interface ToolShareState { published: PublishedInfo | null; behind: boolean; loading: boolean; }
export function useToolShare(dirName: string): ToolShareState;     // fetches statusApp on first use; refetches on share:changed for that dirName
export function useFileShare(filePath: string | null): ToolShareState;
export function refreshToolShare(dirName: string): Promise<void>;
export function __resetShareStoreForTests(): void;
```
- Subscribe once (lazily) to `window.shareAPI.onChanged`; an event with `dirName` refetches that tool; with `filePath` refetches that file.
- No polling.

**Tests.** Render a component using `useToolShare` with a mocked `window.shareAPI`; initial `loading:true` then the fetched state; firing the captured `onChanged` callback with the dirName triggers exactly one more `statusApp` call; a different dirName triggers none.

---

### U2 — Settings → Sharing

**Goal.** Enter site URL, API URL, token; Save; Test.

**Read first.** `src/cobuilding/renderer/components/ApiSettings.tsx` + `.css` (form field classes `connectorField*`, save/test flow, `applyResult`), `DirectoryPermissions.tsx` ~lines 330–345 (where sections mount).

**Create.** `src/cobuilding/renderer/components/SharingSettings.tsx`, `SharingSettings.css`, `__tests__/SharingSettings.test.tsx`.
**Modify.** `DirectoryPermissions.tsx` — a new `<section className="wsSettings__section">` labelled **Sharing** between *APIs* and *Account*.

**Spec.**
- Fields: Site URL, API URL (both `connectorField__input connectorField__input--mono`), Publish token (`type="password"`, placeholder of eight dots when `hasToken`, help text "Leave blank to keep the stored token"), a *Clear token* link when `hasToken`.
- Buttons: **Save** (disabled until dirty; shows the validator's error inline on `{ok:false}`), **Test** (disabled until `hasToken` and both URLs saved; shows `Connected` / `HTTP <status>: <error>` on its own line).
- Help paragraph: one sentence pointing at `src/share-workers/README.md` for setup. Mention the 50-seat limit in one clause.
- Never render the token value; the UI only knows `hasToken`.

**Tests.** Renders from a mocked `getSettings`; Save disabled until edit; Save sends `{siteUrl, apiUrl, publishToken}` and omits `publishToken` when the field is blank; Clear token sends `clearToken:true`; Test renders the returned error.

**Screenshot needed:** yes — Settings page with the new section (shared input classes tie on specificity; see CLAUDE.md's scheduler lesson).

---

### U3 — Publish dialog

**Goal.** The confirm-and-progress modal used by both the Tools page and the tool header.

**Read first.** The `toolsConfirmModal*` / `toolsConfirmOverlay` markup in `ToolsPage.tsx` (search `confirmDelete && (`); `SnapshotSummary` (C1); M9's `planApp` / `publishApp` / `onProgress`.

**Create.** `src/cobuilding/renderer/components/share/SharePublishDialog.tsx`, `share/SharePublishDialog.css`, `share/__tests__/SharePublishDialog.test.tsx`, `share/formatBytes.ts` (search the renderer for an existing `formatBytes` first and reuse it if found).

**Spec.**
```ts
export interface SharePublishDialogProps { dirName: string; appName: string; onClose(): void; }
```
- On open: `planApp(dirName, includeInput)` with `includeInput` defaulting to `published?.includeInput ?? true`. Show a table: Code · Output · Input · Vendor · Total, each `N files · X MB`. A checkbox *Include input data* re-runs `planApp`.
- Title: **Publish "<name>"** when unpublished, **Refresh shared copy** when published and behind, **Shared copy is up to date** when published and not behind (button disabled, shows Copy link / Open / Unpublish instead).
- Primary button runs `publishApp`; while running show `Uploading N of M files…` from `onProgress`; on success show the URL in a mono field with **Copy link** (`navigator.clipboard.writeText`) and **Open** (`window.electronAPI.invoke('shell:openExternal', url)` — the same call `MiniAppViewer.tsx` uses for `openExternal`); on `{ok:false}` show the error inline and keep the dialog open.
- **Unpublish** asks for a second click ("Unpublish — are you sure?") then calls `unpublishApp`.
- A footnote: "Viewers need an @academia.edu Google account. Everything in the table is uploaded."

**Tests.** Plan renders the five rows with formatted sizes; toggling the checkbox re-plans with `includeInput:false`; publish shows progress then the link; error path; unpublish requires two clicks.

**Screenshot needed:** yes.

---

### U4 — Tools page: sharing block

**Read first.** `ToolsPage.tsx` settings panel (`toolRow__settingsPanel`, `toolRow__settingsActions`, the Archive/Delete buttons), U1, U3.

**Modify.** `ToolsPage.tsx` (+ its CSS file if classes are needed), `__tests__/ToolsPage*.test.tsx`.

**Spec.** Inside the settings panel, above `toolRow__settingsActions`, a `toolRow__sharing` block:
- Line 1 (mono label): `NOT SHARED` · `SHARED · UP TO DATE` · `SHARED · BEHIND` from `useToolShare(app.dirName)`; nothing while `loading`.
- Buttons: **Publish…** (unpublished) / **Refresh…** (behind) / **Copy link** + **Open** (published) / **Unpublish** (published) — all open or act through U3 (Unpublish opens the dialog in its unpublish state).
- On the row itself (not only in the panel) a small `cdStatusChip` reading `SHARED` or `SHARED · BEHIND` when published, so the state is visible without opening Settings. Idle/unpublished renders nothing (no-mocks rule).

**Tests.** With `statusApp` mocked to published+behind: the chip reads `SHARED · BEHIND` and the block shows Refresh…; unpublished: no chip, Publish… present.

**Screenshot needed:** yes — a row expanded, both states.

---

### U5 — Tool header: SHARED chip + share button

**Read first.** `MiniAppViewer.tsx` `cdToolHeader` (~lines 388–470: the `cdStatusChip` markup and the right-side `cdIconBtn` buttons), U1, U3.

**Modify.** `MiniAppViewer.tsx`, its test file.

**Spec.** After the existing status chips: `<span className="cdStatusChip">SHARED</span>` / `SHARED · BEHIND` (with a `cdDot cdDot--busy` for behind) when published. Among the right-side icon buttons: an `MSymbol name="share"` button titled "Share…" that opens `SharePublishDialog`. No chip when unpublished.

**Tests.** Published+behind → chip text; click share → dialog rendered (assert its title).

**Screenshot needed:** yes.

---

### U6 — Files tab: Share / Copy link / Unpublish

**Read first.** `FilesTab.tsx` context menu JSX (`fileTreeContextMenu`, ~line 600), `TreeNode` (absolute `path`), M9's file IPCs, U1's `useFileShare`.

**Modify.** `FilesTab.tsx`, `__tests__/FilesTab.test.tsx`.

**Spec.** For a non-directory node, after *Show in Finder*: **Share…** when unpublished (calls `publishFile(path)`; on success shows a small inline toast with **Copy link**; on `{ok:false}` shows the error the same way); when published: **Copy link**, **Refresh shared copy** (only when behind; same call), **Unpublish** (destructive style). Status comes from `statusFile(path)` fetched when the menu opens — the menu shows *Share…* alone until it returns (no guessing).

**Tests.** Menu on an unpublished file shows Share… only; on a published+behind file shows Copy link / Refresh / Unpublish; Share… calls `publishFile` with the node path.

---

### D1 — `hostAPI.fileUrl()` + SKILL.md guidance

**Goal.** Stop new apps from hardcoding `local-file://` (M2 keeps covering old ones).

**Read first.** `assets/bridge/bridge.ts` (`_workspacePath`, `getWorkspacePath`), `SKILL.md` ~672–693, `bridge-api.md` ~146, the two templates' `App.tsx` uses.

**Modify.** `bridge.ts` — add `fileUrl(relPath: string): string` on `hostAPI` returning `` `local-file://${_workspacePath}/${rel}` `` with a leading `./` stripped, and, when `_workspacePath === ''`, just `/${rel}` — which is what the shared viewer needs. `SKILL.md` + `bridge-api.md` — replace the hand-built template with `hostAPI.fileUrl(...)` and say why. Update the two templates.

**Tests.** `bridge.ts` is outside the tsc project; extend the existing real-bridge JSDOM test (find it via `grep -rl "hostAPI === containerAPI" src`) with: after `init` with `/ws`, `fileUrl('./.applications/x/output/p.png')` → `local-file:///ws/.applications/x/output/p.png`; after `init` with `''` → `/.applications/x/output/p.png`.

---

### X1 — End-to-end verification (orchestrator, manual)

Not a Sonnet ticket. After U-tickets land and W-workers are deployed:
real publish of a real tool → incognito browser → Google login with an `@academia.edu` account → app renders with images → local rebuild → `SHARED · BEHIND` → Refresh → browser refresh shows the change → Unpublish → 404 page → non-academia account refused → api Worker refuses without token → shim refusal hint appears when a Run button is clicked. Record results in `docs/design/sharing.md`'s header and CLAUDE.md Status.
