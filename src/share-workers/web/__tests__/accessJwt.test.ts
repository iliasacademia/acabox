/**
 * @jest-environment node
 *
 * `accessJwt` exercised against a REAL RSA-2048 key pair: a JWKS is built from
 * an exported public JWK, tokens are signed with the private key via
 * `globalThis.crypto.subtle`, and `verifyAccessJwt` is handed that same
 * `subtle` instance — nothing about signing or verifying is mocked, only the
 * network fetch behind `createJwksCache`.
 */
import { verifyAccessJwt, extractAccessToken, createJwksCache, type Jwks } from '../src/accessJwt';

const ISSUER = 'https://acabox-share.cloudflareaccess.com';
const AUD = 'test-application-audience';
const TEAM_DOMAIN = 'acabox-share.cloudflareaccess.com';
const subtle = globalThis.crypto.subtle;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  ) as Promise<CryptoKeyPair>;
}

async function jwksFor(publicKey: CryptoKey, kid: string): Promise<Jwks> {
  const jwk = await subtle.exportKey('jwk', publicKey);
  return { keys: [{ kid, kty: jwk.kty as string, n: jwk.n as string, e: jwk.e as string, alg: 'RS256' }] };
}

/** Signs `header.payload` with `privateKey`. Callers pass whatever header/payload they want tested. */
async function signToken(header: unknown, payload: unknown, privateKey: CryptoKey): Promise<string> {
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = await subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    aud: [AUD],
    iss: ISSUER,
    exp: nowSeconds + 3600,
    email: 'ilias@academia.edu',
    ...overrides,
  };
}

describe('verifyAccessJwt', () => {
  let keyPair: CryptoKeyPair;
  let jwks: Jwks;

  beforeAll(async () => {
    keyPair = await generateKeyPair();
    jwks = await jwksFor(keyPair.publicKey, 'kid-1');
  });

  it('accepts a validly signed token and returns the email claim', async () => {
    const token = await signToken({ alg: 'RS256', kid: 'kid-1' }, validPayload(), keyPair.privateKey);
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result).toEqual({ ok: true, email: 'ilias@academia.edu' });
  });

  it('returns null email when the token carries none', async () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).email;
    const token = await signToken({ alg: 'RS256', kid: 'kid-1' }, payload, keyPair.privateKey);
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result).toEqual({ ok: true, email: null });
  });

  it('rejects a token that is not three dot-separated parts', async () => {
    const result = await verifyAccessJwt('not-a-jwt', { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result).toEqual({ ok: false, reason: expect.any(String) });
    expect(result.ok).toBe(false);
  });

  it('rejects an unsupported alg', async () => {
    const token = await signToken({ alg: 'HS256', kid: 'kid-1' }, validPayload(), keyPair.privateKey);
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/algorithm/i);
  });

  it('rejects an unknown kid', async () => {
    const token = await signToken({ alg: 'RS256', kid: 'kid-does-not-exist' }, validPayload(), keyPair.privateKey);
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/key id/i);
  });

  it('rejects a bad signature (tampered signature bytes)', async () => {
    const token = await signToken({ alg: 'RS256', kid: 'kid-1' }, validPayload(), keyPair.privateKey);
    const [h, p, sig] = token.split('.');
    // Flip the FIRST base64url character, not the last: an RSA-2048 signature
    // is 256 bytes, which isn't a multiple of 3, so the trailing base64url
    // group is partial and its low bits are unused padding — flipping the
    // last character there can decode to the identical byte and silently not
    // tamper anything. The first character sits in a fully-loaded group, so
    // changing it is guaranteed to change a real signature byte.
    const firstChar = sig[0];
    const replacement = firstChar === 'A' ? 'B' : 'A';
    const tamperedSig = replacement + sig.slice(1);
    const result = await verifyAccessJwt(`${h}.${p}.${tamperedSig}`, { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/signature/i);
  });

  it('rejects a signature produced by a different key than the one in the JWKS', async () => {
    const otherKeyPair = await generateKeyPair();
    // Same kid as the JWKS entry, but signed with a different private key.
    const token = await signToken({ alg: 'RS256', kid: 'kid-1' }, validPayload(), otherKeyPair.privateKey);
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/signature/i);
  });

  it('rejects an expired token', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { alg: 'RS256', kid: 'kid-1' },
      validPayload({ exp: nowSeconds - 10 }),
      keyPair.privateKey
    );
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle, nowSeconds });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/i);
  });

  it('rejects exp exactly equal to now (boundary is exclusive)', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { alg: 'RS256', kid: 'kid-1' },
      validPayload({ exp: nowSeconds }),
      keyPair.privateKey
    );
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle, nowSeconds });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/i);
  });

  it('rejects an issuer mismatch', async () => {
    const token = await signToken(
      { alg: 'RS256', kid: 'kid-1' },
      validPayload({ iss: 'https://someone-elses-team.cloudflareaccess.com' }),
      keyPair.privateKey
    );
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/issuer/i);
  });

  it('rejects an audience mismatch', async () => {
    const token = await signToken(
      { alg: 'RS256', kid: 'kid-1' },
      validPayload({ aud: ['some-other-application'] }),
      keyPair.privateKey
    );
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/audience/i);
  });

  it('accepts aud carried as a single string rather than an array', async () => {
    const token = await signToken({ alg: 'RS256', kid: 'kid-1' }, validPayload({ aud: AUD }), keyPair.privateKey);
    const result = await verifyAccessJwt(token, { jwks, aud: AUD, issuer: ISSUER, subtle });
    expect(result).toEqual({ ok: true, email: 'ilias@academia.edu' });
  });
});

describe('extractAccessToken', () => {
  it('reads the Cf-Access-Jwt-Assertion header when present', () => {
    const request = new Request('https://acabox-share.example.workers.dev/a/xyz/', {
      headers: { 'Cf-Access-Jwt-Assertion': 'header-token-value' },
    });
    expect(extractAccessToken(request)).toBe('header-token-value');
  });

  it('falls back to the CF_Authorization cookie when the header is absent', () => {
    const request = new Request('https://acabox-share.example.workers.dev/a/xyz/', {
      headers: { Cookie: 'other=1; CF_Authorization=cookie-token-value; another=2' },
    });
    expect(extractAccessToken(request)).toBe('cookie-token-value');
  });

  it('prefers the header over the cookie when both are present', () => {
    const request = new Request('https://acabox-share.example.workers.dev/a/xyz/', {
      headers: {
        'Cf-Access-Jwt-Assertion': 'header-token-value',
        Cookie: 'CF_Authorization=cookie-token-value',
      },
    });
    expect(extractAccessToken(request)).toBe('header-token-value');
  });

  it('returns null when neither the header nor the cookie is present', () => {
    const request = new Request('https://acabox-share.example.workers.dev/a/xyz/');
    expect(extractAccessToken(request)).toBeNull();
  });

  it('returns null when a cookie header exists but has no CF_Authorization entry', () => {
    const request = new Request('https://acabox-share.example.workers.dev/a/xyz/', {
      headers: { Cookie: 'unrelated=1; other=2' },
    });
    expect(extractAccessToken(request)).toBeNull();
  });
});

describe('createJwksCache', () => {
  function fakeJwks(tag: string): Jwks {
    return { keys: [{ kid: tag, kty: 'RSA', n: 'n', e: 'AQAB', alg: 'RS256' }] };
  }

  it('fetches once and serves the same object again within the TTL', async () => {
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      return new Response(JSON.stringify(fakeJwks(`fetch-${call}`)), { status: 200 });
    }) as unknown as typeof fetch;

    const cache = createJwksCache(fetchImpl, TEAM_DOMAIN, 60_000);
    const first = await cache.get();
    const second = await cache.get();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
    expect(second).toBe(first);
    expect(second.keys[0].kid).toBe('fetch-1');
  });

  it('refetches after invalidate()', async () => {
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      return new Response(JSON.stringify(fakeJwks(`fetch-${call}`)), { status: 200 });
    }) as unknown as typeof fetch;

    const cache = createJwksCache(fetchImpl, TEAM_DOMAIN, 60_000);
    const first = await cache.get();
    cache.invalidate();
    const second = await cache.get();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(first.keys[0].kid).toBe('fetch-1');
    expect(second.keys[0].kid).toBe('fetch-2');
  });

  it('refetches once the injected clock passes the TTL, with no invalidate() call', async () => {
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      return new Response(JSON.stringify(fakeJwks(`fetch-${call}`)), { status: 200 });
    }) as unknown as typeof fetch;

    let clock = 1_000_000;
    const cache = createJwksCache(fetchImpl, TEAM_DOMAIN, 1_000, () => clock);

    const first = await cache.get();
    clock += 500; // still inside the 1s TTL
    const second = await cache.get();
    clock += 600; // now 1100ms after the first fetch: past the TTL
    const third = await cache.get();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(first.keys[0].kid).toBe('fetch-1');
    expect(second.keys[0].kid).toBe('fetch-1');
    expect(third.keys[0].kid).toBe('fetch-2');
  });

  it('propagates a fetch failure and does not cache it', async () => {
    const fetchImpl = jest.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const cache = createJwksCache(fetchImpl, TEAM_DOMAIN, 60_000);

    await expect(cache.get()).rejects.toThrow(/Failed to fetch JWKS/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('concurrent get() calls before the fetch resolves share one in-flight request', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchImpl = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;

    const cache = createJwksCache(fetchImpl, TEAM_DOMAIN, 60_000);
    const p1 = cache.get();
    const p2 = cache.get();

    resolveFetch(new Response(JSON.stringify(fakeJwks('fetch-1')), { status: 200 }));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });
});
