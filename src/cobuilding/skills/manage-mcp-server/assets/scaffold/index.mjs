#!/usr/bin/env node
/**
 * A hand-rolled stdio MCP server. Zero npm dependencies on purpose — see
 * "Dependencies" in ../../SKILL.md for why: the install wrapper
 * (`.applications/install`) cannot target this directory, so there is no
 * sanctioned way to add one, and every existing MCP server in this repo
 * (`src/cobuilding/main/__tests__/fixtures/echoMcpServer.mjs`) already treats
 * a dependency as a real cost. Everything here is Node built-ins: `node:fs`,
 * `node:path`, `node:url`, `node:readline`.
 *
 * ============================================================================
 * RULE #1 — NEVER WRITE TO STDOUT EXCEPT ONE JSON-RPC MESSAGE PER LINE.
 * ============================================================================
 * stdout is the wire to the host. A stray `console.log`, a debug `print`, an
 * uncaught library that logs to stdout by default — any of these corrupt the
 * frame the host is trying to parse and produce a failure that looks like it
 * has nothing to do with logging ("Unexpected token 'h', "this is a lo"...
 * is not valid JSON"). This is the single most common way a hand-written MCP
 * server breaks. ALL diagnostics in this file go through `log()`, which
 * writes to stderr. If you add code to this file, never call
 * `console.log`/`console.info`/`console.warn`/`console.debug` — only
 * `console.error` (which Node also routes to stderr) or `log()`.
 *
 * ============================================================================
 * RULE #2 — EXIT WHEN STDIN CLOSES. DO NOT OUTLIVE YOUR PARENT.
 * ============================================================================
 * The host closes stdin when it stops this server (the user paused/removed
 * it, or Acabox quit). A process that keeps running after that becomes an
 * orphan holding whatever it opened — the exact bug Acabox's own dictation
 * helper had (`src/cobuilding/swift/dictation-mac/main.swift`: an early
 * `exit(0)` raced in-flight work) and fixed by tracking outstanding work and
 * exiting only once it reaches zero. This file does the same thing with the
 * `pending` counter below.
 *
 * Protocol: newline-delimited JSON-RPC 2.0, exactly as the MCP SDK's own
 * `StdioClientTransport` speaks it (verified against
 * `@modelcontextprotocol/sdk/dist/cjs/shared/stdio.js`: one
 * `JSON.stringify(message) + "\n"` per message, read back by splitting on
 * "\n"). No Content-Length headers, no batching.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// stderr-only logging. Never console.log. See RULE #1 above.
// ---------------------------------------------------------------------------
function log(...args) {
  process.stderr.write(`[mcp-server] ${args.map(String).join(' ')}\n`);
}

// ---------------------------------------------------------------------------
// Identity, read from the sibling manifest.json so it never drifts out of
// sync with what the host shows the user on the Servers page. Falls back to
// generic defaults rather than refusing to start if manifest.json is missing
// or malformed — a server that won't even boot because of a metadata typo is
// a worse failure than one running under a placeholder name.
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));

let manifest = { id: 'my-mcp-server', label: 'My MCP Server' };
try {
  manifest = { ...manifest, ...JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf8')) };
} catch (err) {
  log(`could not read manifest.json, using defaults: ${err.message}`);
}

const SERVER_INFO = { name: manifest.id, version: '0.1.0' };

// ---------------------------------------------------------------------------
// TOOLS — replace this example with your own. Each entry needs:
//   name          matches [A-Za-z0-9_]+ by MCP convention.
//   description   what the tool does, written for the MODEL — this is
//                 instruction text an agent reads to decide when to call it.
//   inputSchema   plain JSON Schema. This hand-rolled server does not run a
//                 validator against it — it is documentation for the client.
//                 `handler` below re-checks anything the schema only
//                 describes, which is why the schema and the checks agree.
//   handler(args) async function returning `{ content: [...] }`, optionally
//                 with `isError: true` when the call reached the tool but
//                 failed for a reason worth telling the model in plain text
//                 (as opposed to a malformed/unknown call, which is a
//                 protocol-level error — see `handleMessage` below).
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'convert_temperature',
    description: 'Convert a temperature value between Celsius, Fahrenheit, and Kelvin.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'number', description: 'The temperature value to convert.' },
        from: { type: 'string', enum: ['celsius', 'fahrenheit', 'kelvin'], description: 'Unit of `value`.' },
        to: { type: 'string', enum: ['celsius', 'fahrenheit', 'kelvin'], description: 'Unit to convert `value` into.' },
      },
      required: ['value', 'from', 'to'],
      additionalProperties: false,
    },
    async handler(args) {
      const UNITS = ['celsius', 'fahrenheit', 'kelvin'];
      const { value, from, to } = args ?? {};

      // The schema above only DESCRIBES these constraints to the model; a
      // real caller can still send something that violates them (a bad
      // argument, a model that ignored the enum). Re-check for real here —
      // this is the isError path the schema alone cannot provide.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return errorResult(`"value" must be a finite number, got ${JSON.stringify(value)}.`);
      }
      if (!UNITS.includes(from)) {
        return errorResult(`"from" must be one of ${UNITS.join(', ')}, got ${JSON.stringify(from)}.`);
      }
      if (!UNITS.includes(to)) {
        return errorResult(`"to" must be one of ${UNITS.join(', ')}, got ${JSON.stringify(to)}.`);
      }

      let kelvin;
      if (from === 'celsius') kelvin = value + 273.15;
      else if (from === 'fahrenheit') kelvin = ((value - 32) * 5) / 9 + 273.15;
      else kelvin = value;

      let result;
      if (to === 'celsius') result = kelvin - 273.15;
      else if (to === 'fahrenheit') result = ((kelvin - 273.15) * 9) / 5 + 32;
      else result = kelvin;

      const rounded = Math.round(result * 100) / 100;
      return { content: [{ type: 'text', text: `${value} ${from} = ${rounded} ${to}` }] };
    },
  },
];

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing. You should not need to touch anything below this line —
// add new tools to TOOLS above instead.
// ---------------------------------------------------------------------------

/** The ONLY function in this file allowed to write to stdout. */
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function respondResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// Standard JSON-RPC 2.0 error codes (matches @modelcontextprotocol/sdk's
// ErrorCode enum, so a real MCP client reports these the same way it would
// report them from the SDK's own server implementation).
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

async function handleMessage(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case 'initialize': {
        // Echo back whatever protocol version the caller asked for. A
        // client only ever requests a version it itself understands, so
        // echoing it is always a version both sides can speak — simpler and
        // more future-proof than pinning a version string here that will
        // eventually go stale as the spec moves on.
        respondResult(id, {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        return;
      }

      case 'notifications/initialized': {
        // Confirms the client received our `initialize` result. It is a
        // notification (no `id`) — notifications NEVER get a response,
        // success or failure. There is nothing to do here but return.
        return;
      }

      case 'tools/list': {
        respondResult(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
        return;
      }

      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) {
          // Calling a tool that doesn't exist is a malformed REQUEST, not a
          // tool-execution failure — so it is a protocol-level error
          // (matches the real SDK's own "Tool X not found" behaviour),
          // never an `isError` result.
          respondError(id, INVALID_PARAMS, `Tool "${params?.name}" not found.`);
          return;
        }
        const result = await tool.handler(params?.arguments);
        respondResult(id, result);
        return;
      }

      case 'ping': {
        respondResult(id, {});
        return;
      }

      default: {
        if (!isNotification) {
          respondError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
        // An unrecognized NOTIFICATION is silently ignored — still no
        // response, because notifications never get one.
        return;
      }
    }
  } catch (err) {
    log(`unhandled error in ${method}: ${err?.stack ?? String(err)}`);
    if (!isNotification) {
      respondError(id, INTERNAL_ERROR, `Internal error: ${err?.message ?? String(err)}`);
    }
  }
}

// `pending` tracks in-flight `handleMessage` calls so we can honour RULE #2:
// exit once stdin is closed AND nothing is still being handled, never before.
let pending = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pending === 0) {
    process.exit(0);
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    // Malformed JSON has no `id` we can trust, so per JSON-RPC convention
    // respond with `id: null` rather than guessing at one or staying silent.
    log(`received a line that is not valid JSON, ignoring: ${trimmed.slice(0, 200)}`);
    respondError(null, PARSE_ERROR, 'Parse error: invalid JSON.');
    return;
  }

  pending++;
  Promise.resolve(handleMessage(message))
    .catch((err) => log(`handleMessage rejected: ${err?.stack ?? String(err)}`))
    .finally(() => {
      pending--;
      maybeExit();
    });
});

rl.on('close', () => {
  // stdin closed: the host stopped us, or Acabox quit. Exit as soon as any
  // in-flight call finishes writing its response — see RULE #2 above.
  stdinClosed = true;
  maybeExit();
});

log(`${SERVER_INFO.name} v${SERVER_INFO.version} ready, waiting for JSON-RPC on stdin`);
