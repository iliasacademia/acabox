#!/usr/bin/env node
/**
 * A real stdio MCP server, used by both jest tests and the S5 spike probe
 * (docs/design/mcp-hosting.md, Increment 0 / R4). Not spike scaffolding —
 * this is a planned Increment 2 artifact and should be kept.
 *
 * Exposes:
 *   echo(text)  -> returns text unchanged
 *   slow(ms)    -> sleeps `ms` milliseconds, returns {start, end} ISO timestamps
 *   crash()     -> process.exit(1), no response sent
 *
 * Flags:
 *   --ignore-sigterm  Installs a SIGTERM handler that does nothing, and spawns
 *                      a detached-less `sleep 60` grandchild. Together these
 *                      make the process survive a plain `kill(pid)`, which is
 *                      what Increment 2's tree-kill test (processTree.ts) needs
 *                      to assert against.
 *   --noisy           Writes a line to stdout before responding to `echo`,
 *                      which corrupts stdio JSON-RPC framing on purpose — the
 *                      #1 real-world stdio MCP bug (R8's diagnose.ts case).
 *
 * IMPORTANT: this process talks JSON-RPC over stdout. Never `console.log` /
 * `process.stdout.write` for anything other than protocol frames — that is
 * exactly the corruption `--noisy` exists to reproduce on purpose. Diagnostic
 * output must go to stderr.
 */
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const args = process.argv.slice(2);
const ignoreSigterm = args.includes('--ignore-sigterm');
const noisy = args.includes('--noisy');

if (ignoreSigterm) {
  process.on('SIGTERM', () => {
    // Deliberately absorbed. A supervisor that only ever SIGTERMs will hang
    // forever against a process wired up like this one.
    process.stderr.write('[echoMcpServer] SIGTERM received and ignored\n');
  });
  // No `detached`, matching how Increment 2 will spawn real servers — the
  // point of this flag is a *grandchild* that outlives a bare `kill(pid)` of
  // THIS process, not one that survives Acabox's own exit.
  spawn('sleep', ['60'], { stdio: 'ignore' });
}

const server = new McpServer({ name: 'acabox-spike-echo', version: '0.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Echoes the given text back unchanged.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => {
    if (noisy) {
      // Intentional stdout pollution — corrupts the next JSON-RPC frame.
      process.stdout.write('this line is not JSON-RPC and will corrupt the stream\n');
    }
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'slow',
  {
    description: 'Sleeps for the given number of milliseconds, then returns start/end timestamps.',
    inputSchema: { ms: z.number() },
  },
  async ({ ms }) => {
    const start = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const end = new Date().toISOString();
    return { content: [{ type: 'text', text: JSON.stringify({ start, end }) }] };
  },
);

server.registerTool(
  'crash',
  {
    description: 'Exits the process immediately with a non-zero code. Sends no response.',
    inputSchema: {},
  },
  async () => {
    process.exit(1);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
