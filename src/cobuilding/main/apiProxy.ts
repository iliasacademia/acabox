/**
 * The API proxy — a loopback HTTP server that holds the credentials so the
 * agent never does.
 *
 * THE ONE RULE THAT SHAPES THIS FILE: `performApiRequest()` is the only code in
 * Acabox that ever sees a decrypted API secret, and every caller reaches it
 * through a "door" that establishes caller identity. Policy is written once.
 *
 *   agent Bash / Python / notebook ──HTTP──> loopback server ─┐
 *                                                             ├─> performApiRequest()
 *   mini-app iframe ──postMessage──> MiniAppViewer ──IPC──────┘        │
 *                                                          (Phase 2)   ├─ host allowlist
 *                                                                      ├─ write gate
 *                                                                      ├─ inject auth
 *                                                                      ├─ manual redirects
 *                                                                      └─ audit
 *
 * WHY REDIRECTS ARE FOLLOWED BY HAND. Measured on Electron 37's Node 22.17,
 * with two local servers and a cross-origin 302:
 *
 *   header           cross-origin 302     same-origin 302
 *   Authorization    STRIPPED             kept
 *   Cookie           STRIPPED             kept
 *   x-api-key        SURVIVES, in full    kept
 *
 * undici protects the headers it recognises as credentials and has no idea
 * `x-api-key` is one. An API configured with `style: 'header'` that 302s to an
 * attacker-influenced host would hand over the key. `redirect: 'manual'` plus
 * the loop below is therefore load-bearing, not belt-and-braces.
 *
 * Design: `docs/design/api-tokens.md`.
 */
import * as http from 'http';
import { Readable } from 'stream';
import { randomUUID, timingSafeEqual } from 'crypto';
import log from 'electron-log';
import {
  API_PROXY_TOKEN_HEADER,
  READ_ONLY_METHODS,
  type ApiConfig,
  basicCredential,
  hostIsAllowed,
  effectiveAllowedHosts,
  redactUrlForLog,
  resolveTargetUrl,
} from '../shared/apis';
import { findFreePort, LOOPBACK } from './freePort';
import { getApiWithSecret, listApisWithSecrets, recordApiCall } from './apiStore';

/** Own port range. 23200-23299 is the agent server, 23400-23499 the kernel. */
const PORT_RANGE_START = 23500;
const PORT_RANGE_END = 23599;

/** Redirect hops before we give up. Each one re-runs the full policy check. */
const MAX_REDIRECTS = 5;

/**
 * Request bodies are buffered, unlike responses.
 *
 * A manual redirect loop has to be able to REPLAY the body on a 307/308, and a
 * consumed stream cannot be replayed. Buffering also bounds what a runaway
 * agent can make the main process hold. The cap is generous enough for a real
 * dataset deposit and small enough not to be a memory DoS; the direction that
 * actually justified this architecture — a large response going to disk — is
 * streamed and uncapped.
 */
const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;

/** Headers a caller may never set: hop-by-hop, or identity we control. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  // Set by the door from trusted state. An agent must not be able to claim a
  // different caller identity, or to forge the proxy token onward.
  'x-acabox-caller', API_PROXY_TOKEN_HEADER,
  // The read-only gate (step 3) assumes GET and HEAD do not mutate. That is a
  // CONVENTION, not a guarantee: a number of REST frameworks honour these
  // headers to reinterpret the method server-side, which would turn an
  // allowed GET into a DELETE on the far end and walk straight through the
  // gate. Cheaper to refuse them than to audit 16 vendors for the behaviour.
  'x-http-method-override', 'x-method-override', 'x-http-method',
]);

/**
 * Time to RESPONSE HEADERS, across all redirect hops. Not a cap on the
 * download.
 *
 * Every other subprocess-ish path here has one (exec 600s, MCP registry 60s,
 * connector reload 15s); without it a hung upstream holds the agent's turn open
 * forever with no diagnosis. It is deliberately a header deadline rather than a
 * whole-request timeout, because a multi-gigabyte dataset landing on disk is
 * the case that justified a proxy over an MCP tool and must never be cut off
 * mid-stream. See the abort wiring in performApiRequest.
 */
const RESPONSE_HEADERS_TIMEOUT_MS = 30_000;

/**
 * Response headers we must NOT forward verbatim.
 *
 * `fetch` has already decompressed the body, so forwarding `content-encoding:
 * gzip` makes the client gunzip plaintext, and `content-length` no longer
 * describes what we are about to write.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
]);

export type ApiCaller =
  | { kind: 'chat' }
  /** Phase 2. Kept here so the grant check is written once, not bolted on. */
  | { kind: 'miniapp'; dirName: string; grantedApis: string[] };

/**
 * A caller's IDENTITY, without its grants.
 *
 * Separate from `ApiCaller` on purpose: identity is fixed for the life of a
 * token, grants are read fresh on every request. Conflating them is how a
 * revoked grant keeps working until restart.
 */
export type ProxyCallerRef =
  | { kind: 'chat' }
  | { kind: 'miniapp'; dirName: string };

function callerKey(caller: ProxyCallerRef): string {
  return caller.kind === 'chat' ? 'chat' : `miniapp:${caller.dirName}`;
}

/**
 * How the proxy learns a tool's granted APIs.
 *
 * Injected rather than imported so this file stays free of workspace and
 * manifest knowledge — the policy engine should not need to know what a
 * `.applications/<dir>/manifest.json` is. Registered once at boot from
 * `main/index.ts`, which owns the workspace path.
 *
 * The default returns NO grants, which is the safe read: before registration,
 * or if it is ever forgotten, a mini-app is refused rather than waved through.
 */
export type ToolGrantResolver = (dirName: string) => string[];

let toolGrantResolver: ToolGrantResolver = () => [];

export function setToolGrantResolver(resolver: ToolGrantResolver): void {
  toolGrantResolver = resolver;
}

/** Attach the current grants to a bare identity. */
export function callerWithGrants(ref: ProxyCallerRef): ApiCaller {
  if (ref.kind === 'chat') return { kind: 'chat' };
  return { kind: 'miniapp', dirName: ref.dirName, grantedApis: toolGrantResolver(ref.dirName) };
}

/**
 * A request body as bytes.
 *
 * Explicitly `Uint8Array<ArrayBuffer>`, not `Buffer` or a bare `Uint8Array`:
 * TypeScript 5.9's `BufferSource` is `ArrayBufferView<ArrayBuffer> |
 * ArrayBuffer`, so a `Uint8Array<ArrayBufferLike>` — which is what
 * `Buffer.concat` yields — is not assignable to `fetch`'s `BodyInit`. Getting
 * the type right here beats casting it away at the call site.
 */
export type ApiRequestBody = Uint8Array<ArrayBuffer>;

export interface ApiRequestInput {
  apiId: string;
  method: string;
  /** Path + query relative to baseUrl. An absolute URL is checked, not trusted. */
  path: string;
  headers?: Record<string, string>;
  /** Buffered, not streamed — see MAX_REQUEST_BODY_BYTES. */
  body?: ApiRequestBody | null;
  /** Set by the door, NEVER by the caller. */
  caller: ApiCaller;
}

export interface ApiRequestOutcome {
  status: number;
  headers: Record<string, string>;
  /** Present on success — the upstream body, unread. */
  body: ReadableStream<Uint8Array> | null;
  /** Present when the proxy itself refused; body is null. */
  error?: string;
}

function refuse(apiId: string, status: number, error: string): ApiRequestOutcome {
  recordApiCall(apiId, { refused: true, status });
  // Refusals are the MOST interesting entries in an audit trail, and they were
  // invisible in the first cut: the success path logged and this one only bumped
  // an in-memory counter that dies with the app. Found by running a real turn
  // and noticing the 405 the agent reported had no counterpart in the log.
  //
  // Safe to log verbatim: every refusal message is built from an id, a
  // hostname, a method or a pathname — never a query string, which is the one
  // place a `query`-auth credential lives.
  log.warn(`[APIs] REFUSED ${apiId} → ${status}: ${error}`);
  return { status, headers: { 'content-type': 'application/json' }, body: null, error };
}

/** Same scheme + host + port, i.e. undici's own credential boundary. */
function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Apply the API's credential to an outbound request.
 *
 * Caller-supplied headers are merged FIRST and the injected value wins, so a
 * caller cannot displace the credential with its own — that is the property
 * that makes a Phase-2 mini-app grant meaningful.
 */
function injectAuth(
  api: ApiConfig,
  url: URL,
  headers: Record<string, string>,
): { url: URL; headers: Record<string, string> } {
  const secret = api.auth.secret;
  if (!secret) return { url, headers };

  const out = { ...headers };
  const outUrl = new URL(url.toString());

  switch (api.auth.style) {
    case 'bearer':
      if (out.authorization !== undefined) {
        log.warn(`[APIs] "${api.id}": dropped a caller-supplied Authorization header.`);
      }
      out.authorization = `Bearer ${secret}`;
      break;
    case 'header': {
      const name = (api.auth.headerName ?? '').toLowerCase();
      if (name) {
        if (out[name] !== undefined) {
          log.warn(`[APIs] "${api.id}": dropped a caller-supplied ${name} header.`);
        }
        out[name] = secret;
      }
      break;
    }
    case 'query':
      if (api.auth.queryParam) outUrl.searchParams.set(api.auth.queryParam, secret);
      break;
    case 'basic': {
      if (out.authorization !== undefined) {
        log.warn(`[APIs] "${api.id}": dropped a caller-supplied Authorization header.`);
      }
      // `basicCredential` decides between `user:secret` and the
      // key-as-username `secret:` convention — see its comment. Base64 of the
      // raw bytes: a non-ASCII password must not be mangled by latin1.
      out.authorization = `Basic ${Buffer.from(basicCredential(api.auth), 'utf-8').toString('base64')}`;
      break;
    }
    default:
      break;
  }
  return { url: outUrl, headers: out };
}

function sanitizeRequestHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = k.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(key)) continue;
    if (key.startsWith('x-acabox-')) continue;
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/**
 * The policy engine. Every refusal message is written for the AGENT to act on
 * in one turn — naming the exact host that was blocked, or the exact setting
 * that has to change — rather than for a human reading a log later.
 */
export async function performApiRequest(input: ApiRequestInput): Promise<ApiRequestOutcome> {
  const started = Date.now();

  // 1 — lookup + enabled.
  const api = getApiWithSecret(input.apiId);
  if (!api || !api.enabled) {
    const available = listApisWithSecrets().filter((a) => a.enabled).map((a) => a.id);
    return refuse(input.apiId, 404,
      `No enabled API named "${input.apiId}". Configured and enabled: `
      + `${available.length ? available.join(', ') : '(none)'}.`);
  }

  // 2 — grant (Phase 2). The chat agent skips this; a mini-app must have been
  // granted this specific API by the user.
  if (input.caller.kind === 'miniapp' && !input.caller.grantedApis.includes(api.id)) {
    return refuse(api.id, 403,
      `The tool "${input.caller.dirName}" has not been granted access to the `
      + `"${api.id}" API. Grant it in the tool's settings.`);
  }

  // 3 — write gate.
  const method = (input.method || 'GET').toUpperCase();
  if (!api.allowWrites && !READ_ONLY_METHODS.includes(method)) {
    return refuse(api.id, 405,
      `"${api.id}" is read-only, so ${method} is refused. Ask the user to enable `
      + `writes for it in Settings → APIs if this is intended.`);
  }

  // 4 — resolve + host allowlist.
  const resolution = resolveTargetUrl(api, input.path);
  if (!resolution.ok) return refuse(api.id, 403, resolution.error);

  const callerHeaders = sanitizeRequestHeaders(input.headers);
  const allowed = effectiveAllowedHosts(api);
  const origin = resolution.url;

  let currentUrl = origin;
  let currentMethod = method;
  let currentBody: ApiRequestBody | null = input.body ?? null;
  let hops = 0;

  for (;;) {
    // 5 — inject auth. Only ever onto an origin that matches the base URL's,
    // mirroring undici's own rule (and browsers'): a credential does not cross
    // an origin boundary on a redirect, even to a host on the allow list.
    //
    // This is deliberately stricter than the design doc's "re-attach when the
    // new host is still allowed", and the stricter reading is also the more
    // COMPATIBLE one: GitHub, Zenodo and Figshare all redirect downloads to a
    // presigned object host that rejects a request carrying two auth
    // mechanisms. Forwarding the token there breaks the download AND leaks it.
    const attachAuth = sameOrigin(currentUrl, new URL(api.baseUrl));
    const prepared = attachAuth
      ? injectAuth(api, currentUrl, callerHeaders)
      : { url: currentUrl, headers: callerHeaders };

    // One deadline for the whole chain, not one per hop: five hops each given a
    // fresh 30s would let a redirect loop stall a turn for two and a half
    // minutes while never tripping any single timeout.
    const remaining = RESPONSE_HEADERS_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) {
      return refuse(api.id, 504,
        `"${api.id}" did not send response headers within `
        + `${Math.round(RESPONSE_HEADERS_TIMEOUT_MS / 1000)}s.`);
    }

    // An AbortController rather than `AbortSignal.timeout()`, and cleared the
    // instant `fetch` resolves. `fetch` settles when the HEADERS arrive, so
    // clearing here leaves the BODY stream running with no deadline on it —
    // which is the required behaviour. Handing the signal to `fetch` and
    // leaving it armed would abort a long download mid-flight.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    let response: Response;
    try {
      response = await fetch(prepared.url, {
        method: currentMethod,
        headers: prepared.headers,
        body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[APIs] "${api.id}" ${currentMethod} ${redactUrlForLog(prepared.url, api.auth)} failed: ${message}`);
      return timedOut
        ? refuse(api.id, 504,
          `"${api.id}" did not send response headers within `
          + `${Math.round(RESPONSE_HEADERS_TIMEOUT_MS / 1000)}s.`)
        : refuse(api.id, 502, `Could not reach ${currentUrl.hostname}: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get('location');
    if (!isRedirectStatus(response.status) || !location) {
      // 9 — audit. Note the URL is redacted: for a `query`-auth API the secret
      // IS the query string, and this app has already written an API key into
      // cobuilding.log once from a path nobody thought about.
      const ms = Date.now() - started;
      const bytes = response.headers.get('content-length') ?? '?';
      log.info(
        `[APIs] ${input.caller.kind} ${currentMethod} ${api.id} `
        + `${redactUrlForLog(prepared.url, api.auth)} → ${response.status} ${ms}ms ${bytes}B`,
      );
      recordApiCall(api.id, { refused: false, status: response.status });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers[key] = value;
      });
      // 8 — stream the body through untouched, no size cap. Bytes going to
      // disk instead of into the model's context is the whole argument for
      // this feature existing rather than being an MCP tool.
      return { status: response.status, headers, body: response.body };
    }

    // Cancel the redirect's own (empty) body so the socket is released.
    void response.body?.cancel().catch(() => { /* already closed */ });

    if (++hops > MAX_REDIRECTS) {
      return refuse(api.id, 508, `"${api.id}" redirected more than ${MAX_REDIRECTS} times.`);
    }

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      return refuse(api.id, 502, `"${api.id}" returned an unusable redirect target: ${location}`);
    }

    // 7 — re-run the FULL policy check on every hop, not just the host. An
    // absolute URL wins inside resolveTargetUrl, which is exactly what we want
    // here: the hop is checked on its own merits.
    const hopCheck = resolveTargetUrl(api, next.toString());
    if (!hopCheck.ok) {
      return refuse(api.id, 403, `Redirect refused. ${hopCheck.error}`);
    }
    if (!hostIsAllowed(next.hostname, allowed)) {
      return refuse(api.id, 403,
        `Redirect to "${next.hostname}" refused — it is not on this API's allowed `
        + `list (${allowed.join(', ')}). Add it in Settings → APIs if expected.`);
    }

    // Browser semantics: 303 always becomes GET; 301/302 turn POST into GET;
    // 307/308 preserve both method and body.
    if (response.status === 303 || (currentMethod === 'POST' && response.status !== 307 && response.status !== 308)) {
      currentMethod = 'GET';
      currentBody = null;
    }
    currentUrl = hopCheck.url;
  }
}

// ---------------------------------------------------------------------------
// The loopback server
// ---------------------------------------------------------------------------

class ApiProxy {
  private server: http.Server | null = null;
  private boundPort: number | null = null;
  private instance = randomUUID();
  private lastError: string | null = null;

  /**
   * token -> the caller that token IDENTIFIES. This is what closes the second
   * door.
   *
   * The postMessage door always knew who was calling; the HTTP door did not,
   * because there was ONE app-wide token and `buildSubprocessEnv()` handed it
   * to every child it spawned — including the subprocess behind a mini-app's
   * `hostAPI.exec()`. A tool with no grants could therefore
   * `curl -H "<token>" $ACABOX_API_BASE/benchling/…` and be served as the chat
   * agent, which reaches every enabled API. The grant checkbox was decorative
   * for anything that could reach a shell.
   *
   * Making the token the identity means possession of a tool's token conveys
   * exactly that tool's grants and nothing more, and the chat token is never
   * written into a mini-app's environment at all.
   *
   * Grants themselves are deliberately NOT baked in: they are resolved per
   * request through `toolGrantResolver`, so revoking one in the UI takes effect
   * on the next call rather than on the next app run.
   */
  private callerByToken = new Map<string, ProxyCallerRef>();
  private tokenByCaller = new Map<string, string>();

  isRunning(): boolean { return this.server !== null && this.boundPort !== null; }
  port(): number | null { return this.boundPort; }
  error(): string | null { return this.lastError; }

  /**
   * The token for one caller, minted on first ask and stable thereafter.
   *
   * Stability matters: `buildSubprocessEnv()` is called per spawn, and a
   * long-running child must not be holding a token that a later spawn
   * invalidated.
   */
  tokenFor(caller: ProxyCallerRef): string | null {
    if (!this.isRunning()) return null;
    const key = callerKey(caller);
    const existing = this.tokenByCaller.get(key);
    if (existing) return existing;
    const minted = randomUUID();
    this.tokenByCaller.set(key, minted);
    this.callerByToken.set(minted, caller);
    return minted;
  }

  /** The chat agent's token. Never given to a mini-app. */
  token(): string | null { return this.tokenFor({ kind: 'chat' }); }

  baseUrl(): string | null {
    return this.boundPort ? `http://${LOOPBACK}:${this.boundPort}` : null;
  }

  /**
   * Start listening. Never throws: an API proxy that cannot bind is a degraded
   * feature, not a reason to fail the boot. The failure is recorded and shown
   * in Settings with the real error, and `buildApiGuidance` is skipped so the
   * agent is never told about a facility that isn't there.
   */
  async start(): Promise<void> {
    if (this.isRunning()) return;
    try {
      const port = await findFreePort(PORT_RANGE_START, PORT_RANGE_END);
      const server = http.createServer((req, res) => { void this.handle(req, res); });

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // The 127.0.0.1 LITERAL, not 'localhost' — which can resolve ::1 first,
        // a mistake the connector work found at four separate call sites.
        server.listen(port, LOOPBACK, () => resolve());
      });

      this.server = server;
      this.boundPort = port;
      this.lastError = null;
      log.info(`[APIs] Proxy listening on http://${LOOPBACK}:${port}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log.warn(`[APIs] Proxy failed to start: ${this.lastError} — APIs will be unavailable.`);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    // Every issued token dies with the listener. A restart mints fresh ones, so
    // a token scraped out of an old process's environment is inert.
    this.callerByToken.clear();
    this.tokenByCaller.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.info('[APIs] Proxy stopped.');
  }

  /**
   * Resolve the bearer of this request's token to the caller it identifies.
   * Returns a refusal string instead when the token is absent or unknown.
   */
  private authorize(req: http.IncomingMessage): { caller: ProxyCallerRef } | { denied: string } {
    // Any process on the machine can reach a loopback port, and so can a web
    // page in a browser. Without a token, a malicious page could spend the
    // user's API credits or read their account through this server.
    const supplied = req.headers[API_PROXY_TOKEN_HEADER];
    if (!this.isRunning()) return { denied: 'The API proxy is not running.' };
    if (typeof supplied !== 'string' || !supplied) {
      return { denied: `Missing ${API_PROXY_TOKEN_HEADER} header.` };
    }

    // Compared against every issued token in constant time. Iterating rather
    // than a Map.get() keeps the comparison non-early-exit; all tokens are
    // randomUUID() so the length guard never fires in practice, but
    // timingSafeEqual throws on a mismatch, so it has to be there.
    const a = Buffer.from(supplied);
    let matched: ProxyCallerRef | null = null;
    for (const [token, caller] of this.callerByToken) {
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) matched = caller;
    }
    if (!matched) return { denied: `Invalid ${API_PROXY_TOKEN_HEADER}.` };

    // Cheap hardening on top of the token: no legitimate caller here is a
    // browser, and a page cannot suppress either of these headers.
    if (req.headers.origin || req.headers['sec-fetch-site']) {
      return { denied: 'Browser-originated requests are not accepted by this proxy.' };
    }
    return { caller: matched };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);

    if (url.pathname === '/_health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, instance: this.instance }));
      return;
    }

    const auth = this.authorize(req);
    if ('denied' in auth) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: auth.denied }));
      return;
    }

    // Route: /<apiId>/<path...>
    const withoutLeadingSlash = url.pathname.replace(/^\/+/, '');
    const slash = withoutLeadingSlash.indexOf('/');
    const apiId = slash === -1 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, slash);
    const rest = slash === -1 ? '' : withoutLeadingSlash.slice(slash + 1);
    if (!apiId) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request an API as /<api-id>/<path>.' }));
      return;
    }

    let body: ApiRequestBody | null = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await readBody(req, MAX_REQUEST_BODY_BYTES);
      } catch (err) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
        return;
      }
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(', ');
    }

    const outcome = await performApiRequest({
      apiId,
      method: req.method ?? 'GET',
      path: rest + url.search,
      headers,
      body,
      // The token decided this, not the request. A mini-app's subprocess
      // carries that tool's token and is therefore held to that tool's grants
      // on the HTTP door exactly as it is on the postMessage one.
      caller: callerWithGrants(auth.caller),
    });

    if (outcome.error || !outcome.body) {
      res.writeHead(outcome.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: outcome.error ?? null }));
      return;
    }

    res.writeHead(outcome.status, outcome.headers);
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = Readable.fromWeb(outcome.body as Parameters<typeof Readable.fromWeb>[0]);
        stream.on('error', reject);
        res.on('close', resolve);
        stream.pipe(res).on('finish', resolve);
      });
    } catch (err) {
      log.warn(`[APIs] Streaming "${apiId}" response failed: ${(err as Error).message}`);
      res.destroy();
    }
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<ApiRequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`Request body exceeds the ${Math.round(limit / 1024 / 1024)} MB proxy limit.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      // Assembled by hand rather than with Buffer.concat so the result is
      // backed by a plain ArrayBuffer — see the ApiRequestBody comment.
      const out = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(out);
    });
    req.on('error', reject);
  });
}

export const apiProxy = new ApiProxy();
