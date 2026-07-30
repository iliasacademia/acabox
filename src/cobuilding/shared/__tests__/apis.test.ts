/**
 * `shared/apis.ts` — the pure half of the API feature.
 *
 * `resolveTargetUrl` is where this feature gets attacked, so it carries the
 * weight here: an absolute URL smuggled in as a "path", `..` traversal, suffix
 * matching that must not degenerate into "ends with .com", embedded userinfo,
 * and Unicode homographs. Everything else in the file is one or two cases.
 */
import {
  API_BASE_ENV,
  API_TOKEN_ENV,
  apiFromCatalog,
  API_CATALOG,
  buildApiGuidance,
  effectiveAllowedHosts,
  hostIsAllowed,
  redactUrlForLog,
  resolveTargetUrl,
  validateApi,
  type ApiConfig,
} from '../apis';

function api(over: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: 'test',
    label: 'Test',
    baseUrl: 'https://api.example.com/v2/',
    allowedHosts: [],
    auth: { style: 'none' },
    enabled: true,
    allowWrites: false,
    ...over,
  };
}

/** Convenience: the resolved href, or the refusal message. */
function resolve(a: ApiConfig, path: string): string {
  const r = resolveTargetUrl(a, path);
  return r.ok ? r.url.toString() : `REFUSED: ${r.error}`;
}

describe('resolveTargetUrl — ordinary resolution', () => {
  it('resolves a relative path and query against the base', () => {
    expect(resolve(api({ baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/' }),
      'esearch.fcgi?db=pubmed&term=crispr'))
      .toBe('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=crispr');
  });

  it('resolves an empty path to the base itself', () => {
    expect(resolve(api(), '')).toBe('https://api.example.com/v2/');
  });

  it('keeps a base path with no trailing slash usable', () => {
    // The prefix becomes everything up to the last '/', so siblings resolve.
    expect(resolve(api({ baseUrl: 'https://api.example.com/v2' }), 'thing'))
      .toBe('https://api.example.com/thing');
  });
});

describe('resolveTargetUrl — host allow-list', () => {
  it('REFUSES an absolute URL smuggled in as the path', () => {
    // new URL('https://evil.com/x', base) === 'https://evil.com/x'. The parse
    // is allowed to do that; the host check on the RESOLVED url is the defence.
    expect(resolve(api(), 'https://evil.com/steal')).toMatch(/^REFUSED/);
    expect(resolve(api(), 'https://evil.com/steal')).toContain('evil.com');
  });

  it('REFUSES a protocol-relative host swap', () => {
    expect(resolve(api(), '//evil.com/steal')).toMatch(/^REFUSED/);
  });

  it('permits an absolute URL to an explicitly allowed extra host', () => {
    const rcsb = api({
      baseUrl: 'https://data.rcsb.org/rest/v1/',
      allowedHosts: ['search.rcsb.org'],
    });
    expect(resolve(rcsb, 'https://search.rcsb.org/rcsbsearch/v2/query?json=%7B%7D'))
      .toBe('https://search.rcsb.org/rcsbsearch/v2/query?json=%7B%7D');
  });

  it('matches a leading-dot suffix against subdomains', () => {
    const zenodo = api({ baseUrl: 'https://zenodo.org/api/', allowedHosts: ['.zenodo.org'] });
    expect(resolve(zenodo, 'https://files.zenodo.org/record/1/big.csv'))
      .toBe('https://files.zenodo.org/record/1/big.csv');
  });

  it('does NOT let a leading-dot suffix match a lookalike registrable domain', () => {
    const zenodo = api({ baseUrl: 'https://zenodo.org/api/', allowedHosts: ['.zenodo.org'] });
    // The classic bug: endsWith('zenodo.org') without the dot would allow this.
    expect(resolve(zenodo, 'https://evil-zenodo.org/x')).toMatch(/^REFUSED/);
  });

  it('never lets a suffix entry degenerate into a TLD match', () => {
    expect(hostIsAllowed('evil.com', ['.com'])).toBe(true);   // the rule itself
    // …which is exactly why validateApi refuses to store such an entry:
    expect(validateApi({ ...api({ allowedHosts: ['.com'] }) }).ok).toBe(false);
  });

  it('treats a Unicode homograph as the distinct punycode host it is', () => {
    // 'аpple.com' with a Cyrillic а. `new URL` punycodes it, so it cannot
    // collide with the ASCII entry by string equality.
    const a = api({ baseUrl: 'https://apple.com/v1/' });
    const refusal = resolve(a, 'https://аpple.com/v1/x');
    expect(refusal).toMatch(/^REFUSED/);
    expect(refusal).toContain('xn--');
  });

  it('is case- and trailing-dot-insensitive about hosts', () => {
    expect(hostIsAllowed('API.Example.COM', ['api.example.com'])).toBe(true);
    expect(hostIsAllowed('api.example.com.', ['api.example.com'])).toBe(true);
  });

  it('always allows the base URL host without it being listed', () => {
    expect(effectiveAllowedHosts(api())).toEqual(['api.example.com']);
    expect(resolve(api(), 'thing')).toBe('https://api.example.com/v2/thing');
  });
});

describe('resolveTargetUrl — path containment', () => {
  it('REFUSES traversal that escapes the base path on the base host', () => {
    // The credential is scoped to the API's own surface: an API based at
    // /api/v1/ must not be walked back to /login with the token attached.
    expect(resolve(api({ baseUrl: 'https://app.hex.tech/api/v1/' }), '../../login'))
      .toMatch(/outside this API's base path/);
  });

  it('REFUSES an absolute same-host URL outside the base path', () => {
    expect(resolve(api({ baseUrl: 'https://app.hex.tech/api/v1/' }), 'https://app.hex.tech/login'))
      .toMatch(/outside this API's base path/);
  });

  it('allows traversal that stays inside the base path', () => {
    expect(resolve(api({ baseUrl: 'https://api.example.com/v2/' }), 'a/../b'))
      .toBe('https://api.example.com/v2/b');
  });

  it('does NOT apply the base path to a different allowed host', () => {
    // search.rcsb.org has an unrelated path layout; a prefix taken from
    // data.rcsb.org's base URL would be meaningless there.
    const rcsb = api({
      baseUrl: 'https://data.rcsb.org/rest/v1/',
      allowedHosts: ['search.rcsb.org'],
    });
    expect(resolve(rcsb, 'https://search.rcsb.org/totally/other/path')).not.toMatch(/^REFUSED/);
  });
});

describe('resolveTargetUrl — scheme and userinfo', () => {
  it('REFUSES a non-http scheme', () => {
    expect(resolve(api(), 'file:///etc/passwd')).toMatch(/^REFUSED/);
    expect(resolve(api(), 'data:text/plain,hi')).toMatch(/^REFUSED/);
  });

  it('REFUSES plain http to a remote host', () => {
    expect(resolve(api(), 'http://api.example.com/v2/x')).toMatch(/^REFUSED/);
  });

  it('permits plain http to loopback, for a local dev API', () => {
    const local = api({ baseUrl: 'http://127.0.0.1:9999/api/' });
    expect(resolve(local, 'thing')).toBe('http://127.0.0.1:9999/api/thing');
  });

  it('REFUSES embedded credentials', () => {
    const a = api({ baseUrl: 'https://api.example.com/' });
    expect(resolve(a, 'https://user:pass@api.example.com/x'))
      .toMatch(/credentials embedded in the URL/);
  });
});

describe('redactUrlForLog', () => {
  it('redacts a query-style credential', () => {
    const url = new URL('https://eutils.ncbi.nlm.nih.gov/e.fcgi?db=pubmed&api_key=SUPERSECRET');
    const logged = redactUrlForLog(url, { style: 'query', queryParam: 'api_key' });
    expect(logged).not.toContain('SUPERSECRET');
    expect(logged).toContain('api_key=REDACTED');
    expect(logged).toContain('db=pubmed');       // the rest survives
  });

  it('leaves the URL alone for header/bearer styles', () => {
    const url = new URL('https://api.example.com/v2/thing?q=1');
    expect(redactUrlForLog(url, { style: 'bearer' })).toBe('https://api.example.com/v2/thing?q=1');
  });

  it('does not invent a parameter that was never there', () => {
    const url = new URL('https://api.example.com/v2/thing');
    expect(redactUrlForLog(url, { style: 'query', queryParam: 'api_key' }))
      .toBe('https://api.example.com/v2/thing');
  });
});

describe('validateApi', () => {
  it('accepts a well-formed API', () => {
    expect(validateApi(api()).ok).toBe(true);
  });

  it('rejects a duplicate id', () => {
    expect(validateApi(api({ id: 'ncbi' }), ['ncbi']).ok).toBe(false);
  });

  it('rejects reserved ids', () => {
    for (const id of ['health', 'apis', 'v1']) {
      expect(validateApi(api({ id })).ok).toBe(false);
    }
  });

  it('accepts uppercase input (the store lowercases it) but not punctuation', () => {
    expect(validateApi(api({ id: 'NCBI' })).ok).toBe(true);
    expect(validateApi(api({ id: 'my_api' })).ok).toBe(false);
    expect(validateApi(api({ id: 'my.api' })).ok).toBe(false);
  });

  it('rejects remote http and accepts loopback http', () => {
    expect(validateApi(api({ baseUrl: 'http://api.example.com/' })).ok).toBe(false);
    expect(validateApi(api({ baseUrl: 'http://localhost:8080/' })).ok).toBe(true);
  });

  it('rejects credentials in the base URL', () => {
    expect(validateApi(api({ baseUrl: 'https://u:p@api.example.com/' })).ok).toBe(false);
  });

  it('requires a header name / query param when that style is chosen', () => {
    expect(validateApi(api({ auth: { style: 'header' } })).ok).toBe(false);
    expect(validateApi(api({ auth: { style: 'header', headerName: 'x-api-key' } })).ok).toBe(true);
    expect(validateApi(api({ auth: { style: 'query' } })).ok).toBe(false);
    expect(validateApi(api({ auth: { style: 'query', queryParam: 'api_key' } })).ok).toBe(true);
  });

  it('rejects an allowed host that carries a scheme, port or path', () => {
    expect(validateApi(api({ allowedHosts: ['https://x.com'] })).ok).toBe(false);
    expect(validateApi(api({ allowedHosts: ['x.com:443'] })).ok).toBe(false);
    expect(validateApi(api({ allowedHosts: ['x.com/p'] })).ok).toBe(false);
  });
});

describe('buildApiGuidance', () => {
  it('returns undefined when there is nothing to announce', () => {
    expect(buildApiGuidance([])).toBeUndefined();
    expect(buildApiGuidance([api({ enabled: false })])).toBeUndefined();
  });

  it('names exactly ONE env var for the base URL', () => {
    // The design document flagged this as a live bug in its own draft: the
    // prose said `$ACABOX_API` while the formal variable was
    // `$ACABOX_API_BASE`. An agent copying a variable that does not exist
    // produces a confusing curl to an empty URL.
    const text = buildApiGuidance([api({ id: 'ncbi', notes: 'PubMed.' })])!;
    const bases = text.match(/\$ACABOX_API(?![_A-Z])/g) ?? [];
    expect(bases).toHaveLength(0);
    expect(text).toContain(`$${API_BASE_ENV}`);
    expect(text).toContain(`$${API_TOKEN_ENV}`);
  });

  it('lists enabled APIs with their access level and skips disabled ones', () => {
    const text = buildApiGuidance([
      api({ id: 'ncbi', notes: 'PubMed.' }),
      api({ id: 'zenodo', allowWrites: true }),
      api({ id: 'hidden', enabled: false }),
    ])!;
    expect(text).toContain('**ncbi** (read only) — PubMed.');
    expect(text).toContain('**zenodo** (read & write)');
    expect(text).not.toContain('hidden');
  });

  it('never contains a credential', () => {
    const text = buildApiGuidance([api({ auth: { style: 'bearer', secret: 'SUPERSECRET' } })])!;
    expect(text).not.toContain('SUPERSECRET');
  });
});

describe('API_CATALOG', () => {
  it('is internally consistent and passes its own validator', () => {
    const ids = new Set<string>();
    for (const entry of API_CATALOG) {
      const built = apiFromCatalog(entry);
      expect(validateApi(built, [...ids])).toEqual({ ok: true });
      expect(ids.has(built.id)).toBe(false);
      ids.add(built.id);
      // Every entry must resolve its own base URL to itself.
      expect(resolveTargetUrl(built, '').ok).toBe(true);
    }
  });

  it('ships every entry read-only', () => {
    // The write gate is only meaningful if nothing arrives with it pre-opened.
    for (const entry of API_CATALOG) {
      expect(apiFromCatalog(entry).allowWrites).toBe(false);
    }
  });

  it('carries no credential', () => {
    for (const entry of API_CATALOG) {
      expect(apiFromCatalog(entry).auth.secret).toBeUndefined();
    }
  });

  it('includes hex pointed at the REST API, not the MCP endpoint', () => {
    const hex = API_CATALOG.find((e) => e.catalogId === 'hex')!;
    expect(hex.baseUrl).toBe('https://app.hex.tech/api/v1/');
    expect(hex.baseUrl).not.toContain('/mcp');
    expect(hex.auth.style).toBe('bearer');
  });
});
