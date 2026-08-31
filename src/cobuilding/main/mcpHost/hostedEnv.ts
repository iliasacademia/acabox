import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { didResolveLoginShellPath, getLoginShellPath } from '../shellPath';
import type { HostedMcpRecord } from '../../shared/hostedMcp';

/**
 * Env for a hosted MCP server's child process — an ALLOWLIST, built by
 * copying named keys, never by spreading `process.env` and stripping
 * afterwards (design: `docs/design/mcp-hosting.md`, Increment 2).
 *
 * Why this matters: today's stdio connector inherits the agent server's
 * *entire* environment, including the raw `ANTHROPIC_API_KEY` and
 * `ACABOX_API_TOKEN` (the design doc's Context section, point 3). A "spread
 * then delete the bad keys" approach only ever protects against the leaks its
 * author remembered to list; an allowlist protects against every leak its
 * author didn't think of, because there is nothing to spread in the first
 * place — an unlisted var simply never gets copied.
 *
 * `HOSTED_ENV_ALLOWLIST` is the MCP SDK's own POSIX `DEFAULT_INHERITED_ENV_VARS`
 * (imported by reference, per the design doc, rather than transcribed — a
 * reader can diff it against upstream) plus four vars a normal, locale-aware
 * process needs and the SDK's own list does not carry: `TMPDIR` (scratch
 * files), `LANG`/`LC_ALL` (plenty of CLIs — and Node's own `Intl` — misbehave
 * with neither set), and `TZ` (so a server's own timestamps agree with the
 * user's clock).
 *
 * `PATH` is then overridden with `getLoginShellPath()`: a Finder-launched app
 * inherits launchd's minimal PATH, and there is no `/usr/bin/node` on this
 * machine — Homebrew node is reachable only via the login shell's PATH. This
 * runs AFTER the allowlist copy specifically so it replaces whatever `PATH`
 * value the copy loop picked up, rather than losing a race with it.
 *
 * The record's own `env` is layered on last, so a server's declared vars can
 * override the allowlist (e.g. a server that wants its own `TZ`) but nothing
 * declared here can smuggle in a var the allowlist didn't already name for a
 * DIFFERENT reason — layering doesn't add new *keys* to the allowlist's
 * portion, it only lets the record's own explicit keys through, which is the
 * one thing this function is supposed to let happen.
 *
 * Nothing else is added. In particular, and deliberately, NOT present:
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
 * `ACABOX_API_TOKEN`, `ACABOX_API_BASE`, every `COSCIENTIST_*`,
 * `CLAUDE_CONFIG_DIR`, `ELECTRON_RUN_AS_NODE`, `NODE_PATH` (deliberately —
 * it would let a workspace-installed module shadow the hosted server's own
 * dependency), `npm_*`, `GITHUB_TOKEN`.
 */
const EXTRA_ALLOWLIST = ['TMPDIR', 'LANG', 'LC_ALL', 'TZ'] as const;

export const HOSTED_ENV_ALLOWLIST: readonly string[] = [
  ...DEFAULT_INHERITED_ENV_VARS,
  ...EXTRA_ALLOWLIST,
];

/**
 * The PATH baked into the most recent hosted-server env, and whether it came
 * from the login shell or from the bare `process.env.PATH` fallback.
 *
 * `getLoginShellPath()` returns a plain string in both cases, so this pairs it
 * with `didResolveLoginShellPath()` to keep the distinction. It matters exactly
 * once — when a spawn fails looking like "command not found". A hosted server's
 * `command` is user- or catalog-supplied, launchd's PATH omits
 * `/opt/homebrew/bin`, and there is no `/usr/bin/node`, so `resolved: false`
 * plus an exit 127 is a complete diagnosis where the exit code alone is a
 * mystery. The supervisor surfaces this in `lastError` rather than making the
 * user guess where Acabox looked.
 */
export interface HostedPathResolution {
  path: string;
  resolved: boolean;
}

let lastPathResolution: HostedPathResolution | null = null;

/** The PATH most recently baked into a hosted server's env — see `HostedPathResolution`. */
export function lastHostedPathResolution(): HostedPathResolution | null {
  return lastPathResolution;
}

/**
 * Build the environment for one hosted MCP server's child process.
 *
 * `record` only needs its own `env` — the function does not otherwise
 * inspect the record, and callers may pass a full `HostedMcpRecord` or just
 * `{ env }`.
 */
export function buildHostedEnv(record: Pick<HostedMcpRecord, 'env'>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const key of HOSTED_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }

  const resolvedPath = getLoginShellPath();
  out.PATH = resolvedPath;
  lastPathResolution = { path: resolvedPath, resolved: didResolveLoginShellPath() };

  for (const [key, value] of Object.entries(record.env ?? {})) {
    out[key] = value;
  }

  return out;
}
