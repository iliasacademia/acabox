/**
 * Regression for the 2026-09-01 funnel run's second finding: a valid API key
 * pasted into Settings was stored correctly and pushed successfully, and the
 * very next turn still returned `authentication_error`. Only restarting the
 * app fixed it, and nothing in the UI hinted at that — the first thing a new
 * user does, failing in the way most likely to be read as "my key is bad".
 *
 * `POST /credentials` updated only the server-wide `currentConfig`, the
 * template for FUTURE sessions. A live session held its own merged copy and
 * kept the stale key for life, including across the 401 retry that exists
 * precisely to pick up a refreshed credential.
 *
 * Driving `applyCredentialsToSessions` from `../sessionConfig` — the real
 * production function. It lives there rather than in `index.ts` because that
 * file cannot be imported under Jest (the Agent SDK is ESM-only), the same
 * constraint `dynamicMcp.ts` was carved out for.
 */
/** @jest-environment node */
import { applyCredentialsToSessions, type CredentialTarget } from '../sessionConfig';

const session = (apiKey?: string, baseURL?: string): CredentialTarget =>
  ({ sessionConfig: { anthropicApiKey: apiKey as string, anthropicBaseURL: baseURL } });

describe('applyCredentialsToSessions', () => {
  it('repoints a session that already exists — the whole bug', () => {
    const live = session('sk-stale');
    expect(applyCredentialsToSessions([live], { anthropicApiKey: 'sk-fresh' })).toBe(1);
    expect(live.sessionConfig!.anthropicApiKey).toBe('sk-fresh');
  });

  it('mutates in place, because startQuery closes over the same object', () => {
    const cfg = { anthropicApiKey: 'sk-stale', anthropicBaseURL: undefined };
    applyCredentialsToSessions([{ sessionConfig: cfg }], { anthropicApiKey: 'sk-fresh' });
    // Holding the inner object, as the closure does — a replaced object would
    // leave this reading the old key.
    expect(cfg.anthropicApiKey).toBe('sk-fresh');
  });

  it('reaches every live session, not just the first', () => {
    const all = [session('a'), session('b'), session('c')];
    expect(applyCredentialsToSessions(all, { anthropicApiKey: 'sk-fresh' })).toBe(3);
    expect(all.map((s) => s.sessionConfig!.anthropicApiKey)).toEqual(['sk-fresh', 'sk-fresh', 'sk-fresh']);
  });

  it('a base-URL-only push must NOT blank the key', () => {
    const live = session('sk-keep', 'https://old.example');
    applyCredentialsToSessions([live], { anthropicBaseURL: 'https://new.example' });
    expect(live.sessionConfig!.anthropicApiKey).toBe('sk-keep');
    expect(live.sessionConfig!.anthropicBaseURL).toBe('https://new.example');
  });

  it('an explicit null base URL clears one — presence, not truthiness', () => {
    // updateAgentCredentials sends `null` (not undefined) precisely so the
    // field survives JSON.stringify and can express "clear it".
    const live = session('sk-keep', 'https://old.example');
    applyCredentialsToSessions([live], { anthropicBaseURL: null });
    expect(live.sessionConfig!.anthropicBaseURL).toBeUndefined();
    expect(live.sessionConfig!.anthropicApiKey).toBe('sk-keep');
  });

  it('an empty or absent key is not a credential — leaves the session alone', () => {
    const live = session('sk-keep');
    expect(applyCredentialsToSessions([live], {})).toBe(0);
    expect(applyCredentialsToSessions([live], { anthropicApiKey: '' })).toBe(0);
    expect(live.sessionConfig!.anthropicApiKey).toBe('sk-keep');
  });

  it('skips a session with no config rather than throwing', () => {
    const all: CredentialTarget[] = [{}, session('old')];
    expect(applyCredentialsToSessions(all, { anthropicApiKey: 'sk-fresh' })).toBe(1);
    expect(all[1].sessionConfig!.anthropicApiKey).toBe('sk-fresh');
  });

  it('handles no live sessions — the common case, and must not throw', () => {
    expect(applyCredentialsToSessions([], { anthropicApiKey: 'sk-fresh' })).toBe(0);
  });
});
