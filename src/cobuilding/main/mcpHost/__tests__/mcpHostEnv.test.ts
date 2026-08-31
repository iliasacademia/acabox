/** @jest-environment node */
/**
 * `buildHostedEnv` is the credential-leak fix (design:
 * `docs/design/mcp-hosting.md`, Increment 2): a hosted server's env is built
 * from an allowlist, never from spreading `process.env` and stripping. The
 * important test here is negative — proving a value is ABSENT is exactly the
 * kind of thing a hand-written allowlist can quietly stop doing (the next
 * person adds a spread "just for this one case" and the leak is back), so
 * these assertions check actual VALUES in the output, not just which keys the
 * allowlist names.
 *
 * No mocks: `buildHostedEnv` calls the real `getLoginShellPath()`, which
 * spawns a real login shell the first time it's asked (mocking it would only
 * prove this file agrees with a fake). `electron`/`electron-log` are not
 * imported by `hostedEnv.ts` at all, so there is nothing to mock per house
 * doctrine either.
 */
import { buildHostedEnv, HOSTED_ENV_ALLOWLIST, lastHostedPathResolution } from '../hostedEnv';

/** Secrets this app actually holds, or paths/flags that would identify the
 *  host environment — exactly the class of thing the design doc calls out by
 *  name as what today's spread-and-strip connector leaks. */
const CANARIES: Record<string, string> = {
  ANTHROPIC_API_KEY: 'canary-sk-ANTHROPIC-DO-NOT-LEAK-8f2a',
  ANTHROPIC_AUTH_TOKEN: 'canary-AUTH-TOKEN-b91c',
  ANTHROPIC_BASE_URL: 'https://canary-anthropic.example/v1',
  ACABOX_API_TOKEN: 'canary-ACABOX-TOKEN-4d7e',
  ACABOX_API_BASE: 'https://canary-acabox.example',
  COSCIENTIST_WORKSPACE: '/canary/workspace-root',
  COSCIENTIST_VENV_DIR: '/canary/python-venv',
  COSCIENTIST_NPM_PREFIX: '/canary/npm-site',
  COSCIENTIST_AGENT_PORT: '23299',
  COSCIENTIST_AGENT_INSTANCE: 'canary-instance-id',
  CLAUDE_CONFIG_DIR: '/canary/claude-config-dir',
  ELECTRON_RUN_AS_NODE: 'canary-electron-flag',
  NODE_PATH: '/canary/shadow-node-modules',
  npm_config_registry: 'https://canary-npm.example',
  npm_lifecycle_event: 'canary-lifecycle-event',
  GITHUB_TOKEN: 'canary-ghp-GITHUB-TOKEN-91aa',
};

/** Every var the allowlist names, set to a deterministic, non-secret value so
 *  the "key set equals allowlist ∪ record env" assertion doesn't depend on
 *  which of these happen to be set on whatever machine runs this test. */
const ALLOWLIST_BASELINE: Record<string, string> = {
  HOME: '/Users/allowlist-baseline',
  LOGNAME: 'baseline-user',
  PATH: '/canary/should-be-overridden-not-leaked', // see the PATH-specific test below
  SHELL: '/bin/baseline-sh',
  TERM: 'xterm-baseline',
  USER: 'baseline-user',
  TMPDIR: '/tmp/baseline',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  TZ: 'UTC',
};

describe('buildHostedEnv', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    for (const [key, value] of Object.entries({ ...CANARIES, ...ALLOWLIST_BASELINE })) {
      process.env[key] = value;
    }
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('never leaks any canary secret into the built env, as a substring of any value', () => {
    const env = buildHostedEnv({ env: {} });
    const values = Object.values(env);
    for (const [name, secret] of Object.entries(CANARIES)) {
      const leaked = values.some((v) => v.includes(secret));
      expect(leaked).toBe(false); // checking VALUES, not key names, on purpose — see the header
      if (leaked) throw new Error(`${name}'s canary value leaked into buildHostedEnv's output`);
    }
  });

  it('the output key set is exactly the allowlist union the record\'s own env keys', () => {
    const env = buildHostedEnv({ env: { CUSTOM_ONE: 'a', CUSTOM_TWO: 'b' } });
    const expected = new Set([...HOSTED_ENV_ALLOWLIST, 'CUSTOM_ONE', 'CUSTOM_TWO']);
    expect(new Set(Object.keys(env))).toEqual(expected);
  });

  it('never carries a process.env var the allowlist does not name', () => {
    process.env.SOME_RANDOM_UNRELATED_HOST_VAR = 'should-not-appear';
    const env = buildHostedEnv({ env: {} });
    expect('SOME_RANDOM_UNRELATED_HOST_VAR' in env).toBe(false);
  });

  it('layers the record\'s own env last, letting it override an allowlisted key', () => {
    const env = buildHostedEnv({ env: { TZ: 'Pacific/Auckland' } });
    expect(env.TZ).toBe('Pacific/Auckland');
  });

  it('routes PATH through getLoginShellPath and reports whether that resolution succeeded', () => {
    // `SHELL` is the bogus `/bin/baseline-sh` from ALLOWLIST_BASELINE, so the
    // login-shell spawn genuinely fails here and `getLoginShellPath()` serves
    // its documented `process.env.PATH` fallback.
    //
    // The obvious assertion — "PATH must not equal process.env.PATH" — is
    // WRONG, and asserting it is how this test failed when first written: in
    // the fallback case PATH *is* process.env.PATH, legitimately, because
    // there is nothing better to serve. The property that actually matters is
    // not which string comes out, it is whether the caller can TELL. A silent
    // fallback is what turns "works in Terminal, exit 127 from the Dock" into
    // an unattributable bug, since launchd's PATH omits /opt/homebrew/bin and
    // there is no /usr/bin/node.
    const env = buildHostedEnv({ env: {} });
    expect(typeof env.PATH).toBe('string');
    expect(env.PATH.length).toBeGreaterThan(0);

    const resolution = lastHostedPathResolution();
    expect(resolution).not.toBeNull();
    // Whatever landed in the env is exactly what we reported — a supervisor
    // surfacing this on a failed spawn must not be describing a different PATH
    // from the one the child actually got.
    expect(resolution!.path).toBe(env.PATH);
    // The bogus SHELL means this run took the fallback branch, and says so.
    expect(resolution!.resolved).toBe(false);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('HOSTED_ENV_ALLOWLIST is the SDK\'s own DEFAULT_INHERITED_ENV_VARS plus the four documented extras', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEFAULT_INHERITED_ENV_VARS } = require('@modelcontextprotocol/sdk/client/stdio.js');
    expect(HOSTED_ENV_ALLOWLIST).toEqual([...DEFAULT_INHERITED_ENV_VARS, 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']);
  });
});
