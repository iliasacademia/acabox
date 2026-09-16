/**
 * Viewer shim — a browser-side stand-in for the Acabox host bridge, answering
 * the same wire protocol (`assets/bridge/bridge.ts`, contract C6 in
 * `docs/design/sharing-tickets.md`) for a published, read-only snapshot.
 *
 * A shared tool's `index.html` loads the SAME bundled `bridge.ts` a live
 * mini-app loads — nothing about the app changes. What changes is what sits
 * on the other end of `window.parent.postMessage`: instead of Acabox's main
 * process there is this module, running in the viewer page (`viewer.ts`,
 * V2) that hosts the app in an iframe. It can only ever answer with what a
 * static snapshot already contains — there is no filesystem, no kernel, no
 * child process, nothing "live" — so every call the bridge exposes for doing
 * work refuses with `SHARE_REFUSAL_MESSAGE`; only reads that the snapshot can
 * satisfy are actually served.
 *
 * BROWSER-ONLY MODULE. No Node imports, no `Buffer` — this ships to a
 * Cloudflare Worker's static assets and runs in an arbitrary visitor's
 * browser. Binary data crosses the `fetch` boundary as an `ArrayBuffer` and is
 * base64-encoded with `btoa` over a binary string, exactly as the ticket
 * requires.
 *
 * File-kind classification and CSV delimiter selection come from
 * `shared/fileKinds.ts` — the same module `main/fileHandlers.ts`'s real
 * `files:readFile` handler uses — so a shared snapshot presents each file
 * exactly the way the live app would have.
 */

import { normalizeSnapshotPath, SHARE_REFUSAL_MESSAGE, type ArtifactMeta, type SnapshotFile } from '../../../cobuilding/shared/share';
import { classifyForBridge, csvDelimiterFor } from '../../../cobuilding/shared/fileKinds';

export interface ShimOptions {
  meta: ArtifactMeta;
  /** `versionedBase('app', id, hash)`, e.g. `/a/<id>/v/<hash>/w`. */
  base: string;
  /** Where the bridge posts — the frame's `parent`, i.e. this viewer window. */
  hostWindow: Window;
  /** Where replies go. A function, not a value, because an iframe can be torn
   * down and recreated; re-reading it on every reply avoids posting into a
   * detached window. */
  frameWindow: () => Window | null;
  fetchImpl?: typeof fetch;
  /** Called once per refused call, so the viewer page can show a hint. */
  onRefused?: (call: string) => void;
}

/** Shape of a bridge request, per C6: `{ type, id, ...args }`. */
interface BridgeRequestMessage {
  type: string;
  id?: unknown;
  [key: string]: unknown;
}

type DispatchOutcome = { result: unknown } | { error: string };

/**
 * Mirrors `path.extname(resolved).slice(1).toLowerCase()` from
 * `main/fileHandlers.ts`, without importing `path` (this module must stay
 * Node-free). Kept local rather than exported from `shared/fileKinds.ts`
 * because it is an implementation detail of "what extension does this path
 * have", not a fact about file *kinds* the way `classifyForBridge` is.
 */
function extensionOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Installs the shim's `message` listener on `hostWindow` and returns a
 * function that removes it.
 */
export function installShim(opts: ShimOptions): () => void {
  const { meta, base, hostWindow, frameWindow, onRefused } = opts;
  const doFetch: typeof fetch = opts.fetchImpl ?? (hostWindow.fetch.bind(hostWindow) as typeof fetch);

  /** `btoa` over a binary string — no `Buffer` allowed in this module. */
  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return hostWindow.btoa(binary);
  }

  /**
   * Resolves a bridge-supplied path (workspace-relative, e.g.
   * `.applications/x/output/a.json`) to its `SnapshotFile` entry.
   * `meta.files[i].path` is `w/<rel>` (C1) — `rel` is what both `readFile`
   * and `readDirectory` need for classification and URL-building.
   * Throws with the exact not-found wording the ticket specifies, using the
   * caller's original (un-normalized) path — that's what the user/tool typed
   * and what they'd recognize in an error.
   */
  function resolveFile(rawPath: string): { file: SnapshotFile; rel: string } {
    const rel = normalizeSnapshotPath(rawPath);
    if (rel !== null) {
      const snapshotPath = `w/${rel}`;
      const file = meta.files.find((f) => f.path === snapshotPath);
      if (file) return { file, rel };
    }
    throw new Error(`File not found: ${rawPath}`);
  }

  async function handleReadFile(rawPath: string): Promise<unknown> {
    const { rel } = resolveFile(rawPath);
    const kind = classifyForBridge(rel);
    const url = `${base}/${rel}`;

    // Images and PDFs are handed to the frame as URLs it loads itself (an
    // <img>/<iframe> src) — mirrors `files:readFile`'s local-file:// shape,
    // just with the versioned snapshot URL instead.
    if (kind === 'image' || kind === 'pdf') {
      return { type: kind, fileUrl: url };
    }

    const res = await doFetch(url);
    if (!res.ok) {
      // The meta's file list and the bucket can only disagree if a publish
      // was interrupted mid-upload; treat that identically to "never
      // existed" rather than surfacing a confusing transport error.
      throw new Error(`File not found: ${rawPath}`);
    }

    if (kind === 'spreadsheet') {
      const buffer = await res.arrayBuffer();
      return { type: 'spreadsheet', base64: arrayBufferToBase64(buffer), ext: extensionOf(rel) };
    }

    const content = await res.text();
    if (kind === 'markdown') {
      return { type: 'markdown', content };
    }
    if (kind === 'csv') {
      return { type: 'csv', content, delimiter: csvDelimiterFor(rel) };
    }
    return { type: 'text', content };
  }

  /**
   * Depth-one directory listing derived from the flat `meta.files` list —
   * there are no directory objects in a snapshot, only files, so a
   * directory's existence and its immediate children are both inferred from
   * path prefixes.
   */
  function handleReadDirectory(rawPath: string): Array<{ name: string; path: string; isDirectory: boolean }> {
    const rel = normalizeSnapshotPath(rawPath);
    if (rel === null) {
      throw new Error(`Directory not found: ${rawPath}`);
    }
    const prefix = `w/${rel}/`;
    const entryIsDir = new Map<string, boolean>();

    for (const file of meta.files) {
      if (!file.path.startsWith(prefix)) continue;
      const remainder = file.path.slice(prefix.length);
      if (remainder === '') continue;
      const slashIndex = remainder.indexOf('/');
      if (slashIndex === -1) {
        // A leaf file at this depth. Don't downgrade an entry a deeper file
        // already proved is a directory — order of `meta.files` isn't
        // guaranteed, so this must be order-independent in both directions.
        if (!entryIsDir.has(remainder)) entryIsDir.set(remainder, false);
      } else {
        entryIsDir.set(remainder.slice(0, slashIndex), true);
      }
    }

    if (entryIsDir.size === 0) {
      throw new Error(`Directory not found: ${rawPath}`);
    }

    const entries = Array.from(entryIsDir.entries()).map(([name, isDirectory]) => ({
      name,
      path: `/${rel}/${name}`,
      isDirectory,
    }));
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  function handleDownloadFile(filename: string, content: string): { ok: true } {
    // `Blob`/`URL` are ambient globals, not members of the `Window` interface
    // (TypeScript's `lib.dom` declares them as top-level `declare var`s) —
    // using them unqualified is correct even though every other browser
    // primitive here goes through the explicit `hostWindow`.
    const blob = new Blob([content]);
    const url = URL.createObjectURL(blob);
    const anchor = hostWindow.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    hostWindow.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return { ok: true };
  }

  function handleOpenExternal(url: string): { ok: true } {
    hostWindow.open(url, '_blank', 'noopener');
    return { ok: true };
  }

  /**
   * Calls that are still REFUSED, but must not raise the viewer's hint.
   *
   * The hint reads "This tool tried to run something", and for these it would
   * be false. `useAppState` — which most scaffolded tools use — debounce-saves
   * the notebook whenever state changes after hydration, so it writes on load
   * without anyone touching the page. Firing the hint there tells every
   * visitor of every such tool that it tried to run, before they have clicked
   * anything.
   *
   * These are refused rather than faked: answering `{ok:true}` would let an
   * app report "Saved" for a write that went nowhere. The banner already
   * states, permanently, that this is a read-only snapshot, so suppressing the
   * hint loses the viewer nothing — while a user-initiated write still fails
   * visibly through the app's own error handling.
   */
  const SILENT_REFUSALS = new Set(['writeFile']);

  async function dispatch(msg: BridgeRequestMessage): Promise<DispatchOutcome> {
    switch (msg.type) {
      case 'readFile':
        return { result: await handleReadFile(typeof msg.path === 'string' ? msg.path : '') };
      case 'readDirectory':
        return { result: handleReadDirectory(typeof msg.path === 'string' ? msg.path : '') };
      case 'downloadFile':
        return {
          result: handleDownloadFile(
            typeof msg.filename === 'string' ? msg.filename : '',
            typeof msg.content === 'string' ? msg.content : '',
          ),
        };
      case 'openExternal':
        return { result: handleOpenExternal(typeof msg.url === 'string' ? msg.url : '') };
      case 'jobs:listForApp':
      case 'mcp:listServers':
        return { result: [] };
      default:
        if (!SILENT_REFUSALS.has(msg.type)) onRefused?.(msg.type);
        return { error: SHARE_REFUSAL_MESSAGE };
    }
  }

  async function onMessage(event: MessageEvent): Promise<void> {
    const data = event.data as BridgeRequestMessage | null | undefined;
    if (!data || typeof data !== 'object') return;
    // The bridge's own `response` messages (its resolution of a PRIOR call)
    // and internal streaming events (`anthropic:chunk`/`done`/`error`, and
    // our own outgoing `anthropic:error` below) carry no `id` — both must be
    // ignored, or this listener would treat its own replies as new requests.
    if (data.type === 'response') return;
    if (data.id === undefined || data.id === null) return;

    const frame = frameWindow();
    if (!frame) return;

    if (data.type === 'anthropic:stream') {
      // Streaming is keyed on `requestId`, not `id`, and refused with its own
      // message shape (C6) rather than the generic `{type:'response', ...}`.
      frame.postMessage({ type: 'anthropic:error', requestId: data.id, error: SHARE_REFUSAL_MESSAGE }, '*');
      return;
    }

    let reply: Record<string, unknown>;
    try {
      const outcome = await dispatch(data);
      reply = 'error' in outcome
        ? { type: 'response', id: data.id, error: outcome.error }
        : { type: 'response', id: data.id, result: outcome.result };
    } catch (err) {
      reply = { type: 'response', id: data.id, error: err instanceof Error ? err.message : String(err) };
    }
    frame.postMessage(reply, '*');
  }

  const listener = (event: Event): void => {
    void onMessage(event as MessageEvent);
  };
  hostWindow.addEventListener('message', listener);
  return () => hostWindow.removeEventListener('message', listener);
}

/**
 * Posts the one `init` message the shared viewer sends. `workspacePath` is
 * always the empty string: unlike the live app, a snapshot has no absolute
 * filesystem path to hand over, and the bundled code that would have used it
 * (`local-file://${workspacePath}/...` template literals) was already
 * rewritten at publish time to the versioned base URL — see
 * `main/share/rewriteLocalFileUrls.ts`. Nothing left in a published bundle
 * needs this value to be non-empty.
 */
export function sendInit(frameWindow: Window): void {
  // `readOnly: true` is what lets a well-behaved app skip persistence it can
  // never complete. The live host does not send this field, so an app that
  // checks it behaves normally in Acabox and quietly stops trying to save
  // here. Apps bundled before this field existed simply ignore it and still
  // get a refusal — see SILENT_REFUSALS.
  frameWindow.postMessage({ type: 'init', workspacePath: '', readOnly: true }, '*');
}
