/**
 * Entry point for `acabox-share`. The real routing (C5) — Access gating via
 * `accessJwt.ts`, the listing page, and serving R2 objects — lives in
 * `routes.ts` (W4); this module's only job is to own the one piece of state
 * that has to live outside a single request: the JWKS cache.
 *
 * The cache is created lazily, on first request, rather than at module scope
 * unconditionally — `env` (and therefore `ACCESS_TEAM_DOMAIN`) is only
 * available inside `fetch`, not at module evaluation time. It's keyed by team
 * domain (belt-and-braces: a Worker only ever runs with one `wrangler.toml`,
 * so the domain can't actually change between requests in the same isolate,
 * but re-keying costs nothing and means a changed var can never serve a
 * stale cache).
 */

import type { WebEnv } from '../../shared/bucket';
import { createJwksCache, type Jwks } from './accessJwt';
import { handleWebRequest } from './routes';

let cachedTeamDomain: string | null = null;
let jwksCache: { get(): Promise<Jwks>; invalidate(): void } | null = null;

function jwksCacheFor(teamDomain: string): { get(): Promise<Jwks>; invalidate(): void } {
  if (!jwksCache || cachedTeamDomain !== teamDomain) {
    jwksCache = createJwksCache(fetch, teamDomain);
    cachedTeamDomain = teamDomain;
  }
  return jwksCache;
}

export default {
  fetch(request: Request, env: WebEnv): Promise<Response> {
    return handleWebRequest(request, env, { jwksCache: jwksCacheFor(env.ACCESS_TEAM_DOMAIN) });
  },
};
