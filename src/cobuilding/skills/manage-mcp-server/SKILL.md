---
name: manage-mcp-server
description: >
  Write a standalone, persistent local MCP server that Acabox hosts as its own
  process for the life of the app — not a one-off script, not a mini-app.
  Use when the user asks for "a tool Claude can call", "an MCP server", "give
  yourself a new capability", "wrap this API as something you can call
  yourself", or wants a capability that should keep working, unattended,
  across many future chats rather than being run once now. This is headless
  Node code with NO user interface — if the user instead wants something to
  look at (a dashboard, a chart, a form, a page they open), use
  manage-mini-application instead, and see "When NOT to use this skill" below
  for the exact dividing line, including the different MCP mechanism a
  mini-app already has. The server you write here starts disabled; the user
  reviews and enables it on the Servers page — this skill does not, and
  cannot, turn a server on.
---

# Manage MCP Server

Writes a small, dependency-free Node program that speaks the Model Context
Protocol over its own stdin/stdout. Acabox spawns it, keeps it running for as
long as the user leaves it enabled, and gives its tools to every future chat —
this is the difference from everything else the agent already has: a Bash
command ends when the turn ends, but a hosted MCP server's state (an
in-memory cache, an open connection, a counter) survives across turns and
across chats.

## When to use this skill

Use it when the user wants Claude to be able to **call** a capability
repeatedly, from any future chat, without re-explaining it — "build me a tool
that looks up X", "wrap this internal API so you can query it yourself",
"give yourself a way to do Y". The output is a tool the model invokes, not
something a person looks at.

## When NOT to use this skill

Two different things in Acabox both involve "MCP" and "a tool Claude can
call." Pick by what the interface actually is:

| If the capability needs... | Use | Why |
|---|---|---|
| A UI a person opens, clicks, and reads (a dashboard, a form, a chart, a table) | **manage-mini-application** | That's a mini-app: a React iframe. If it *also* declares an `mcp` block in its `manifest.json`, other mini-apps and the agent can call its tools too — but only while the mini-app is open on screen (see that skill's "Publishing an MCP server from a mini-app"). |
| A capability that runs headless, with no screen, purely so the model can call it | **manage-mcp-server** (this skill) | A standalone Node process Acabox keeps running whether or not any tool tab is open. |
| A connection to a remote third-party service the user already has an account with (Notion, GitHub, Sentry, Linear, Hex...) | Neither — tell the user to add it in **Settings → Connectors** | Connectors are host-owned and user-configured on purpose (`shared/connectors.ts`): an agent that can add its own arbitrary remote MCP endpoint could exfiltrate the workspace. You cannot add one, and should not try to work around this by writing a local proxy to a remote service instead. |

If a request is genuinely both — "a dashboard AND a background capability
other tools can call" — build the mini-app for the dashboard, and if it needs
a capability that must survive the dashboard being closed, write that part as
a server under this skill instead of an mcp-published mini-app tool.

## Quick start

```bash
mkdir -p .mcp-servers/<id>
cp .claude/skills/manage-mcp-server/assets/scaffold/index.mjs .mcp-servers/<id>/index.mjs
cp .claude/skills/manage-mcp-server/assets/scaffold/manifest.json .mcp-servers/<id>/manifest.json
```

Then:
1. Edit `manifest.json` — real `id`, `label`, `description`.
2. Edit `index.mjs` — replace the `TOOLS` array with your own tool(s). Leave
   everything below the `JSON-RPC plumbing` comment alone unless you know you
   need to change it.
3. **Test it yourself before telling the user it's ready** — see below. Do
   not skip this; a broken server just sits disabled and confusing on the
   Servers page with no chat transcript to tell the user why.
4. Tell the user what you built in plain language (not a `tools/list` dump)
   and that it's waiting for them on the **Servers page**, disabled, for them
   to review and turn on.

## The directory contract

One server lives at `<workspace>/.mcp-servers/<id>/`, containing exactly:

- `index.mjs` — the server. Runnable on its own; not bundled, not compiled.
- `manifest.json` — metadata the host reads to show the user a row before it
  ever runs the server:
  ```json
  {
    "id": "unit-converter",
    "label": "Unit Converter",
    "description": "Converts values between common units on request."
  }
  ```
  `description` is not a code comment — it is the sentence the Servers page
  turns into the plain-language "Claude can now..." confirmation the user
  sees. Write it for the user, the same way you'd write a mini-app's
  `manifest.json` description.

**`id` rules — these are not a style suggestion, they are enforced and shared
with Connectors** (`shared/connectors.ts`, since both end up as the middle
segment of an SDK tool name, `mcp__<id>__<tool>`):

- Must match `/^[a-zA-Z0-9][a-zA-Z0-9-]*$/` — letters, numbers, and hyphens
  only, starting with a letter or number. No underscores, no dots, no spaces.
- Must not be one of the reserved names Acabox's own built-in relays use:
  `activity`, `notification`, `reaction`, `mini-apps`, `workspace`,
  `knowledge`, `apis`.
- Must not collide with an existing connector or another hosted server's id.
  There is no tool that lets you check this list before you write files, so
  pick something specific to what the server does (`pubmed-lookup`, not
  `search`) — a generic id is more likely to already be taken. If the user
  says your server never showed up on the Servers page, an id collision is
  the first thing to suspect; rename the directory and `manifest.json`'s `id`
  together and try again.

The directory name and `manifest.json`'s `id` field must match.

## Writing the server (`index.mjs`)

Start from the scaffold — it already gets the protocol right — and add tools
to it rather than writing the JSON-RPC handling from scratch. It implements,
correctly, the four things a stdio MCP server must do: `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`.

Two rules matter more than anything else here, because getting either one
wrong produces a failure that looks like it has nothing to do with the actual
mistake:

**1. Nothing may ever be written to stdout except one JSON-RPC message per
line.** stdout is the wire Acabox uses to talk to your server. A stray
`console.log`, a library that logs to stdout by default, a debug `print` you
forgot to remove — any of these corrupt the next message and the failure the
user sees is an inscrutable "not valid JSON" error with no obvious connection
to logging. This is the single most common way a hand-written MCP server
breaks. **All diagnostic output goes to stderr** — the scaffold's `log()`
helper does this for you; never call `console.log`/`console.info` in this
file, only `console.error` or `log()`.

**2. The server must exit when stdin closes, and must not exit before then.**
Acabox closes your server's stdin to stop it (paused by the user, or Acabox
quitting). If your process keeps running after that, it becomes an orphan —
exactly the failure mode Acabox's own dictation helper had and fixed the same
way (track in-flight work, exit only once it reaches zero; see the comments
in the scaffold). Conversely, don't exit early just because you handled one
message — more may follow on the same connection.

The scaffold's JSON-RPC layer (message framing, the `initialize` handshake,
routing `tools/call` to the right handler, the exit-on-stdin-close logic) is
the part you should not need to touch. Add tools by extending the `TOOLS`
array: a `name`, a `description` written for the model, a JSON Schema
`inputSchema`, and an async `handler(args)` that returns
`{ content: [{ type: 'text', text }] }`. If a call reaches your handler with
a value the schema alone couldn't stop (a model sending the wrong type, a bad
enum value), validate it for real inside `handler` and return
`{ content: [...], isError: true }` — the scaffold's example tool does
exactly this. An `isError` result is for "the tool ran, and failed"; a call
naming a tool that doesn't exist at all is a protocol-level error the
plumbing already handles for you.

## Testing before you tell the user it's ready

Run the server yourself and speak MCP at it over stdin — do not hand it to
the user unverified. From the workspace root:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"<your_tool_name>","arguments":{"...":"..."}}}' \
  | node .mcp-servers/<id>/index.mjs
```

What you should see on stdout: exactly three JSON lines (nothing else —
anything else on stdout is Rule 1 broken), an `initialize` result carrying
your server's name, a `tools/list` result listing your tool(s) with their
schemas, and a `tools/call` result with your tool's real output. The command
should return promptly once stdin (the piped input) is exhausted — if it
hangs, your server is not exiting on stdin close (Rule 2); fix that before
anything else. Also try calling your tool with a bad argument to confirm your
`isError` path actually fires, and check stderr (redirect `2>&1 1>/dev/null`
to see it alone) for anything you didn't expect to be logged.

## The approval boundary — you write, the user approves

**There is no tool that registers, enables, or starts a server — do not go
looking for one, because it deliberately does not exist.** You write files;
Acabox notices the directory and lists it on the Servers page under
"Authored by Claude"; the user reviews it and turns it on. This is the same
shape as skill import (`skillStore.ts`) and for the same reason: whether the
agent gains a new persistent capability is not a decision this skill gets to
make on the user's behalf. A server you just wrote always arrives **disabled**
— there is no way to make it arrive enabled, and asking the user to enable it
for you is the correct next step, not a workaround.

**On enable, Acabox copies the whole directory out of the workspace into its
own app-data area and runs *that* copy — never the one in
`.mcp-servers/<id>/`.** This matters for anything you do after approval:

- **Editing the workspace copy after the user has approved it does nothing
  to the running server.** You have Write and Bash on the workspace, so code
  you can still edit is code you could change *after* the user already
  reviewed and approved it — which is exactly the trust problem this copy
  step exists to close. If you fix a bug or add a tool to an already-running
  server, tell the user plainly that the change won't take effect until they
  re-promote it (the Servers page shows a "changes since you approved ·
  Review" prompt for exactly this) — do not imply the fix is already live.
- **The running copy's working directory is its own folder, not the
  workspace.** Once promoted, your server's `cwd` defaults to a directory
  under Acabox's own app-data area, not `<workspace>/`. Don't write a tool
  that assumes it can reach a user's research files with a workspace-relative
  path the way a Bash command or a mini-app can — if a tool genuinely needs
  to read or write a file, that path has to arrive as a **tool argument**
  (and the caller, i.e. you in a future chat, is responsible for passing one
  that resolves correctly for whoever's running it), not something the server
  resolves relative to its own directory.
- The host also gives the running server a deliberately narrow environment —
  not a copy of the agent's own env. Notably absent: `ANTHROPIC_API_KEY`,
  `ACABOX_API_TOKEN`, and **`NODE_PATH`** (excluded specifically so a
  workspace-installed module can never shadow the server's own code). Don't
  design a tool that assumes it can read Acabox's credentials or reach
  anything installed for mini-apps — it can't, on purpose.
- The host's own readiness check (this is what actually turns a server
  "Available" after the user enables it) is `initialize` + `tools/list`
  answering within 20 seconds of spawn. Don't do slow work — a network call,
  a large download — synchronously during startup; do it lazily, inside a
  tool's `handler`, the first time it's actually needed.

**Every tool your server offers will be auto-approved once it's running** —
Acabox has no permission prompt for MCP tool calls of any kind, hosted or
otherwise. If a tool can write, delete, spend money, or send something
externally, say so plainly when you hand the server to the user; do not let
them discover that from what it did.

## Dependencies: write this with none

**Prefer zero runtime dependencies. In practice, for a `.mcp-servers/<id>/`
server, this is closer to a hard requirement than a preference**, for a
concrete reason, not just "less is better": the install wrapper
(`.applications/install`) cannot target this directory at all. Read
`.claude/skills/manage-mini-application/assets/install` and you'll see it
hard-codes `APP_DIR=".applications/$APP"` and refuses immediately
(`app directory not found`) if that directory doesn't exist — which
`.mcp-servers/<id>/` never will, because it isn't a mini-app. There is
currently no sanctioned `--app` target for a server directory, and pointing
`--app` at some unrelated existing mini-app would record the dependency in
the wrong app's `package.json`/`requirements.txt`, which is not what the
wrapper is for and will not help you.

Even setting that aside, it wouldn't work at runtime anyway: a package
installed via `npm` lands in Acabox's *shared* npm prefix, resolved by other
processes through `NODE_PATH` — and the hosted server's own environment
deliberately excludes `NODE_PATH` (see above). So there is no path today,
sanctioned or otherwise, that gets a third-party npm or pip package into a
running hosted server.

Write with Node's built-ins only (`node:fs`, `node:path`, `node:https`,
`node:child_process`, `node:readline`, ...) — this covers far more than it
looks like at first: HTTP calls, file I/O, spawning another local process, JSON
parsing. If what you're building genuinely cannot be done without a
third-party package, say so to the user rather than trying to force an
install through — mention that this class of server can't take on
dependencies today, and that if the capability really needs one, a mini-app
(which does get real esbuild-bundled npm dependencies) might be the better
fit even though it means adding a UI.

## Editing an already-approved server

1. Edit `.mcp-servers/<id>/index.mjs` (and `manifest.json` if the name or
   description changed) in the workspace, same as any other file.
2. Test it yourself the same way as before creating it.
3. Tell the user what changed, and that they need to re-approve it on the
   Servers page for the change to reach the running copy — see "The approval
   boundary" above. Don't say "done" as if the fix is already live.

## If something goes wrong

The Servers page turns a real failure into a specific, plain-English message
— check what it actually says before guessing:

| What the user reports | Likely cause |
|---|---|
| "This server printed ... to its own output ... log to stderr instead" | You (or something you imported — but you shouldn't be importing anything) wrote to stdout. Re-read Rule 1 above. |
| "Acabox could not find \"...\". It is not installed, or not on the path Acabox sees." | Wrong command/path — but for this skill's servers the command is always `node`/the resolved Node binary running `index.mjs`, so this usually means the file isn't where the manifest says it is. |
| "Exited immediately and said nothing" | Your script threw during startup, before installing any handlers — check by running the manual test above and reading stderr. |
| "Started, but never answered." | `initialize` or `tools/list` never returned — likely a bug that hangs before responding, or startup work that takes longer than 20s (move it into a tool handler instead). |
| Server never appears on the Servers page at all | Likely an id collision (see "The directory contract") or a `manifest.json`/`index.mjs` that isn't valid — re-check both files exist with matching `id`s. |

## Telling the user

Don't show a `tools/list` dump. Say what the server actually lets Claude do,
in the user's terms — the same "Claude can now read and write files in
~/Data" register a mini-app confirmation uses — and that it's on the Servers
page, off, waiting for them to review and turn it on before it does anything.
