/**
 * The safety hooks used to parse their payload with `jq`, which ships only on
 * macOS 15+. On 13/14 the script aborted with a non-2 status and the CLI read
 * that as "allow", so both guards were silently off. These run the REAL shipped
 * scripts under a PATH that contains no jq, and with no parser at all.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOOKS = path.join(__dirname, '..', '..', 'hooks');
const INSTALLS = path.join(HOOKS, 'block-host-installs.sh');
const SECRETS = path.join(HOOKS, 'block-secret-reads.sh');

let binDir: string;

beforeAll(() => {
  // Only what the scripts need; deliberately no jq.
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-nojq-'));
  fs.symlinkSync('/bin/cat', path.join(binDir, 'cat'));
  fs.symlinkSync('/usr/bin/grep', path.join(binDir, 'grep'));
});

afterAll(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

function run(
  script: string,
  input: string,
  env: Record<string, string> = {},
): { code: number; stderr: string } {
  try {
    execFileSync('/bin/bash', [script], {
      input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: binDir, ...env },
    });
    return { code: 0, stderr: '' };
  } catch (err: any) {
    return { code: err.status ?? -1, stderr: String(err.stderr ?? '') };
  }
}

const payload = (tool_input: Record<string, unknown>) => JSON.stringify({ tool_input });

const maybe = fs.existsSync('/usr/bin/plutil') ? describe : describe.skip;

maybe('hooks without jq on PATH (plutil path)', () => {
  it('the PATH really has no jq', () => {
    expect(fs.existsSync(path.join(binDir, 'jq'))).toBe(false);
  });

  it('install guard: blocks an install command, allows a harmless one', () => {
    expect(run(INSTALLS, payload({ command: 'pip install pandas' })).code).toBe(2);
    expect(run(INSTALLS, payload({ command: 'echo "a \\"quoted\\" é"\npip3 install x' })).code).toBe(2);
    expect(run(INSTALLS, payload({ command: 'ls -la' })).code).toBe(0);
    expect(run(INSTALLS, payload({})).code).toBe(0);
  });

  it('secret guard: blocks command and file_path reads, allows harmless ones', () => {
    expect(run(SECRETS, payload({ command: 'cat /x/cobuilding-settings.json' })).code).toBe(2);
    expect(run(SECRETS, payload({ file_path: '/x/claude-config/.claude.json' })).code).toBe(2);
    expect(run(SECRETS, payload({ command: 'ls MyResearch' })).code).toBe(0);
    expect(run(SECRETS, payload({ file_path: '/ws/.claude/settings.json' })).code).toBe(0);
    expect(run(SECRETS, JSON.stringify({})).code).toBe(0);
  });

  it('fails closed on a payload it cannot read', () => {
    for (const script of [INSTALLS, SECRETS]) {
      const r = run(script, 'not json at all');
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('could not check this command');
    }
  });

  it('an empty payload has nothing to check', () => {
    expect(run(INSTALLS, '').code).toBe(0);
    expect(run(SECRETS, '').code).toBe(0);
  });
});

describe('hooks with no parser at all', () => {
  it('fail closed rather than allow', () => {
    const env = { ACABOX_HOOK_PLUTIL: '/nonexistent/plutil' };
    expect(run(INSTALLS, payload({ command: 'ls' }), env).code).toBe(2);
    expect(run(SECRETS, payload({ command: 'ls' }), env).code).toBe(2);
  });
});
