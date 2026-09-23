import {
  DESIGN_LOGIN_ENV_STRIP,
  buildDesignLoginEnv,
  claudeBinaryCandidates,
  encodeManualCode,
  pageToOpen,
  parseDesignLoginLine,
  parseDesignStatusLine,
} from '../claudeDesign';

describe('parseDesignStatusLine', () => {
  it('parses the line the bundled CLI (2.1.280) actually prints', () => {
    expect(parseDesignStatusLine('{"available":true,"signed_in":false,"can_sign_in_here":true}')).toEqual({
      available: true,
      signedIn: false,
      canSignInHere: true,
    });
  });

  it('keeps the reason when sign-in is not possible here', () => {
    expect(
      parseDesignStatusLine(
        '{"available":true,"signed_in":false,"can_sign_in_here":false,"reason":"The Claude Design sign-in is not configured in this build."}',
      ),
    ).toEqual({
      available: true,
      signedIn: false,
      canSignInHere: false,
      reason: 'The Claude Design sign-in is not configured in this build.',
    });
  });

  it('rejects non-status lines instead of guessing', () => {
    expect(parseDesignStatusLine('')).toBeNull();
    expect(parseDesignStatusLine('Error: something')).toBeNull();
    expect(parseDesignStatusLine('{"available":"yes"}')).toBeNull();
    expect(parseDesignStatusLine('[1,2]')).toBeNull();
  });
});

describe('parseDesignLoginLine', () => {
  it('turns a pages event into a waiting state', () => {
    expect(
      parseDesignLoginLine('{"event":"pages","url":"https://claude.ai/a","manual_url":"https://claude.ai/b","manual_first":false}'),
    ).toEqual({ state: 'waiting', url: 'https://claude.ai/a', manualUrl: 'https://claude.ai/b', manualFirst: false });
  });

  it('parses success and failure', () => {
    expect(parseDesignLoginLine('{"event":"done","ok":true}')).toEqual({ state: 'done', ok: true });
    expect(
      parseDesignLoginLine('{"event":"done","ok":false,"message":"The browser sign-in timed out after five minutes. Try again."}'),
    ).toEqual({ state: 'done', ok: false, message: 'The browser sign-in timed out after five minutes. Try again.' });
  });

  it('never reads a failure as success, even without a message', () => {
    expect(parseDesignLoginLine('{"event":"done"}')).toEqual({ state: 'done', ok: false, message: 'The sign-in failed.' });
  });

  it('ignores lines that are not protocol events', () => {
    expect(parseDesignLoginLine('warming up…')).toBeNull();
    expect(parseDesignLoginLine('{"event":"telemetry"}')).toBeNull();
    expect(parseDesignLoginLine('{"event":"pages"}')).toBeNull();
  });
});

describe('pageToOpen', () => {
  const base = { state: 'waiting' as const, url: 'https://auto', manualUrl: 'https://manual' };

  it('opens the automatic page by default', () => {
    expect(pageToOpen({ ...base, manualFirst: false })).toBe('https://auto');
  });

  it('opens the code page first when the CLI says the callback will not land', () => {
    expect(pageToOpen({ ...base, manualFirst: true })).toBe('https://manual');
  });

  it('falls back to the automatic page when there is no manual one', () => {
    expect(pageToOpen({ ...base, manualUrl: null, manualFirst: true })).toBe('https://auto');
  });
});

describe('encodeManualCode', () => {
  it('writes one JSON line the CLI can split on #', () => {
    expect(encodeManualCode('  abc#state123 \n')).toBe('{"code":"abc#state123"}\n');
  });

  it('refuses an empty code', () => {
    expect(encodeManualCode('   ')).toBeNull();
  });
});

describe('buildDesignLoginEnv', () => {
  it('points the CLI at the agent config dir and strips the parent-session markers', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/wrong', HOME: '/Users/x' };
    for (const key of DESIGN_LOGIN_ENV_STRIP) base[key] = '1';

    const env = buildDesignLoginEnv(base, '/userData/claude-config');

    expect(env.CLAUDE_CONFIG_DIR).toBe('/userData/claude-config');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/x');
    // The two the CLI actually checks in isSpawnedByClaudeCodeSession.
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    for (const key of DESIGN_LOGIN_ENV_STRIP) expect(env[key]).toBeUndefined();
  });

  it('does not mutate the environment it was given', () => {
    const base: NodeJS.ProcessEnv = { CLAUDECODE: '1' };
    buildDesignLoginEnv(base, '/x');
    expect(base.CLAUDECODE).toBe('1');
  });
});

describe('claudeBinaryCandidates', () => {
  const opts = { resourcesPath: '/App/Contents/Resources', appPath: '/repo', platform: 'darwin', arch: 'arm64' };

  it('uses the unpacked asar copy when packaged', () => {
    expect(claudeBinaryCandidates({ ...opts, isPackaged: true })).toEqual([
      '/App/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    ]);
  });

  it('uses the repo node_modules in dev', () => {
    expect(claudeBinaryCandidates({ ...opts, isPackaged: false })).toEqual([
      '/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    ]);
  });
});
