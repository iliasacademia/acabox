/**
 * APIs — direct HTTP access to services that have no MCP server.
 *
 * One definition shared by the main process (persistence + the proxy), the
 * agent server (session guidance), and the renderer (Settings → APIs), so the
 * three can't drift. Same arrangement as `shared/connectors.ts`, for the same
 * reason.
 *
 * WHY THIS EXISTS ALONGSIDE CONNECTORS. A connector attaches an MCP *server*,
 * which is bounded by what the vendor chose to expose. Three gaps that leaves:
 *
 *  1. Most scientific APIs ship no MCP server at all (E-utilities, UniProt,
 *     ChEMBL, Ensembl, Europe PMC, Zenodo, Figshare, OSF, protocols.io).
 *  2. An MCP server exposes curated tools, not the API. The Hex connector is
 *     read-only by its own server instructions; the Hex REST API is not.
 *  3. MCP responses flow through the model's context. A scientist pulling a
 *     real dataset needs bytes on disk, not tokens in a window.
 *
 * The framing that follows from that: this is not a keyring, it is *the set of
 * HTTP endpoints Claude is allowed to reach, with credentials for the ones that
 * need them*. A keyless entry still buys a base URL the agent doesn't have to
 * guess, host-allowlist enforcement, the write gate, and the audit trail —
 * which is why ten of the sixteen catalog entries have no auth at all.
 *
 * Design: `docs/design/api-tokens.md`.
 */

export type ApiAuthStyle = 'none' | 'bearer' | 'header' | 'query' | 'basic';

export interface ApiAuth {
  style: ApiAuthStyle;
  /** style==='header': the header name, e.g. 'x-api-key'. */
  headerName?: string;
  /** style==='query': the parameter name, e.g. 'api_key'. */
  queryParam?: string;
  /**
   * style==='basic': the username half, which is NOT a secret and is stored in
   * the clear alongside the rest of the config.
   *
   * Leave it empty for the widespread "API key as the username, empty
   * password" convention — Benchling and Stripe both do this — in which case
   * the credential goes in the username position and `secret` is the whole
   * thing. See `basicCredential` for the one place that decides.
   */
  basicUser?: string;
  /**
   * The credential. Encrypted at rest and NEVER sent over IPC — `listApis()`
   * blanks it and reports `hasSecret` instead. Only `apiProxy` ever sees the
   * decrypted value.
   */
  secret?: string;
}

export interface ApiConfig {
  /** URL path segment: `<proxy>/<id>/…`. Lowercase — see API_ID_PATTERN. */
  id: string;
  label: string;
  /** Every request resolves against this. https, or http on loopback. */
  baseUrl: string;
  /**
   * ADDITIONAL hostnames the resolved URL may target, including redirect hops.
   *
   * The base URL's own host is always allowed and does not need to be listed —
   * see `effectiveAllowedHosts`. This field is for the extra hosts an API
   * redirects downloads to (Zenodo, Figshare and OSF all do), and for APIs
   * split across sibling hosts (RCSB's `data.` and `search.`).
   *
   * An entry may be an exact hostname or a single leading-dot suffix:
   * `.zenodo.org` matches `files.zenodo.org` but NOT `evil-zenodo.org`.
   */
  allowedHosts: string[];
  auth: ApiAuth;
  enabled: boolean;
  /** false => GET/HEAD only. The default, deliberately. */
  allowWrites: boolean;
  /**
   * One or two sentences the agent reads: what this API is for and the one
   * thing it needs to know. Seeded from the catalog, user-editable. Highest
   * leverage field in the feature — it is what stops the agent guessing.
   */
  notes?: string;
  catalogId?: string;
  docsUrl?: string;
}

/** What the renderer gets: identical, minus the secret. */
export type ApiConfigForUi = Omit<ApiConfig, 'auth'> & {
  auth: Omit<ApiAuth, 'secret'>;
  /** Whether a credential is stored, without revealing it. */
  hasSecret: boolean;
};

/**
 * Per-API usage, counted in memory and reset on restart. The UI labels it
 * "since launch" and shows nothing at all for an API never called, rather than
 * a zero that reads like a failure.
 */
export interface ApiCounters {
  calls: number;
  refused: number;
  lastUsedAt: number | null;
  lastStatus: number | null;
}

/**
 * Valid API id. LOWERCASE ONLY, unlike `CONNECTOR_ID_PATTERN` which permits
 * mixed case: this id is a URL path segment, so `/ncbi/` and `/NCBI/` differing
 * would be a bug generator and the agent will typo the case. Uppercase input is
 * lowercased on save rather than rejected.
 */
export const API_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const API_ID_RULE =
  'Use lowercase letters, numbers, and hyphens only, starting with a letter or number.';

/**
 * Ids the proxy's own routing would shadow.
 *
 * `_health` is underscore-prefixed and so unreachable by a valid id anyway;
 * these are reserved against a future route that isn't, and because an API
 * called `apis` reads as the MCP relay server of the same name.
 */
export const RESERVED_API_IDS = ['health', 'apis', 'v1'];

/** Header the proxy requires on every request. See `apiProxy`. */
export const API_PROXY_TOKEN_HEADER = 'x-acabox-api-token';

/** Env vars `buildSubprocessEnv()` exports so agent subprocesses can call in. */
export const API_BASE_ENV = 'ACABOX_API_BASE';
export const API_TOKEN_ENV = 'ACABOX_API_TOKEN';

/** Methods allowed when `allowWrites` is false. */
export const READ_ONLY_METHODS = ['GET', 'HEAD'];

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

/** Validate one API in isolation. `existingIds` are the OTHER configured ids. */
export function validateApi(api: Partial<ApiConfig>, existingIds: string[] = []): ValidationResult {
  const id = (api.id ?? '').trim().toLowerCase();
  if (!id) return { ok: false, error: 'Name is required.' };
  if (!API_ID_PATTERN.test(id)) {
    return { ok: false, error: `Invalid name "${id}". ${API_ID_RULE}` };
  }
  if (RESERVED_API_IDS.includes(id)) {
    return { ok: false, error: `"${id}" is reserved by Acabox. Pick another name.` };
  }
  if (existingIds.includes(id)) {
    return { ok: false, error: `An API named "${id}" already exists.` };
  }

  const baseUrl = (api.baseUrl ?? '').trim();
  if (!baseUrl) return { ok: false, error: 'Base URL is required.' };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: `"${baseUrl}" is not a valid URL.` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'Base URL must start with https:// or http://.' };
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      error: 'Remote APIs must use https:// — http:// is only allowed for localhost.',
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Put the credential in the Auth section, not in the URL.' };
  }

  const style = api.auth?.style;
  if (style !== 'none' && style !== 'bearer' && style !== 'header'
    && style !== 'query' && style !== 'basic') {
    return { ok: false, error: 'Pick an authentication style.' };
  }
  // A colon in the username would be decoded as the field separator by the
  // server, silently splitting the credential somewhere the user didn't intend.
  if (style === 'basic' && (api.auth?.basicUser ?? '').includes(':')) {
    return { ok: false, error: 'A Basic-auth username cannot contain a colon.' };
  }
  if (style === 'header' && !(api.auth?.headerName ?? '').trim()) {
    return { ok: false, error: 'Header name is required for header authentication.' };
  }
  if (style === 'query' && !(api.auth?.queryParam ?? '').trim()) {
    return { ok: false, error: 'Query parameter name is required for query authentication.' };
  }

  for (const host of api.allowedHosts ?? []) {
    const h = host.trim();
    if (!h) continue;
    // A bare dot, or a suffix with no label after it, would match far too much.
    if (h === '.' || (h.startsWith('.') && !h.slice(1).includes('.'))) {
      return { ok: false, error: `"${h}" is too broad to be an allowed host.` };
    }
    if (/[/:\s]/.test(h)) {
      return { ok: false, error: `"${h}" should be a hostname only — no scheme, port, or path.` };
    }
  }

  return { ok: true };
}

/**
 * Hosts this API may actually reach: the base URL's own host, plus whatever
 * extra hosts the user allowed.
 *
 * The base host is implicit rather than seeded into the stored array so that
 * editing `baseUrl` can never leave a stale host allowed and the new one
 * refused — a failure that would present as an inexplicable 403 right after a
 * successful save.
 */
export function effectiveAllowedHosts(api: Pick<ApiConfig, 'baseUrl' | 'allowedHosts'>): string[] {
  const out: string[] = [];
  try {
    out.push(new URL(api.baseUrl).hostname.toLowerCase());
  } catch { /* validation reports this; resolution will fail anyway */ }
  for (const h of api.allowedHosts ?? []) {
    const trimmed = h.trim().toLowerCase();
    if (trimmed) out.push(trimmed);
  }
  return [...new Set(out)];
}

/**
 * Is `hostname` covered by `allowed`? Exact match, or a single leading-dot
 * suffix (`.zenodo.org` matches `files.zenodo.org`).
 *
 * Deliberately not a wildcard or regex language: `evil.com` must never match
 * via `.com`, and a leading-dot entry must not match the bare suffix either
 * (`.zenodo.org` does not match `zenodo.org` — list the apex explicitly, which
 * `effectiveAllowedHosts` already does for the base host).
 */
export function hostIsAllowed(hostname: string, allowed: readonly string[]): boolean {
  // `new URL` lowercases and punycodes the host, so a Unicode homograph
  // arrives here as `xn--…` and cannot equal an ASCII entry by accident.
  const h = hostname.toLowerCase().replace(/\.$/, '');
  for (const entry of allowed) {
    const e = entry.toLowerCase().replace(/\.$/, '');
    if (!e) continue;
    if (e.startsWith('.')) {
      if (h.endsWith(e)) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

export type ResolveResult =
  | { ok: true; url: URL }
  | { ok: false; error: string };

/**
 * A base URL whose path always ends in `/`.
 *
 * `new URL('esearch.fcgi', '…/entrez/eutils')` is `…/entrez/esearch.fcgi` — RFC
 * 3986 relative resolution replaces the last segment unless the base ends in a
 * slash. A user who types a base URL without the trailing slash therefore gets
 * a silently WRONG upstream URL and a 404 nobody can explain from the agent's
 * transcript. Every catalog entry already ends in `/`; this exists for the
 * Custom form and for the per-tenant placeholders (Benchling) the user must
 * edit by hand.
 *
 * Applied on save (so the UI shows the canonical value) AND inside
 * `resolveTargetUrl` (so an entry stored by an earlier build is corrected
 * without a migration).
 */
export function normalizeBaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.href;
  } catch {
    return raw; // not a URL; validateApi reports it properly
  }
}

/**
 * Resolve a caller-supplied path against an API's base URL and decide whether
 * the result may be requested. Pure, no I/O — this is the function the feature
 * is attacked through, so it is exhaustively unit-tested.
 *
 * The one non-obvious property: `new URL(rawPath, baseUrl)` lets an ABSOLUTE
 * rawPath win outright — `new URL('https://evil.com/x', base)` is
 * `https://evil.com/x`. That is not prevented at parse time on purpose; it is
 * precisely why the host check below runs on the RESOLVED url rather than on
 * the input. Any rewrite of this function must preserve that ordering.
 */
export function resolveTargetUrl(
  api: Pick<ApiConfig, 'baseUrl' | 'allowedHosts'>,
  rawPath: string,
): ResolveResult {
  let base: URL;
  try {
    // Normalised here as well as on save: an entry written by an earlier build
    // would otherwise keep resolving against an unslashed base forever.
    base = new URL(normalizeBaseUrl(api.baseUrl));
  } catch {
    return { ok: false, error: `The API's base URL ("${api.baseUrl}") is not valid.` };
  }

  // A LEADING SLASH is how everyone writes a REST path — it is what the vendor's
  // own docs show, and what `hostAPI.api.fetch('benchling', '/entries')` reads
  // naturally as. Left alone it resolves to the HOST ROOT, escaping the API's
  // base path, and the prefix check below then refuses it: the idiomatic call
  // fails while the unidiomatic one works. Treat the two as the same request.
  //
  // Only a SINGLE leading slash. `//evil.com/x` is protocol-relative — a host
  // swap, not a path — and must stay intact so the host allow list judges it
  // rather than having it quietly rewritten into a path segment.
  const requestedPath = rawPath ?? '';
  const relativePath = /^\/(?!\/)/.test(requestedPath)
    ? requestedPath.slice(1)
    : requestedPath;

  let resolved: URL;
  try {
    resolved = new URL(relativePath, base);
  } catch {
    return { ok: false, error: `"${rawPath}" is not a valid path or URL.` };
  }

  if (resolved.protocol !== 'https:'
    && !(resolved.protocol === 'http:' && isLoopbackHost(resolved.hostname))) {
    return {
      ok: false,
      error: `Refused: ${resolved.protocol}// is not allowed (https only, or http on localhost).`,
    };
  }

  // Refuse `https://user:pass@host/`. Enough libraries mis-parse the host in
  // the presence of userinfo that it is worth refusing outright; it is also how
  // `//evil.com@good.com/x` tries to read as a host swap.
  if (resolved.username || resolved.password) {
    return { ok: false, error: 'Refused: credentials embedded in the URL are not allowed.' };
  }

  const allowed = effectiveAllowedHosts(api);
  if (!hostIsAllowed(resolved.hostname, allowed)) {
    return {
      ok: false,
      error: `Refused: host "${resolved.hostname}" is not on this API's allowed list `
        + `(${allowed.join(', ')}). Add it in Settings → APIs if that host is expected.`,
    };
  }

  // Keep the credential scoped to the API's own path surface — without this, an
  // API based at `https://app.hex.tech/api/v1/` could be walked back to
  // `https://app.hex.tech/login` with the bearer token attached.
  //
  // Only enforced on the BASE host: an extra allowed host is a CDN or a sibling
  // service with its own unrelated path layout (RCSB's `search.` vs `data.`),
  // where a prefix taken from the base URL would be meaningless.
  if (resolved.hostname.toLowerCase() === base.hostname.toLowerCase()) {
    // `new URL` has already normalised `..`, so this is a prefix check on a
    // canonical path rather than string munging on attacker-controlled input.
    // `base` is normalised to end in `/`, so its pathname IS the prefix.
    const prefix = base.pathname;
    if (!resolved.pathname.startsWith(prefix)) {
      return {
        ok: false,
        error: `Refused: "${resolved.pathname}" is outside this API's base path (${prefix}).`,
      };
    }
  }

  return { ok: true, url: resolved };
}

/**
 * The URL as it is safe to log.
 *
 * For a `query`-auth API the credential is IN the query string, so logging the
 * URL verbatim writes the secret to `cobuilding.log`. That is not hypothetical:
 * this app has already leaked the Anthropic key into that exact file once, from
 * a failure path nobody thought about (TitleGen, fixed 2026-07-23). Every log
 * and counter path goes through this function, and a test asserts the secret
 * reaches the wire and reaches neither.
 */
export function redactUrlForLog(url: URL, auth: Pick<ApiAuth, 'style' | 'queryParam'>): string {
  const copy = new URL(url.toString());
  if (auth.style === 'query' && auth.queryParam) {
    if (copy.searchParams.has(auth.queryParam)) {
      copy.searchParams.set(auth.queryParam, 'REDACTED');
    }
  }
  return copy.toString();
}

/**
 * The `user:password` pair a Basic-auth API should be given, before base64.
 *
 * One function so the rule lives in exactly one place, because the two shapes
 * look alike and mean different things:
 *
 *   basicUser set   →  `${basicUser}:${secret}`   ordinary username/password
 *   basicUser empty →  `${secret}:`               key-as-username, empty password
 *
 * The second is the convention Benchling and Stripe use, and getting it
 * backwards produces a 401 that reads exactly like a wrong key.
 */
export function basicCredential(auth: Pick<ApiAuth, 'basicUser' | 'secret'>): string {
  const secret = auth.secret ?? '';
  const user = (auth.basicUser ?? '').trim();
  return user ? `${user}:${secret}` : `${secret}:`;
}

/** Stable display name. */
export function apiDisplayName(api: Pick<ApiConfig, 'id' | 'label'>): string {
  return api.label?.trim() || api.id;
}

/** How the auth style reads in the UI and in guidance. */
export function describeAuthStyle(
  auth: Pick<ApiAuth, 'style' | 'headerName' | 'queryParam' | 'basicUser'>,
): string {
  switch (auth.style) {
    case 'bearer': return 'Bearer token';
    case 'header': return `Header ${auth.headerName || '?'}`;
    case 'query': return `Query ${auth.queryParam || '?'}`;
    case 'basic':
      return auth.basicUser?.trim()
        ? `Basic as ${auth.basicUser.trim()}`
        : 'Basic, key as username';
    default: return 'No auth';
  }
}

// ---------------------------------------------------------------------------
// Session guidance
// ---------------------------------------------------------------------------

/**
 * The block appended to the agent's system prompt. Kept to a few hundred tokens
 * for a realistic handful of APIs — detail lives behind `mcp__apis__list_apis`,
 * which reads live state.
 *
 * Returns undefined when there is nothing to say, so the agent is never told
 * about a facility that isn't there (the proxy failing to bind is a supported
 * state, not a boot failure).
 */
export function buildApiGuidance(apis: ApiConfig[]): string | undefined {
  const enabled = apis.filter((a) => a.enabled);
  if (!enabled.length) return undefined;

  const lines = enabled.map((a) => {
    const access = a.allowWrites ? 'read & write' : 'read only';
    const note = a.notes?.trim() ? ` ${a.notes.trim()}` : '';
    return `- **${a.id}** (${access}) —${note}`;
  });

  return [
    '## APIs',
    '',
    'You can call these HTTP APIs through Acabox\'s local proxy. The proxy holds the'
    + ' credentials — you never see them and must never ask the user for one.',
    '',
    `The base URL is in \`$${API_BASE_ENV}\`; send \`$${API_TOKEN_ENV}\` as the`
    + ` \`${API_PROXY_TOKEN_HEADER}\` header. Both are already in your environment.`,
    '',
    '```bash',
    `curl -sH "${API_PROXY_TOKEN_HEADER}: $${API_TOKEN_ENV}" \\`,
    `  "$${API_BASE_ENV}/ncbi/esearch.fcgi?db=pubmed&term=crispr&retmode=json"`,
    '```',
    '',
    ...lines,
    '',
    'Read-only APIs refuse anything but GET and HEAD. That is the user\'s setting,'
    + ' not a bug — tell them which API needs writes rather than looking for another'
    + ' route. Call `mcp__apis__list_apis` for full detail on any of these.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface ApiCatalogEntry {
  catalogId: string;
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  allowedHosts?: string[];
  auth: { style: ApiAuthStyle; headerName?: string; queryParam?: string; basicUser?: string };
  /**
   * True when `baseUrl` carries a placeholder the user MUST replace — a
   * per-tenant host. The UI says so instead of letting them press Test and get
   * a DNS error they have to interpret.
   */
  baseUrlNeedsEditing?: boolean;
  /** True when the API works without a credential and the key only adds quota. */
  secretOptional?: boolean;
  notes?: string;
  docsUrl?: string;
  /** Suggested default for `allowWrites` when the user adds this entry. */
  suggestWrites?: boolean;
}

/**
 * Known APIs, offered as one-click starting points. Purely data — adding a
 * service is an entry here and nothing else.
 *
 * EVERY baseUrl BELOW WAS CURLED on 2026-07-29 and returned a real response:
 * 200 for the keyless ones, 401 for `hex` and `orcid`-style authenticated
 * paths, and 400-with-`"please use header Authorization: Bearer"` for
 * protocols.io (which reports missing auth as 400). The connector catalog
 * carries the same "written from knowledge" caveat and one of its five entries
 * shipped with a 404 docsUrl, so these are measured rather than recalled. Re-run
 * the probe if you add one.
 */
export const API_CATALOG: ApiCatalogEntry[] = [
  {
    catalogId: 'hex',
    id: 'hex',
    label: 'Hex',
    description: 'The Hex REST API — projects, runs, and semantic models.',
    baseUrl: 'https://app.hex.tech/api/v1/',
    auth: { style: 'bearer' },
    notes: 'Hex REST API. Unlike the Hex MCP connector, which is read-only by its own '
      + 'server instructions, this reaches the full API. Create a token in Hex under '
      + 'Settings → API keys.',
    docsUrl: 'https://learn.hex.tech/docs/api/api-reference',
    suggestWrites: false,
  },
  {
    catalogId: 'benchling',
    id: 'benchling',
    label: 'Benchling',
    description: 'Entries, sequences, registry and results in your Benchling tenant.',
    // PER-TENANT host — there is no shared one. Measured 2026-07-29:
    // `demo.benchling.com/api/v2/entries` returns Benchling's own
    // `authentication_error`, confirming the path shape, while an unknown
    // tenant does not resolve at all.
    baseUrl: 'https://YOUR-TENANT.benchling.com/api/v2/',
    baseUrlNeedsEditing: true,
    // The reason Basic exists at all. Benchling authenticates an API key as the
    // Basic USERNAME with an empty password, so `basicUser` is left unset and
    // the key goes in the username position — see `basicCredential`.
    auth: { style: 'basic' },
    notes: 'Replace YOUR-TENANT with your Benchling subdomain. The API key goes in '
      + 'the username position with an empty password, which is what "Basic, key as '
      + 'username" below means. Writes need to be enabled explicitly.',
    docsUrl: 'https://benchling.com/api/reference',
    suggestWrites: false,
  },
  {
    catalogId: 'ncbi',
    id: 'ncbi',
    label: 'NCBI E-utilities',
    description: 'PubMed, GenBank, Gene and the rest of E-utilities.',
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/',
    auth: { style: 'query', queryParam: 'api_key' },
    secretOptional: true,
    notes: 'esearch.fcgi / efetch.fcgi / esummary.fcgi, all relative to the base. '
      + 'A key is optional and raises the rate limit from 3 to 10 requests/second.',
    docsUrl: 'https://www.ncbi.nlm.nih.gov/books/NBK25501/',
  },
  {
    catalogId: 'uniprot',
    id: 'uniprot',
    label: 'UniProt',
    description: 'Protein sequences and annotation.',
    baseUrl: 'https://rest.uniprot.org/',
    auth: { style: 'none' },
    notes: 'No key needed. e.g. uniprotkb/P05067.json, or uniprotkb/search?query=…',
    docsUrl: 'https://www.uniprot.org/help/api',
  },
  {
    catalogId: 'chembl',
    id: 'chembl',
    label: 'ChEMBL',
    description: 'Bioactivity, compounds and targets.',
    baseUrl: 'https://www.ebi.ac.uk/chembl/api/data/',
    auth: { style: 'none' },
    notes: 'No key needed. Append .json to a resource for JSON, e.g. molecule/CHEMBL25.json',
    docsUrl: 'https://chembl.gitbook.io/chembl-interface-documentation/web-services',
  },
  {
    catalogId: 'pdb',
    id: 'pdb',
    label: 'RCSB PDB',
    description: 'Experimental protein structures.',
    baseUrl: 'https://data.rcsb.org/rest/v1/',
    // Three sibling hosts with unrelated path layouts — the reason the base-path
    // check is scoped to the base host only.
    allowedHosts: ['search.rcsb.org', 'files.rcsb.org'],
    auth: { style: 'none' },
    notes: 'Metadata at data.rcsb.org (core/entry/4HHB), search at '
      + 'search.rcsb.org/rcsbsearch/v2/query, coordinate files at files.rcsb.org.',
    docsUrl: 'https://data.rcsb.org/redoc/',
  },
  {
    catalogId: 'alphafold',
    id: 'alphafold',
    label: 'AlphaFold DB',
    description: 'Predicted protein structures.',
    baseUrl: 'https://alphafold.ebi.ac.uk/',
    auth: { style: 'none' },
    notes: 'Predictions at api/prediction/<uniprot-accession>; the PDB/mmCIF files '
      + 'that response points at are under files/ on the same host.',
    docsUrl: 'https://alphafold.ebi.ac.uk/api-docs',
  },
  {
    catalogId: 'ensembl',
    id: 'ensembl',
    label: 'Ensembl',
    description: 'Genomes, variation and comparative genomics.',
    baseUrl: 'https://rest.ensembl.org/',
    auth: { style: 'none' },
    notes: 'No key needed. Ask for JSON with ?content-type=application/json.',
    docsUrl: 'https://rest.ensembl.org/',
  },
  {
    catalogId: 'europepmc',
    id: 'europepmc',
    label: 'Europe PMC',
    description: 'Literature search and open-access full text.',
    baseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest/',
    auth: { style: 'none' },
    notes: 'Complements ncbi and often has full text where PubMed has only an abstract. '
      + 'e.g. search?query=crispr&format=json',
    docsUrl: 'https://europepmc.org/RestfulWebService',
  },
  {
    catalogId: 'crossref',
    id: 'crossref',
    label: 'Crossref',
    description: 'DOI metadata for almost everything published.',
    baseUrl: 'https://api.crossref.org/',
    auth: { style: 'none' },
    notes: 'No key needed. Add mailto=<the user\'s email> to any query to use the '
      + 'faster "polite pool".',
    docsUrl: 'https://api.crossref.org/swagger-ui/index.html',
  },
  {
    catalogId: 'semanticscholar',
    id: 'semanticscholar',
    label: 'Semantic Scholar',
    description: 'Citations, references and paper embeddings.',
    baseUrl: 'https://api.semanticscholar.org/graph/v1/',
    auth: { style: 'header', headerName: 'x-api-key' },
    secretOptional: true,
    notes: 'Works without a key at a low rate limit. e.g. '
      + 'paper/DOI:10.1038/nature12373?fields=title,citationCount',
    docsUrl: 'https://api.semanticscholar.org/api-docs/graph',
  },
  {
    catalogId: 'orcid',
    id: 'orcid',
    label: 'ORCID',
    description: 'Researcher identity and public record.',
    baseUrl: 'https://pub.orcid.org/v3.0/',
    auth: { style: 'bearer' },
    secretOptional: true,
    notes: 'The public API needs no token. Send Accept: application/json — it '
      + 'returns XML otherwise.',
    docsUrl: 'https://info.orcid.org/documentation/api-tutorials/',
  },
  {
    catalogId: 'zenodo',
    id: 'zenodo',
    label: 'Zenodo',
    description: 'Deposit and fetch research datasets.',
    baseUrl: 'https://zenodo.org/api/',
    allowedHosts: ['.zenodo.org'],
    auth: { style: 'bearer' },
    notes: 'File downloads redirect to files.zenodo.org, which is already allowed. '
      + 'Depositing requires writes and a token with the deposit scope.',
    docsUrl: 'https://developers.zenodo.org/',
    suggestWrites: false,
  },
  {
    catalogId: 'figshare',
    id: 'figshare',
    label: 'Figshare',
    description: 'Publish and fetch figures, datasets and filesets.',
    baseUrl: 'https://api.figshare.com/v2/',
    allowedHosts: ['ndownloader.figshare.com', '.figshare.com'],
    auth: { style: 'bearer' },
    notes: 'Public reads work without a token; anything under account/ needs one. '
      + 'Downloads go via ndownloader.figshare.com.',
    docsUrl: 'https://docs.figshare.com/',
    suggestWrites: false,
  },
  {
    catalogId: 'osf',
    id: 'osf',
    label: 'OSF',
    description: 'Open Science Framework projects, files and registrations.',
    baseUrl: 'https://api.osf.io/v2/',
    allowedHosts: ['files.osf.io', '.osf.io'],
    auth: { style: 'bearer' },
    notes: 'Public reads work without a token. File contents live on files.osf.io, '
      + 'which is already allowed.',
    docsUrl: 'https://developer.osf.io/',
    suggestWrites: false,
  },
  {
    catalogId: 'protocolsio',
    id: 'protocolsio',
    label: 'protocols.io',
    description: 'Published experimental protocols.',
    baseUrl: 'https://www.protocols.io/api/v3/',
    auth: { style: 'bearer' },
    notes: 'Requires a token for everything, and reports a missing one as HTTP 400 '
      + 'rather than 401 — so a 400 here usually means the token, not the query.',
    docsUrl: 'https://apidoc.protocols.io/',
  },
  {
    catalogId: 'github',
    id: 'github',
    label: 'GitHub',
    description: 'Repositories, issues, releases and raw file contents.',
    baseUrl: 'https://api.github.com/',
    allowedHosts: ['codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com'],
    auth: { style: 'bearer' },
    secretOptional: true,
    notes: 'Works unauthenticated at 60 requests/hour; a token raises that to 5,000. '
      + 'Tarball and release-asset downloads redirect to codeload/objects hosts, '
      + 'which are already allowed.',
    docsUrl: 'https://docs.github.com/en/rest',
    suggestWrites: false,
  },
];

/** Build a fresh ApiConfig from a catalog entry, with no secret yet. */
export function apiFromCatalog(entry: ApiCatalogEntry): ApiConfig {
  return {
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    allowedHosts: [...(entry.allowedHosts ?? [])],
    auth: {
      style: entry.auth.style,
      ...(entry.auth.headerName ? { headerName: entry.auth.headerName } : {}),
      ...(entry.auth.queryParam ? { queryParam: entry.auth.queryParam } : {}),
      ...(entry.auth.basicUser ? { basicUser: entry.auth.basicUser } : {}),
    },
    enabled: true,
    allowWrites: entry.suggestWrites ?? false,
    notes: entry.notes,
    catalogId: entry.catalogId,
    docsUrl: entry.docsUrl,
  };
}
