/**
 * Fail-closed verification of Cloudflare Access's `Cf-Access-Jwt-Assertion`.
 *
 * Runs inside a Cloudflare Worker (see `docs/design/sharing.md` -> Auth), so
 * this file is WebCrypto-only: `SubtleCrypto`, `atob`, `TextEncoder`/
 * `TextDecoder`, `fetch`. No `Buffer`, no Node imports — Workers have neither.
 *
 * `verifyAccessJwt` is deliberately picky about *why* a token was rejected
 * (see `VerifyResult['reason']`) because the caller (W4's route handler) needs
 * to distinguish "unknown kid" — which means the JWKS cache is stale and is
 * worth one retry after `invalidate()` — from every other rejection, which
 * means the request is simply unauthenticated.
 */

export interface Jwks {
  keys: Array<{ kid: string; kty: string; n: string; e: string; alg?: string }>;
}

export type VerifyResult = { ok: true; email: string | null } | { ok: false; reason: string };

interface AccessClaims {
  aud?: unknown;
  iss?: unknown;
  exp?: unknown;
  email?: unknown;
}

interface AccessHeader {
  alg?: unknown;
  kid?: unknown;
}

const CF_AUTHORIZATION_COOKIE = 'CF_Authorization';

/**
 * Base64url decode without Node's `Buffer` — pad back to a multiple of 4,
 * swap the URL-safe characters for the standard alphabet, then hand the
 * result to `atob`. Returns raw bytes so callers can feed them straight to
 * `TextDecoder` (JSON parts) or `SubtleCrypto.verify` (the signature).
 *
 * Return type is explicitly `Uint8Array<ArrayBuffer>`, not the bare
 * `Uint8Array` (which TypeScript 5.9's DOM lib widens to
 * `Uint8Array<ArrayBufferLike>`) — `SubtleCrypto.verify`'s `BufferSource`
 * parameter requires the narrower type. Same fix as `apiProxy.ts`'s
 * `ApiRequestBody`.
 */
function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(padLength);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtJsonPart<T>(part: string): T {
  const bytes = base64UrlDecode(part);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

function audienceList(aud: unknown): string[] {
  if (Array.isArray(aud)) return aud.filter((v): v is string => typeof v === 'string');
  if (typeof aud === 'string') return [aud];
  return [];
}

/**
 * Verify a Cloudflare Access JWT: structure, `alg`, signature against the
 * team's JWKS, `exp`, `iss`, then `aud`. Every failure mode gets its own
 * `reason` string (checked in this order) rather than a boolean, per the
 * ticket spec.
 */
export async function verifyAccessJwt(
  token: string,
  opts: { jwks: Jwks; aud: string; issuer: string; nowSeconds?: number; subtle?: SubtleCrypto }
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'Malformed token' };
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: AccessHeader;
  let payload: AccessClaims;
  try {
    header = decodeJwtJsonPart<AccessHeader>(headerB64);
    payload = decodeJwtJsonPart<AccessClaims>(payloadB64);
  } catch {
    return { ok: false, reason: 'Malformed token' };
  }

  if (header.alg !== 'RS256') {
    return { ok: false, reason: 'Unsupported algorithm' };
  }

  const kid = header.kid;
  const key = typeof kid === 'string' ? opts.jwks.keys.find((k) => k.kid === kid) : undefined;
  if (!key) {
    return { ok: false, reason: 'Unknown key id' };
  }

  const subtle = opts.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) {
    return { ok: false, reason: 'No WebCrypto implementation available' };
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await subtle.importKey(
      'jwk',
      { kty: key.kty, n: key.n, e: key.e, alg: key.alg ?? 'RS256', ext: true } as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
  } catch {
    // A key whose JWK shape `importKey` refuses is, from the caller's point of
    // view, indistinguishable from a key that isn't there — both mean "the
    // cache doesn't have anything usable for this kid" and warrant the same
    // invalidate-and-retry response.
    return { ok: false, reason: 'Unknown key id' };
  }

  let signatureValid = false;
  try {
    signatureValid = await subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      cryptoKey,
      base64UrlDecode(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, reason: 'Bad signature' };
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    return { ok: false, reason: 'Token expired' };
  }

  if (payload.iss !== opts.issuer) {
    return { ok: false, reason: 'Issuer mismatch' };
  }

  if (!audienceList(payload.aud).includes(opts.aud)) {
    return { ok: false, reason: 'Audience mismatch' };
  }

  const email = typeof payload.email === 'string' ? payload.email : null;
  return { ok: true, email };
}

/**
 * The header Cloudflare Access sets on every proxied request. Falls back to
 * the `CF_Authorization` cookie Access also sets, for a request that reaches
 * the Worker without going back through the edge proxy layer (e.g. a
 * same-origin asset fetch replaying the browser's own cookies).
 */
export function extractAccessToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;

  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const prefix = `${CF_AUTHORIZATION_COOKIE}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

/**
 * Caches the team's JWKS for `ttlMs` (default 1h — certs rotate rarely and a
 * fetch on every request would be wasteful). `invalidate()` is what a caller
 * uses after an "Unknown key id" result to force one refetch-and-retry,
 * covering key rotation without waiting out the TTL.
 *
 * `nowMs` is not part of the ticket's contract signature — added so the TTL
 * behaviour can be tested deterministically instead of sleeping in real time;
 * every real caller can omit it and get `Date.now`.
 */
export function createJwksCache(
  fetchImpl: typeof fetch,
  teamDomain: string,
  ttlMs: number = 60 * 60 * 1000,
  nowMs: () => number = Date.now
): { get(): Promise<Jwks>; invalidate(): void } {
  let cached: { jwks: Jwks; fetchedAt: number } | null = null;
  let pending: Promise<Jwks> | null = null;

  async function fetchJwks(): Promise<Jwks> {
    const response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }
    return (await response.json()) as Jwks;
  }

  return {
    async get(): Promise<Jwks> {
      if (cached && nowMs() - cached.fetchedAt < ttlMs) {
        return cached.jwks;
      }
      if (!pending) {
        pending = fetchJwks()
          .then((jwks) => {
            cached = { jwks, fetchedAt: nowMs() };
            pending = null;
            return jwks;
          })
          .catch((err) => {
            pending = null;
            throw err;
          });
      }
      return pending;
    },
    invalidate(): void {
      cached = null;
      pending = null;
    },
  };
}
