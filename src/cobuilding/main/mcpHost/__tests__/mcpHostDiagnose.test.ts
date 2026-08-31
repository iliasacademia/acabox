/** @jest-environment node */
/**
 * `diagnose()` is pure — no process, no clock, no filesystem — so most cases
 * below are ordinary unit tests against crafted `DiagnoseInput`s. The one
 * exception is the stdout-framing-corruption case (R8's "#1 real-world
 * stdio MCP bug"), which is driven against the REAL `--noisy` fixture rather
 * than a hand-written string: the exact wording of a `JSON.parse` failure is
 * a V8 implementation detail, and asserting against a guess at that wording
 * would only prove this file agrees with itself. `electron`/`electron-log`
 * are not imported by `diagnose.ts` at all (it only reads `hostedEnv.ts`'s
 * `lastHostedPathResolution()`, a plain in-memory getter), so there is
 * nothing to mock per house doctrine.
 */
import * as path from 'path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { diagnose } from '../diagnose';
import { buildHostedEnv } from '../hostedEnv';

const fixture = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'echoMcpServer.mjs');

describe('diagnose — native module ABI mismatch', () => {
  it('names NODE_MODULE_VERSION mismatches as a compiled add-on for the wrong Node', () => {
    const msg = diagnose({
      command: 'some-server',
      error: new Error(
        'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127.',
      ),
    });
    expect(msg).toMatch(/compiled add-on built for a different version of Node/);
    expect(msg).toMatch(/cannot rebuild it/);
  });

  it('also recognizes ERR_DLOPEN_FAILED by code, without the NODE_MODULE_VERSION string present', () => {
    const err = Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' });
    const msg = diagnose({ command: 'some-server', error: err });
    expect(msg).toMatch(/compiled add-on built for a different version of Node/);
  });
});

describe('diagnose — stdout framing corruption (R8, driven for real)', () => {
  it('names the offending output captured from a real --noisy fixture', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture, '--noisy'],
      stderr: 'pipe',
      env: buildHostedEnv({ env: { ELECTRON_RUN_AS_NODE: '1' } }),
    });
    const client = new Client({ name: 'acabox-test', version: '0.0.0' });

    let captured: Error | undefined;
    client.onerror = (err) => { captured = err; };

    try {
      await client.connect(transport);
      // The noisy fixture pollutes stdout on the FIRST call to `echo`, not at
      // startup — the framing corruption is a side effect of the tool
      // running, matching how a real chatty server actually misbehaves.
      await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      // Give the corrupted line's parse failure a tick to reach `onerror` —
      // it is queued ahead of the real response in the same stdout stream,
      // so by the time `callTool` resolves the parse error has already fired.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      await transport.close();
    }

    expect(captured).toBeDefined();
    const msg = diagnose({ command: fixture, error: captured });
    expect(msg).toMatch(/printed/);
    expect(msg).toMatch(/log to stderr instead/);
    // The real offending text (or its V8-truncated snippet) is named, not
    // just gestured at.
    expect(msg).toMatch(/this line/);
  }, 15000);
});

describe('diagnose — command resolution failures', () => {
  it('ENOENT: names the command and says it could not be found', () => {
    const err = Object.assign(new Error('spawn totally-bogus-cmd ENOENT'), { code: 'ENOENT' });
    const msg = diagnose({ command: 'totally-bogus-cmd', error: err });
    expect(msg).toContain('totally-bogus-cmd');
    expect(msg).toMatch(/could not find/);
  });

  it('EACCES: says the command is not executable', () => {
    const err = Object.assign(new Error('spawn /tmp/not-executable EACCES'), { code: 'EACCES' });
    const msg = diagnose({ command: '/tmp/not-executable', error: err });
    expect(msg).toContain('/tmp/not-executable');
    expect(msg).toMatch(/not executable/);
  });
});

describe('diagnose — exit 127 (interpreter missing), combined with the PATH resolution flag', () => {
  // Both sub-tests below use `jest.isolateModules` for a FRESH `hostedEnv`
  // (and, transitively, a fresh `shellPath`) module registry, rather than
  // this file's top-level import. `shellPath.ts` caches a successful
  // resolution at module scope forever — and the framing-corruption test
  // above already forced one real success against THIS file's shared
  // top-level import, to get a working spawn env for the fixture. Reusing
  // that same import here would mean `lastHostedPathResolution()` is
  // already permanently `resolved:true` by the time these run, regardless
  // of what `SHELL` is set to — isolating the registry is what makes each
  // of these two states (never-resolved, and resolution-failed) genuinely
  // reproducible rather than an artifact of test order.

  it('before any PATH resolution has ever been recorded, gives the generic interpreter-missing message with no PATH claim', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { diagnose: freshDiagnose } = require('../diagnose');
      const msg = freshDiagnose({ command: 'shebang-script', exitCode: 127 });
      expect(msg).toMatch(/exited immediately \(127\)/);
      expect(msg).toMatch(/interpreter it needs was not found/);
      expect(msg).not.toMatch(/could not read your login shell/);
    });
  });

  it('when Acabox could not read the login shell\'s PATH, says so and names the PATH it actually used — the R8 payoff for lastHostedPathResolution', () => {
    const savedShell = process.env.SHELL;
    process.env.SHELL = '/bin/definitely-not-a-real-shell-acabox-test';
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { buildHostedEnv: freshBuildHostedEnv } = require('../hostedEnv');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { diagnose: freshDiagnose } = require('../diagnose');
        // Forces a resolution attempt on this fresh registry; the bogus
        // SHELL makes it fail, so `lastHostedPathResolution()` records
        // `resolved:false` and serves the `process.env.PATH` fallback —
        // exactly the "works in Terminal, 127 from the Dock" case this
        // message exists to explain.
        const env = freshBuildHostedEnv({ env: {} });
        const msg = freshDiagnose({ command: 'shebang-script', exitCode: 127 });
        expect(msg).toMatch(/could not read your login shell's PATH/);
        expect(msg).toContain(env.PATH); // names the ACTUAL path used, not a placeholder
      });
    } finally {
      process.env.SHELL = savedShell;
    }
  }, 10000);
});

describe('diagnose — handshake timeout', () => {
  it('with a live pid, suggests a password or browser sign-in prompt rather than inventing a cause', () => {
    const msg = diagnose({ command: 'oauth-server', timedOut: true, hadPid: true });
    expect(msg).toMatch(/never answered/);
    expect(msg).toMatch(/password or a browser sign-in/);
  });
});

describe('diagnose — a non-zero exit with no other evidence', () => {
  it('exited immediately and said nothing, when stderr is empty and it happened fast', () => {
    const msg = diagnose({ command: 'flaky-server', exitCode: 1, elapsedMs: 50, stderrTail: '' });
    expect(msg).toMatch(/Exited immediately and said nothing/);
    expect(msg).toContain('1');
  });

  it('shows the real stderr tail rather than inventing a cause, when there is one', () => {
    const msg = diagnose({
      command: 'flaky-server',
      exitCode: 1,
      elapsedMs: 50,
      stderrTail: 'Error: missing required config file\n',
    });
    expect(msg).toMatch(/missing required config file/);
    expect(msg).not.toMatch(/said nothing/);
  });

  it('falls back to the raw error message when there is truly nothing else to show', () => {
    const msg = diagnose({ command: 'mystery-server', error: new Error('boom') });
    expect(msg).toContain('mystery-server');
    expect(msg).toContain('boom');
  });
});
