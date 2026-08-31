import { lastHostedPathResolution } from './hostedEnv';

/**
 * Map a raw hosted-MCP-server failure to an actionable, plain-English
 * message (design: `docs/design/mcp-hosting.md`, Increment 2, the R8
 * annotation). "A module called `diagnose.ts` with no enumerated cases
 * becomes `String(err)` with a nicer font" — so every case below is named,
 * keyed off a real string this repo (or the MCP SDK) actually produces, and
 * has its own test in `mcpHostDiagnose.test.ts`.
 *
 * Pure and synchronous on purpose: the supervisor gathers everything this
 * needs (the raw error, the exit code, how long the attempt had been
 * running, the stderr tail) and hands it over as one `DiagnoseInput` — this
 * function never touches a process, a socket, or the clock.
 */

export interface DiagnoseInput {
  /**
   * The error/event that triggered a diagnosis — a spawn `error` event, an
   * `onerror` parse failure, a readiness-timeout `Error` we constructed
   * ourselves, or absent when all we have is an exit code. Its `.message`
   * (or the value itself, if given as a string) is what gets pattern-matched
   * below; nothing here inspects a stack trace.
   */
  error?: unknown;
  /** The command that was (or would have been) run — for the ENOENT/EACCES/127 messages, which need to name it. */
  command: string;
  /** Set once the child has actually exited. Absent for e.g. a still-running handshake timeout. */
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** True once we have seen a live pid for this attempt — distinguishes "never even spawned" (ENOENT) from "spawned but never answered" (handshake timeout). */
  hadPid?: boolean;
  /** Set when this diagnosis follows OUR OWN readiness deadline firing, rather than a process exit. */
  timedOut?: boolean;
  /** Milliseconds from spawn to exit/timeout, when known — drives the "exited immediately" wording. */
  elapsedMs?: number;
  /** Recent stderr, most-recent-last. Shown verbatim when nothing more specific matches. */
  stderrTail?: string;
}

function messageOf(error: unknown): string {
  if (!error) return '';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function codeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const c = (error as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/** The truncated snippet V8's own JSON.parse error message already carries — see the module comment on stdout framing below for why this doesn't need our own re-implementation of line buffering. */
const FRAMING_SNIPPET_RE = /Unexpected token '.', "([^"]*)"(\.\.\.)? is not valid JSON/;
const FRAMING_GENERIC_RE = /is not valid JSON|Unexpected (?:end of JSON input|token)/;

const IMMEDIATE_EXIT_THRESHOLD_MS = 2000;

export function diagnose(input: DiagnoseInput): string {
  const msg = messageOf(input.error);
  const code = codeOf(input.error);
  const cmd = input.command;

  // 1. Native module built for the wrong Node ABI. Most specific check
  // first: this text can appear inside an otherwise generic dlopen/require
  // failure, so it must not fall through to the generic exit-code cases below.
  if (/NODE_MODULE_VERSION/.test(msg) || code === 'ERR_DLOPEN_FAILED' || /ERR_DLOPEN_FAILED/.test(msg)) {
    const detail = msg.match(/NODE_MODULE_VERSION[^.]*\./)?.[0];
    return `This server ships a compiled add-on built for a different version of Node${detail ? ` (${detail})` : ''}. Acabox cannot rebuild it — reinstall the server for the Node version Acabox uses.`;
  }

  // 2. Stdout framing corruption — R8's #1 real-world stdio MCP bug. Acabox
  // talks JSON-RPC over the child's stdout; anything else printed there
  // (a stray console.log, a startup banner) corrupts the next frame the SDK
  // tries to parse, which surfaces as an ordinary-looking JSON.parse error.
  // Node's own SyntaxError message already carries a snippet of the
  // offending text (verified: `JSON.parse("this line i...")` produces
  // `Unexpected token 'h', "this line i"... is not valid JSON`), so this
  // reuses that rather than re-parsing the raw bytes ourselves.
  if (FRAMING_SNIPPET_RE.test(msg) || FRAMING_GENERIC_RE.test(msg)) {
    const snippet = msg.match(FRAMING_SNIPPET_RE)?.[1];
    const shown = snippet ? `"${snippet}${msg.includes('...') ? '…' : ''}"` : 'something that was not JSON-RPC';
    return `This server printed ${shown} to its own output, which Acabox uses to talk to it. Any stray "console.log" (or similar) on stdout corrupts the conversation between Acabox and the server. Ask the server's author to log to stderr instead.`;
  }

  // 3. The command itself was never found. This fires before ever getting a
  // pid — `hadPid` should be falsy here, but the check does not require it,
  // since a spawn 'error' event IS the authoritative signal regardless.
  if (code === 'ENOENT' || /\bENOENT\b/.test(msg)) {
    return `Acabox could not find "${cmd}". It is not installed, or not on the path Acabox sees.`;
  }

  if (code === 'EACCES' || /\bEACCES\b/.test(msg)) {
    return `"${cmd}" is not executable.`;
  }

  // 4. Exit 127 — a DIFFERENT failure from ENOENT even though both are
  // "command not found" in spirit: here the command itself ran (it has a
  // pid and an exit code), but it could not find ITS OWN interpreter — the
  // classic case is a `#!/usr/bin/env node` shebang where `env` can't find
  // `node`. Combined with `lastHostedPathResolution()` because this is
  // exactly the "works in Terminal, 127 from the Dock" report CLAUDE.md
  // already says callers keep getting wrong: knowing WHICH path Acabox
  // actually searched turns a mystery into a diagnosis.
  if (input.exitCode === 127) {
    const resolution = lastHostedPathResolution();
    if (resolution && !resolution.resolved) {
      return `"${cmd}" exited immediately (127) — its own interpreter could not be found. Acabox could not read your login shell's PATH, so it started this server with: ${resolution.path}`;
    }
    const pathNote = resolution ? ` (Acabox used: ${resolution.path})` : '';
    return `"${cmd}" exited immediately (127) — it ran, but the interpreter it needs was not found${pathNote}.`;
  }

  // 5. Handshake timeout with a live pid: the process is running but never
  // answered `initialize`/`tools/list`. Distinct from "exited and said
  // nothing" below — this one is still alive, just unresponsive.
  if (input.timedOut && input.hadPid) {
    return 'Started, but never answered. It may be waiting for a password or a browser sign-in.';
  }

  // 6. A non-zero exit that happened fast and left nothing on stderr — R8's
  // "Exited immediately and said nothing" case. Show the log tail rather
  // than inventing a cause whenever there IS one; this branch is specifically
  // for when there isn't.
  const exitedFast = input.exitCode != null && input.exitCode !== 0
    && (input.elapsedMs === undefined || input.elapsedMs <= IMMEDIATE_EXIT_THRESHOLD_MS);
  const stderrTail = (input.stderrTail ?? '').trim();
  if (exitedFast && !stderrTail) {
    return `Exited immediately and said nothing (exit code ${input.exitCode}).`;
  }

  // Fallback: never invent a cause we don't have. Show whatever real
  // evidence exists — the stderr tail if there is one, else the raw error.
  if (stderrTail) {
    const codeNote = input.exitCode != null ? ` (exit code ${input.exitCode})` : '';
    return `"${cmd}" did not start correctly${codeNote}. Recent output:\n${stderrTail}`;
  }
  if (msg) {
    return `"${cmd}" failed to start: ${msg}`;
  }
  return `"${cmd}" did not start correctly, and left no further information.`;
}
