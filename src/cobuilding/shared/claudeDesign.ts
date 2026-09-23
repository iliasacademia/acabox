/**
 * Claude Design sign-in — the protocol half, with no Electron in it.
 *
 * The SDK exposes a `DesignSync` tool that reads and writes the user's
 * claude.ai/design design-system projects. It authenticates from a design
 * credential the CLI keeps in secure storage, keyed by `CLAUDE_CONFIG_DIR`.
 * Inside Claude Code that credential is minted by the interactive
 * `/design-login` slash command, which Acabox's headless sessions have no way
 * to type — so before this existed every `DesignSync` call answered "needs
 * design-system authorization" and nothing could ever satisfy it.
 *
 * WHAT WAS MEASURED AGAINST THE BUNDLED CLI (2.1.280)
 * ---------------------------------------------------
 * The binary carries a hidden subcommand built for the VS Code extension:
 *
 *   claude design-login --json [--status]
 *
 * - It refuses when stdin is a TTY, and when `CLAUDECODE` or
 *   `CLAUDE_CODE_CHILD_SESSION` is set (`isSpawnedByClaudeCodeSession`). An
 *   Acabox launched from inside a Claude Code terminal inherits both, hence
 *   `DESIGN_LOGIN_ENV_STRIP`.
 * - `--status` prints one line and exits:
 *     {"available":true,"signed_in":false,"can_sign_in_here":true}
 *   plus `"reason"` when `can_sign_in_here` is false.
 * - Without `--status` it prints, as JSON lines on stdout,
 *     {"event":"pages","url":…,"manual_url":…,"manual_first":bool}
 *   then, once the browser round-trip finishes,
 *     {"event":"done","ok":true}  |  {"event":"done","ok":false,"message":…}
 *   The CLI gives up after five minutes on its own.
 * - If the automatic callback cannot land, it reads the code the sign-in page
 *   shows from stdin, one JSON line per attempt: {"code":"<code>#<state>"}.
 *
 * The credential therefore lands wherever `CLAUDE_CONFIG_DIR` says, and the
 * agent server boots the SDK with `CLAUDE_CONFIG_DIR = getClaudeConfigDir()`.
 * Spawning this with any other value mints a credential no chat will ever see.
 */

export interface DesignLoginStatus {
  /** Claude Design sync exists in this CLI build at all. */
  available: boolean;
  signedIn: boolean;
  canSignInHere: boolean;
  /** Present when `canSignInHere` is false. */
  reason?: string;
}

export type DesignLoginEvent =
  | { state: 'waiting'; url: string; manualUrl: string | null; manualFirst: boolean }
  | { state: 'done'; ok: true }
  | { state: 'done'; ok: false; message: string };

/**
 * Environment keys removed before spawning. The first two are what the CLI
 * actually checks; the rest describe a parent session this process is not.
 */
export const DESIGN_LOGIN_ENV_STRIP: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
];

/** The CLI's own timeout, plus slack so ours never fires first. */
export const DESIGN_LOGIN_TIMEOUT_MS = 6 * 60 * 1000;

export function buildDesignLoginEnv(
  base: NodeJS.ProcessEnv,
  claudeConfigDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CLAUDE_CONFIG_DIR: claudeConfigDir };
  for (const key of DESIGN_LOGIN_ENV_STRIP) delete env[key];
  return env;
}

/**
 * Where the SDK's platform binary lives. Packaged builds unpack the whole
 * `@anthropic-ai/claude-agent-sdk-*` tree out of the asar (forge.config.js);
 * dev runs straight from the repo's node_modules.
 */
export function claudeBinaryCandidates(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: string;
  arch: string;
}): string[] {
  const rel = ['node_modules', '@anthropic-ai', `claude-agent-sdk-${opts.platform}-${opts.arch}`, 'claude'];
  return opts.isPackaged
    ? [[opts.resourcesPath, 'app.asar.unpacked', ...rel].join('/')]
    : [[opts.appPath, ...rel].join('/')];
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Parse the single line `--status` prints. */
export function parseDesignStatusLine(line: string): DesignLoginStatus | null {
  const obj = parseJsonObject(line);
  if (!obj || typeof obj.available !== 'boolean' || typeof obj.signed_in !== 'boolean') return null;
  return {
    available: obj.available,
    signedIn: obj.signed_in,
    canSignInHere: obj.can_sign_in_here === true,
    ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
  };
}

/**
 * Parse one stdout line of the sign-in flow. Returns null for anything that
 * is not a protocol event, so a stray log line never reads as a failure.
 */
export function parseDesignLoginLine(line: string): DesignLoginEvent | null {
  const obj = parseJsonObject(line);
  if (!obj) return null;
  if (obj.event === 'pages' && typeof obj.url === 'string') {
    return {
      state: 'waiting',
      url: obj.url,
      manualUrl: typeof obj.manual_url === 'string' ? obj.manual_url : null,
      manualFirst: obj.manual_first === true,
    };
  }
  if (obj.event === 'done') {
    if (obj.ok === true) return { state: 'done', ok: true };
    return {
      state: 'done',
      ok: false,
      message: typeof obj.message === 'string' && obj.message ? obj.message : 'The sign-in failed.',
    };
  }
  return null;
}

/**
 * The page to open. `manual_first` means the CLI already expects the loopback
 * callback not to land, so the page that shows a pasteable code goes first.
 */
export function pageToOpen(event: Extract<DesignLoginEvent, { state: 'waiting' }>): string {
  return event.manualFirst && event.manualUrl ? event.manualUrl : event.url;
}

/** Encode a pasted code for the CLI's stdin. Null when there is nothing to send. */
export function encodeManualCode(raw: string): string | null {
  const code = raw.trim();
  if (!code) return null;
  return `${JSON.stringify({ code })}\n`;
}
