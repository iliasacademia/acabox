/**
 * Exercises the REAL shipped hook script, not a reimplementation — the file
 * that gets copied into `.claude/hooks/` is the thing under test.
 *
 * Exit 2 = deny (Claude Code feeds stderr back to the agent), 0 = allow.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'block-secret-reads.sh');

function runHook(payload: Record<string, unknown>): { code: number; stderr: string } {
  try {
    execFileSync('bash', [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (err: any) {
    return { code: err.status ?? -1, stderr: String(err.stderr ?? '') };
  }
}

const bash = (command: string) => runHook({ tool_input: { command } });
const read = (file_path: string) => runHook({ tool_input: { file_path } });

describe('block-secret-reads hook — denies', () => {
  it('reading the settings file that holds the API key and connector headers', () => {
    const r = bash('cat ~/Library/Application Support/acabox/development/cobuilding-settings.json');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('off limits');
  });

  it('grepping the settings file for a key', () => {
    expect(bash('grep -r sk-ant "/Users/x/Library/Application Support/acabox/production/cobuilding-settings.json"').code).toBe(2);
  });

  it('touching the Claude config dir, which holds connector OAuth tokens', () => {
    expect(bash('ls ~/Library/Application Support/acabox/development/claude-config').code).toBe(2);
    expect(bash('cat ~/Library/Application Support/acabox/development/claude-config/.claude.json').code).toBe(2);
  });

  it('reading .claude.json by any route', () => {
    expect(bash(`python3 -c "print(open('.claude.json').read())"`).code).toBe(2);
    expect(bash('cd /tmp && cat .claude.json').code).toBe(2);
  });

  it('the agent start config, which holds the raw key and decrypted headers', () => {
    // Unlike settings.json this one cannot be encrypted — it is the SDK's
    // input — so keeping the agent out of it matters more, not less.
    expect(bash('cat ~/Library/Application Support/acabox/development/agent.json').code).toBe(2);
    expect(read('/Users/x/Library/Application Support/acabox/development/agent.json').code).toBe(2);
  });

  it('the same paths via the Read tool, not just Bash', () => {
    // The hook is registered for Read|Edit|Write too, whose payload carries
    // file_path rather than command.
    expect(read('/Users/x/Library/Application Support/acabox/development/cobuilding-settings.json').code).toBe(2);
    expect(read('/Users/x/Library/Application Support/acabox/development/claude-config/.claude.json').code).toBe(2);
  });
});

describe('block-secret-reads hook — allows', () => {
  it('ordinary workspace commands', () => {
    expect(bash('ls MyResearch').code).toBe(0);
    expect(bash('python3 analyze.py --in data.csv').code).toBe(0);
  });

  it('the workspace .claude/settings.json, which is not a secret', () => {
    // Distinct from `.claude.json`; blocking it would break legitimate work.
    expect(read('/ws/.claude/settings.json').code).toBe(0);
    expect(bash('cat .claude/settings.json').code).toBe(0);
  });

  it('mini-app files that merely contain the word claude', () => {
    expect(read('/ws/.applications/foo/manifest.json').code).toBe(0);
    expect(bash('cat .applications/claudeDemo/index.tsx').code).toBe(0);
  });

  it('a payload with neither field', () => {
    expect(runHook({ tool_input: {} }).code).toBe(0);
    expect(runHook({}).code).toBe(0);
  });
});
