import { API_CATALOG, interpretApiTest } from '../apis';

/**
 * Driven from REAL status pairs, measured against the live catalog on
 * 2026-09-17 with and without a credential. The old Test forwarded the raw
 * authenticated status, which is wrong in both directions, and each case
 * below is one of the ways it was wrong.
 */

describe('interpretApiTest', () => {
  test('a 200 that anyone can get is NOT a passing key test', () => {
    // GitHub's root and OSF's root both answer 200 with no credential at all.
    // The old button called this success, so an API with a garbage key — or
    // no key — tested green.
    const r = interpretApiTest({ authedStatus: 200, unauthedStatus: 200, hasSecret: true });
    expect(r.verdict).toBe('unconfirmed');
    expect(r.detail).toContain('without your key');
  });

  test('a 200 where anonymous gets 401 IS a passing key test', () => {
    // The curated testPaths (hex /projects, github /user, osf /users/me/ …)
    // are chosen precisely to produce this pair.
    const r = interpretApiTest({ authedStatus: 200, unauthedStatus: 401, hasSecret: true });
    expect(r.verdict).toBe('ok');
    expect(r.detail).toContain('accepted your credential');
  });

  test('a 404 where anonymous gets 401 is a PASS, not a failure', () => {
    // The exact case that started this: the server authenticated the caller
    // and then said the resource does not exist. The old button showed "404"
    // and the user reasonably read it as broken.
    const r = interpretApiTest({ authedStatus: 404, unauthedStatus: 401, hasSecret: true });
    expect(r.verdict).toBe('ok');
    expect(r.detail).toContain('authenticated you');
  });

  test('401 and 403 are the one actionable failure, and say which', () => {
    const rejected = interpretApiTest({ authedStatus: 401, hasSecret: true });
    expect(rejected.verdict).toBe('unauthorized');
    expect(rejected.detail).toContain('rejected the credential');

    const missing = interpretApiTest({ authedStatus: 403, hasSecret: false });
    expect(missing.verdict).toBe('unauthorized');
    expect(missing.detail).toContain('needs a credential');
  });

  test('an auth failure outranks whatever the anonymous probe said', () => {
    // 403-for-everyone must still read as an auth problem, not "inconclusive".
    const r = interpretApiTest({ authedStatus: 403, unauthedStatus: 403, hasSecret: true });
    expect(r.verdict).toBe('unauthorized');
  });

  test('no response is reported as unreachable, never as a failed key', () => {
    const r = interpretApiTest({ authedStatus: 0, hasSecret: true });
    expect(r.verdict).toBe('unreachable');
  });

  test('a keyless API is never described as having had its key checked', () => {
    const optional = interpretApiTest({ authedStatus: 200, hasSecret: false, secretOptional: true });
    expect(optional.verdict).toBe('ok');
    expect(optional.detail).toContain('without a key');

    const none = interpretApiTest({ authedStatus: 200, hasSecret: false });
    expect(none.verdict).toBe('ok');
    expect(none.detail).toContain('none was tested');
  });

  test('rate limiting is named, not reported as a bare status', () => {
    // Observed live against Crossref. "HTTP 429" alone sends the user looking
    // for a config fault that does not exist.
    const r = interpretApiTest({ authedStatus: 429, hasSecret: false });
    expect(r.verdict).toBe('unconfirmed');
    expect(r.detail).toContain('rate-limiting');
  });

  test('a 404 for everyone is honest about telling us nothing', () => {
    // Hex/Zenodo/Figshare at their bare base URL, which is what a CUSTOM API
    // with no curated testPath will usually look like.
    const r = interpretApiTest({ authedStatus: 404, unauthedStatus: 404, hasSecret: true });
    expect(r.verdict).toBe('unconfirmed');
    expect(r.detail).toContain('cannot confirm');
  });
});

describe('curated test paths', () => {
  test('every testPath is relative, read-only-looking, and on a credentialed API', () => {
    const withPath = API_CATALOG.filter((c) => c.testPath);
    expect(withPath.length).toBeGreaterThan(0);
    for (const c of withPath) {
      // Relative: `resolveTargetUrl` joins it onto baseUrl, and an absolute
      // URL there would win at parse time and silently leave the API.
      expect(c.testPath!.startsWith('/')).toBe(false);
      expect(c.testPath).not.toMatch(/^https?:/);
      // A test path only earns its place on an API that HAS a credential to
      // check — otherwise the base URL is fine.
      expect(c.auth.style).not.toBe('none');
    }
  });
});
