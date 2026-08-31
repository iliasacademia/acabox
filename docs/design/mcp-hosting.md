# Local MCP servers: host, manage, and author them in Acabox

> **Status: Increments 0–5, 7 and 8 are built and green. 6 and most of 9 are not.**
> Written 2026-08-05 as a proposal; brought in line with the code 2026-08-31.
> Measured on that date, not recalled: `npx tsc --noEmit` clean,
> `npm test` **1055/1055 across 67 suites**, `npm start -- -- --smoke-test` exits 0.
>
> | Increment | State |
> |---|---|
> | 0 Spike | Done. R4 and S5 answered below; S1/S3/S4 retired and S2 folded into 4 (see the 2026-08-13 decision) |
> | 1 Quit teardown | Done — `main/appTeardown.ts` on `will-quit` |
> | 2 Supervisor | Done — `main/mcpHost/`, 8 modules / 11 test files |
> | 3 Servers page | Done — `renderer/components/servers/`, `mcpServerStore.ts` |
> | 4 Agent reach | Done — `agent-server/dynamicMcp.ts`, `jsonSchemaToZod.ts` |
> | 5 Claude authors | Done — `mcpHost/authored.ts`, `skills/manage-mcp-server` |
> | 6 Install from GitHub/npm | **Not started** |
> | 7 Write gate | Done, reshaped — per-tool `enabledTools`, not a boolean (2026-08-13 decision) |
> | 8 Scheduler on Activity | Done — `renderer/components/schedule/`, section on Activity |
> | 9 Hardening | Partial — this header and CLAUDE.md; log rotation outstanding |
>
> **Unverified, and the first one is the one that matters.** The Increment 5 user
> journey has never been driven end to end by a human — chat turn → Claude writes a
> server → *Authored by Claude* row → enable → promote → agent calls it → quit →
> reopen. Its parts are tested; the funnel is not, and cutting the catalog (see the
> 2026-08-05 decision) made it the only acquisition path there is. Also unverified:
> the "Published by your tools" section with a mini-app actually mounted, and R3's
> `runtime` field, which was never added — so "we control `NODE_MODULE_VERSION`"
> remains narrower than stated for the Advanced typed-command path.
>
> Effort figures in the increment headings are the original estimates, left as
> written. See R18 for the revision.
>
> Open questions a product review should weigh in on are collected at the end under
> **"Product questions"**.

---

## Review — 2026-08-05 (annotations marked **R#** throughout)

I re-measured the load-bearing claims rather than taking them on trust. **They hold.**
Two `before-quit` listeners with the second running unconditionally
(`main/index.ts:3032`, `:3062`); seven relays registered via `createSdkMcpServer`
(`agent-server/index.ts:204,221,240,254,291,312,336`); `preserveUntouchedSecrets`
destroying `env` at `connectorsStore.ts:151`; `d.args.trim().split(/\s+/)` at
`ConnectorsSettings.tsx:96`; `@modelcontextprotocol/sdk@1.29.0` present on disk;
`descendantsOf` private to `jobRegistry.ts:154` with its "deliberately NOT `kill(-pid)`"
comment; `apiProxy.start()` at `AgentInfrastructureController.ts:341`. The engineering
research here is better than most of what ships in this repo, and the increment
boundaries are honest.

**The gap is the stated target, not the engineering.** The goal is *"works flawlessly
for a non-technical user."* What Increment 3 describes is a developer console: a command
field, an argv row editor, an env-key grid, a pid, a log tail, and the word "stdio". A
scientist cannot author `npx -y @modelcontextprotocol/server-filesystem`, and if they
paste it from a README it will fail under a GUI launch for reasons the page cannot
explain. Every increment below is *correct*; the plan is missing the layer that makes
any of it reachable.

### Must fix before starting

| | Fix | Where |
|---|---|---|
| **R1** | Catalog-first add flow. Freeform argv moves behind **Advanced**. | New Increment 3a — the single highest-value change in this review |
| **R2** | Install from **npm**, not only GitHub. It is the dominant channel and the plan's own fallback example. | Increment 6 |
| **R3** | The "we control `NODE_MODULE_VERSION`" claim only covers servers *we* installed. Add an explicit `runtime` field. | Increment 6.4 |
| **R4** | The MCP SDK is a **transitive** dep and is never spiked in the **main** webpack bundle, which is where Increment 2 needs it. | Increment 0, new S5 |
| **R5** | No orphan story for the crash path. Clean quit is covered; `SIGKILL` is not. | Increment 2 |
| **R7** | No context-budget analysis for hosted tool schemas. This repo has already shipped an over-budget listing once. | Increment 0, new S6 |

### Should fix

R6 (readiness races the first turn) · R8 (stdout pollution is the #1 stdio failure and
is undiagnosed) · R9 (the smoke test does not reach `mcpHost` at all) · R10 (`startAll`
has two call sites and must be single-flight) · R11 (proxy/CA env vars) · R12 (two
Acabox instances spawn the same child twice) · R13 (uninstall reclaims nothing) ·
R14 (bounded `will-quit` needs a hard timer) · R15 (write gate lands too late, and
"one boolean" needs defining) · R17 (verification additions) · R19 (the disclosure copy
is jargon) · R20 (the Python exclusion is right for the wrong reason) · R18 (the
estimate excludes all of the above).

Answers to the seven **Product questions** are at the very end, under *"Review: answers
to the product questions."*

### On sequencing

The plan's own Q7 recommends building to Increment 4. **Agreed, with one change: fold
the catalog (R1) into that run and pull the write gate (Increment 7) ahead of the
installer (Increment 6).** Rationale in the R15 annotation. Increment 3 shipped *alone*
gives a non-technical user a new top-level nav item listing things they cannot add and
that do nothing when added — a worse first impression than the current absence.

### One thing to do today, regardless

**Increment 1 is a live bug with a 1.5-day fix and no dependency on any of this.**
Right now, clicking **Cancel** on the quit dialog SIGTERMs the agent server and kernel
gateway, stops the file monitor, dictation, scheduler and background builder,
invalidates every API-proxy token, and closes three SQLite handles — while leaving the
app open. I re-read `main/index.ts:3032-3086` and confirmed it: listener #2 has no
`quitConfirmed` guard and runs inside the same `emit()`. Ship that fix on its own
branch this week even if the rest of the document is shelved.

---

## Context

The fork's charter says mini-apps can "create and run MCP servers that the agent and
other mini-apps can call." That capability exists in code
(`main/miniAppMcpRegistry.ts`, 172 lines, complete) but is iframe-bound, has **zero
UI**, and **zero of the four installed mini-apps declare an `mcp` block** — it has
never been used.

Separately, a user *can* configure a `stdio` MCP server today via Settings →
Connectors, but three measured facts make that a dead end:

1. **Acabox does not host it.** The connector is serialized into the SDK's
   `mcpServers` option (`shared/connectors.ts:252`) and the **per-turn Claude Code CLI
   subprocess** spawns the child, then kills it at turn end. Measured in the
   production log: 58 `Creating session` = 58 `Starting query()`, no session ever
   received a second message. So the server is spawned and killed **once per chat
   message** — not "while Acabox is on."
2. **It cannot be configured.** `ConnectorsSettings.tsx:96` parses args as
   `d.args.trim().split(/\s+/)` and the CLI spawns `shell:false`, so no typable
   string produces working argv for a path containing a space. The string `env`
   appears **0 times** in that file. And `connectorsStore.ts:151`
   (`if (!incoming) return undefined`) silently destroys a hand-edited `env` on the
   next Save.
3. **It leaks credentials.** The stdio child inherits the agent server's entire
   environment, including the raw `ANTHROPIC_API_KEY` and `ACABOX_API_TOKEN`.

**Outcome intended:** a top-level **Servers** category where the user can spin up,
see, pause, restart and delete local MCP servers that stay alive for the life of the
app; can install one from a GitHub repo; and can ask Claude to write one. Servers are
**local-only** — reachable by the in-app agent, never exposed on a network port.

Verified state: only one connector exists (`hex`, `http`). **Zero stdio connectors**,
so the connector-form cleanup below has no migration cost.

---

## Architecture: SDK relay, not a loopback bridge

The obvious design — Acabox runs an HTTP MCP server on loopback and points the CLI at
it — is probably unnecessary. Reading the shipped
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, `setMcpServers` special-cases
`type:'sdk'` entries with an `instance`, and `connectSdkMcpServer` reduces to
`instance.connect(transport)`. The only contract on `instance` is that it speaks MCP
JSON-RPC.

**This path is already proven in production in this repo.** `agent-server/index.ts`
registers seven such relay servers (`:204, :221, :240, :254, :291, :312, :336`), each
relaying to main over `mcp-call` SSE (`:179`) and `POST /sessions/:id/mcp-result`
(`:1042`), landing at `__hostMcpServers` (`main/agentSession.ts:940`). Those tools
fire every day.

So:

```
main process                          agent-server                CLI subprocess
──────────────                        ────────────                ──────────────
mcpHost.supervisor
  ├ spawn child (StdioClientTransport)
  ├ ONE Client ⟷ child, one initialize, forever
  ├ tools/list at readiness ──────────▶ POST /hosted {inventory}
  │                                       builds one relay server per id
  │                                       setMcpServers({relays,connectors,hosted})
  ◀── SSE 'mcp-call' ◀───────────────────  tools/call handler
  ├ callQueue → client.callTool
  └ POST /sessions/:id/mcp-result ─────▶ resolve
```

**Why this wins:** no port (so no fifth range, no cross-instance adoption hazard), no
bearer token, no JSON-RPC session table, no Streamable-HTTP compliance. It matches
"local-only" exactly. And because **we own the call site**, the per-tool write gate is
free — strictly more expressive than the SDK's `permission_policy`, which by type
does not exist on stdio configs anyway (`sdk.d.ts:1050-1059` has no `tools?` field;
it is on http/sse only).

**Main owns the child, not the agent-server** — the agent-server is itself
crash-restarted (`containerService.ts:513-541`), so hosting there would kill every
server on every restart, which is the exact failure this removes.

---

## Increment 0 — Spike (1 day). Gate on this.

Reuse the standalone agent-server harness already documented in CLAUDE.md:135-145.
Run under the **Electron binary as node** (`ELECTRON_RUN_AS_NODE=1`), not the shell's
node — Electron is v22.17/ABI 136, the shell is v25.9/ABI 141.

| # | Question | Success criterion |
|---|---|---|
| S1 | Control: does an existing sdk relay tool fire on demand? | Prompt forces `mcp__apis__list_apis`; host handler logs it |
| S2 | **Can an sdk server's tool list be built at runtime from JSON Schema?** | Model calls a tool whose schema was never hand-written, **with correctly typed args** |
| S3 | Can `setMcpServers` **add** an sdk server mid-session? | `{added:['probe2']}` and the model calls `mcp__probe2__*` in the same session |
| S4 | Does one hosted child serve N sequential CLI sessions? | Three sequential runs, `$PROBE_LOG` shows exactly **one pid** |

**S2 is the real unknown.** `tool()` takes an `AnyZodRawShape` (`sdk.d.ts:5368`) and
every existing relay has a hand-written zod schema. Two variants, 1h each:
- **S2a** — hand-rolled JSON-Schema→zod for the six shapes that matter (string,
  number, boolean, enum, array-of-string, object), degrading to
  `z.record(z.string(), z.unknown())`.
- **S2b** — raw `Server` from `@modelcontextprotocol/sdk/server/mcp.js` with upstream
  JSON Schema verbatim. **`npx tsc --noEmit` clean is an explicit pass criterion** —
  that package is transitive-only, `"type":"module"`, and this repo is
  `"moduleResolution":"node"`, so subpath resolution is expected to fail. Also
  requires a clean `npm run build:agent-server`.

**Decision:** S2a or S2b passing ⇒ proceed as planned. Both failing ⇒ tools degrade to
an untyped passthrough (the compromise `call_published_tool` already makes at
`agent-server/index.ts:272-280`) — ship the supervisor and UI, defer agent reach.
**S4 showing more than one pid ⇒ the premise is wrong; stop.**

Record the numbers in `docs/design/mcp-hosting.md` and in module header comments, in
the style of `freePort.ts` and `apiProxy.ts:18-30`.

> ### R4 — Two more spike questions, and both are cheaper than the ones listed
>
> The spike tests the **agent-server** bundle (S2b) and standalone node. Increment 2
> needs `StdioClientTransport` in the **main process**, which is a different module
> universe and is not covered by anything above. Measured just now:
>
> - `@modelcontextprotocol/sdk@1.29.0` is **not a direct dependency** — it is
>   transitive under `@anthropic-ai/claude-agent-sdk@0.2.121`. Any SDK bump can move,
>   dedupe or hoist it away, and nothing in CI would notice until a spawn throws at
>   runtime. **Add it to `package.json` as a direct, exactly-pinned dependency in
>   Increment 0**, before writing a line against it. This costs 5 minutes now and is a
>   silent production breakage later.
> - It is `"type": "module"` with an `exports` map and **no `main`/`types` field**.
>   This repo is `"module": "commonjs"` + `"moduleResolution": "node"`
>   (`tsconfig.json:4,11`), which **ignores `exports` entirely** and resolves by
>   directory layout — so `@modelcontextprotocol/sdk/client/stdio` does not resolve.
>   There is a CJS build at `dist/cjs/client/stdio.js`, so the runtime story is fine;
>   the *type* story needs a decision (a `paths` entry, a local `.d.ts` shim, or a
>   narrow hand-written interface over the three methods we use). Decide it in the
>   spike, not in the middle of Increment 2.
> - `webpack.main.config.js:17-27` lists exactly three externals
>   (`better-sqlite3`, `@anthropic-ai/claude-agent-sdk`, `esbuild`) plus `.node` files.
>   The MCP SDK is **not** among them, so it gets bundled into the main bundle.
>   Whether webpack 5 picks the `require` condition cleanly, and whether the package's
>   lazy `validation/*` imports survive bundling, is unknown.
>
> | # | Question | Success criterion |
> |---|---|---|
> | **S5** | Does `StdioClientTransport` work from the **main webpack bundle**, dev *and* packaged? | `npm start` spawns the echo fixture and completes `initialize`; then **one `npm run package`** and the same thing works from `Acabox.app`. No webpack warning about a critical dependency. |
> | **S6** | What does one hosted server cost in **context**? | Register a server with ~12 tools; diff the system-prompt/tool-schema token count against baseline. See R7 — this is a real budget, and this repo has already blown one. |
>
> S5 is ~2h and is the only question whose failure mode is "discovered in a packaged
> build after Increment 6." Note that a packaged run is normally banned for routine
> testing (CLAUDE.md Conventions) — this is the exception, and it should happen **once,
> here**, rather than at the end.

### Spike results — module resolution (R4), measured 2026-08-05

Measured under `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/.../Electron`
(v22.17 / ABI 136 — the runtime that matters, not the shell's v25.9) and with the
repo's real `npx tsc --noEmit`. **R4's concern was well-founded but its conclusion was
wrong: no `paths` entry and no `.d.ts` shim are needed.**

| Specifier | Runtime `require` | `tsc --noEmit` types |
|---|---|---|
| `@modelcontextprotocol/sdk/client/stdio.js` | ✅ `dist/cjs/client/stdio.js` | ✅ resolves |
| `@modelcontextprotocol/sdk/client/index.js` | ✅ `dist/cjs/client/index.js` | ✅ resolves |
| `@modelcontextprotocol/sdk/shared/transport.js` | — (type-only) | ✅ resolves |
| `@modelcontextprotocol/sdk/client` *(extensionless)* | ✅ | ❌ `TS2307` |
| `@modelcontextprotocol/sdk` *(bare)* | ❌ `MODULE_NOT_FOUND` | — |

**Why it works**, which matters because "it works and nobody knows why" is fragile
across a TS or SDK upgrade — two independent mechanisms happen to line up:

- **Runtime:** the `exports` map's 9th key is a **`"./*"` wildcard** →
  `{"require": "./dist/cjs/*"}`. An exact-key lookup for `./client/stdio.js` returns
  nothing, which is what makes this look broken on inspection; the wildcard is what
  actually serves it.
- **Types:** the package ships `typesVersions: {"*": {"*": ["./dist/esm/*"]}}`, the
  legacy mechanism that `moduleResolution: node` *does* honour (it ignores `exports`
  entirely). That is the whole reason no `paths` entry is required.

**Two rules for anyone writing against this package here:**

1. **Always use the `.js`-suffixed deep path.** The extensionless form resolves at
   runtime but not for types, so it fails only at `tsc` — and the bare specifier fails
   at runtime only, which is worse.
2. **Never import the bare `@modelcontextprotocol/sdk`.** Its `.` export points at
   `./dist/cjs/index.js`, and **that file does not exist in 1.29.0** — an upstream
   packaging bug, not a resolution subtlety.

Also confirmed: `client/stdio.js` exports `StdioClientTransport`,
`getDefaultEnvironment`, **and `DEFAULT_INHERITED_ENV_VARS`** — so Increment 2's env
allowlist can import the upstream list by reference instead of transcribing it, which
is what the plan asks for.

**Done:** pinned as a direct exact dependency (`"@modelcontextprotocol/sdk": "1.29.0"`,
deduped against the transitive copy; tsc clean and 763/763 after).

### Spike results — S5, webpack main bundle. **PASS, no config change needed.**

Measured 2026-08-05 by importing `StdioClientTransport` into the real main process,
spawning the real fixture, and completing `initialize` + `tools/list` — in **dev and in
a packaged `Acabox.app`**. R4's speculative fallback (externalise the SDK, or hand-roll
a transport) was not needed and is now off the table.

- **Zero webpack warnings** in both builds — grepped for "Critical dependency", "the
  request of a dependency is an expression", "Can't resolve", "Module not found".
- **Bundle delta:** +850 KB dev (unminified, +7.5%), **+333 KB packaged** (minified,
  +8.1%). It is real reachable code, not dead weight: R4 guessed the `validation/*`
  imports were lazy, but `client/index.js` does an **eager, unconditional**
  `require("../validation/ajv-provider.js")`. Webpack tree-reached correctly —
  `ajv-provider` is in the bundle, the unreached `cfworker-provider` is not.
- **`DEFAULT_INHERITED_ENV_VARS` survives bundling** with its real value, and was
  functionally exercised. Increment 2's allowlist imports it by reference.
- **`transport.pid` is populated synchronously the instant `client.connect()` is
  called** — not when the promise resolves. Verified identically across plain node,
  Electron-as-node, the dev bundle and the packaged bundle. The supervisor's tree-kill
  can rely on having a pid essentially immediately, which removes a race the design was
  going to have to defend against.

**Operational finding worth a CLAUDE.md Conventions line (Increment 9).** The packaged
run first hung indefinitely. Root-caused with `sample`, not guessed: the main thread was
blocked in `SecKeychainFindGenericPassword → CSSM_DecryptDataFinal` — Chromium's own
OSCrypt keychain init, which runs *before* `app.whenReady()` and cannot be moved. Every
freshly `npm run package`-built, ad-hoc-signed binary carries a new signature, so macOS
demands fresh Keychain authorization; with no interactive session to click the dialog,
the process waits forever. **Not a product bug** — a real user double-clicking the app
sees and dismisses that prompt. It is an artifact of headless testing of packaged
builds, and it is the same root cause as the auto-update TCC re-prompt already recorded
in CLAUDE.md's Known hazards (ad-hoc signature changes every build). Workaround for
measurement only: Chromium's `--use-mock-keychain` flag, no code change.

### DECISION (2026-08-13): S1/S3/S4 are retired. S2 is folded into Increment 4.

Increment 0 said "gate on this". Re-examined before spending a day on it, **three of
the four questions no longer need running, and the fourth is no longer a gate**. The
gate's purpose was to avoid building on a false premise; the premise turned out to be
either already proven or no longer load-bearing.

| # | Verdict |
|---|---|
| **S1** — does an sdk relay tool fire on demand? | **Retired: already answered in production.** The seven relays at `agent-server/index.ts:204-336` fire every day. Running S1 would re-prove a fact the app depends on continuously. |
| **S2** — runtime tool list from JSON Schema | **The only real question.** See below. |
| **S3** — `setMcpServers` adds a server mid-session | **Not a gate.** Has a documented fallback (apply at session creation, exactly as skills already do), so its failure costs a newly-enabled server being reachable next turn instead of this one. R6 wants the mid-session path and Increment 4 builds it — but as a requirement to *test*, not a premise to *gate on*. |
| **S4** — one child serves N sequential sessions | **Obsolete.** It was written against the old premise, where the CLI subprocess spawns the child. Under architecture D **main owns the child**, so surviving across sessions is structural rather than something to discover. `--smoke-test-mcp` already demonstrates the child living independently of any session. |

**S2 is not run as a spike because a spike would be throwaway.** Its subject —
JSON Schema → `AnyZodRawShape` — is production code Increment 4 needs regardless, so
it is written as `agent-server/jsonSchemaToZod.ts` with real unit tests, and S2's
actual question is answered by Increment 4's own acceptance turn.

The risk this accepts is bounded and was the reason for the gate in the first place:
if the model turns out to mishandle a runtime-built schema, the fallback is the
**untyped passthrough** the plan already specifies (the compromise
`call_published_tool` makes at `agent-server/index.ts:272-280`). That is a change to
one function, not a redesign — which is precisely why gating a day of work on it was
not worth it.

**What still must be proven, and how.** Unit tests can show our converter emits the
right zod; they cannot show the *model* calls a runtime-schema'd tool with correctly
typed arguments. Only a real turn against the real API answers that, so it is an
acceptance criterion of Increment 4 rather than a spike:

> A hosted server exposing a tool whose schema was never hand-written — with a
> required enum, an optional integer, and an array of strings — is called by the model
> with all three correctly typed, in a real chat turn.

No API key needs to leave the app: both the `development` and `production` channels
already hold an encrypted key, so this runs through the app itself over CDP, the same
way Increment 3's visual verification did.

---

## Increment 1 — Fix quit teardown (1.5 days). Hard blocker.

`main/index.ts` has two `before-quit` listeners and **no `will-quit` listener
anywhere**. Listener #1 (`:3032`) calls `event.preventDefault()` at `:3041`; listener
#2 (`:3063`) runs 12 non-idempotent teardown steps and **fires even when the user
clicks Cancel** — `preventDefault` sets a flag read after `emit()` returns. On accept,
the nested `app.quit()` at `:3060` re-emits and the teardown runs **twice**.

Today that means clicking **Cancel** on the quit dialog SIGTERMs your agent server and
kernel gateway, stops the file monitor, dictation, scheduler and background builder,
invalidates every API-proxy token, and closes three SQLite handles — while leaving the
app open.

Fix, independent of everything else:
1. Extract the 12 steps into one exported `teardown()` guarded by
   `let tornDown = false`.
2. Move it from `before-quit` to **`will-quit`** (fires only after an uncancelled
   `before-quit`, and not re-emitted by a nested quit). `before-quit` keeps only the
   dialog.
3. Hosted-MCP shutdown is async, so take one bounded `preventDefault` inside
   `will-quit`, then `app.exit(0)` — **not** `app.quit()`, which would re-enter the
   emit chain.

**Verified:** real `npm start`, click Cancel, grep `cobuilding.log` for exactly one
set of step names; then quit for real and grep for exactly one more.

> ### R14 — The bounded `preventDefault` needs a hard floor, and the ordering matters
>
> Right as far as it goes. Three additions, all cheap:
>
> 1. **A watchdog, not just a deadline.** "One bounded `preventDefault` then
>    `app.exit(0)`" describes the happy path. Arm an unconditional
>    `setTimeout(() => app.exit(0), N).unref()` the instant `will-quit` fires, *before*
>    awaiting anything. A hung `client.close()` on a wedged stdio child is exactly the
>    case this exists for, and "await with a timeout" fails if the await itself never
>    settles. Budget: ~4s total (3s graceful + 1s slack), matching
>    `jobRegistry`'s existing 3s SIGTERM→SIGKILL window.
> 2. **Order teardown so the DB closes last, and hosted MCP closes first.** The current
>    array already ends with three `close*Database` calls; hosted shutdown must go at
>    the *front*, because a server mid-`tools/call` may be writing through a relay that
>    touches those handles.
> 3. **`tornDown` must also be set on the `app.exit(0)` path**, or a second `will-quit`
>    from a different trigger (tray quit vs ⌘Q vs `app.relaunch()` in the Debug hard
>    reset at `index.ts`) re-enters. Test it from all three entry points, not just ⌘Q —
>    the hard-reset path calls `app.relaunch()` + `app.quit()` and is the one most
>    likely to be forgotten.
>
> Also worth stating in the module comment: **`app.exit(0)` skips the `quit` event and
> any remaining `will-quit` listeners.** That is the intent, but a future reader adding
> a `quit` listener will find it silently dead. One sentence prevents that.

---

## Increment 2 — Supervisor (2 days)

New tree `src/cobuilding/main/mcpHost/` (not `main/mcpServers/`, which already holds
the notification/reaction relay definitions).

| Module | Responsibility |
|---|---|
| `index.ts` | singleton façade: `startAll/start/pause/stop/restart/remove/list/inventory/invoke/onInventoryChanged/shutdown` |
| `supervisor.ts` | spawn, readiness, health, restart policy, teardown |
| `hostedEnv.ts` | env **allowlist** construction |
| `callQueue.ts` | per-server bounded concurrency |
| `store.ts` | sealed `<userData>/mcp-servers/servers.json` |
| `diagnose.ts` | error string → actionable message |
| `processTree.ts` | **extracted** from `jobRegistry.ts:133-169` |

**Spawn** via `StdioClientTransport` from the MCP SDK (already on disk): it handles
newline framing, takes `cwd`/`env`/`stderr:'pipe'`, exposes `.pid`, and spawns with
`shell:false` and **no `detached`** — which is what the
`jobRegistry.ts:144-153` constraint requires (children share Acabox's process group, so
`kill(-pid)` would kill the app).

**Env is an allowlist, not spread-and-strip.** Start from the MCP SDK's own POSIX
`DEFAULT_INHERITED_ENV_VARS` (`HOME LOGNAME PATH SHELL TERM USER`), add
`TMPDIR LANG LC_ALL TZ`, override `PATH` from `getLoginShellPath()`, then layer the
record's decrypted `env`. Nothing else. This is the credential-leak fix: there is
nothing to strip because nothing is spread.

**Readiness** is not an HTTP probe — it is `initialize` + `client.listTools()`
returning. That is the only honest liveness signal for an MCP server and it doubles as
the tool inventory, which is what makes an inventory exist **before any chat turn**.
20s deadline; `transport.stderr` piped into a per-server ring buffer.

**Restart:** jittered backoff 1→30s, `failed` after 6 consecutive failures.
**The backoff counter resets after 60s of continuous readiness** — the explicit fix
for `containerService.ts`'s `agentRestartTimestamps`, which only ages out and is never
cleared by a successful run. Do **not** infer "stopped by us" from `signal==='SIGTERM'`
the way `:520` does; use an explicit `intent` field.

**Concurrency defaults to 1** (FIFO queue, depth cap 32, 90s per-call timeout — under
the relay's 120s so our message wins). Not a regression: today the CLI gives each
session its own child, so per-caller concurrency is already 1, and sharing one child
at concurrency 1 is strictly better for a stateful server than N divergent copies.

**Do not register hosted servers in `jobRegistry`.** Its `running` jobs are never
pruned (`:106`) and `activeJobs()` drives the quit dialog (`index.ts:3038`) — a daemon
there would prompt "N pieces of work are still running" on **every** quit. Share the
tree-kill *implementation* via `processTree.ts`; not the registry.

**Persistence:** `<userData>/mcp-servers/servers.json`, a new file — not
`cobuilding-settings.json`, which is read-modify-written by half a dozen call sites
with no locking. Seal the record array through **`secretStore.encryptSecret`**: an
attacker with a shell cannot call Electron's `safeStorage`, so tamper-evidence falls
out of decryption failure without inventing an HMAC (the repo has none). A record that
fails to decrypt is **dropped loudly**, never repaired. If
`isEncryptionAvailable()` is false, hosted MCP **refuses to autostart** and says why.

> ### R5 — There is no orphan story for the crash path. This is the one I'd fix first.
>
> Teardown covers a *clean* quit. It does not cover `SIGKILL`, a main-process crash, a
> force-quit, or the Debug hard reset's `app.relaunch()`. In every one of those the
> stdio children survive — they are spawned without `detached` but a parent's death does
> not kill a child on POSIX, which this repo **already established by measurement**
> (CLAUDE.md: a mini-app's shell command "completes normally after Acabox has fully
> quit"). So the failure a user actually meets is: force-quit Acabox, reopen it, and now
> two copies of a stateful server are running, one of them unreachable.
>
> The fix already exists in this repo and the plan explicitly declines the wrong half of
> it. **Do not register in `jobRegistry`** — correct, for the quit-dialog reason given.
> But **do reuse its pid-signature idea** (`jobRegistry.ts:133`, `pidSignatureOf` via
> `/bin/ps -o lstart=`), which exists precisely because pid reuse makes a bare pid
> unsafe to signal:
>
> - Persist `{pid, signature}` into `servers.json` at spawn, clear it at clean exit.
> - At `startAll()`, for each record with a stale `{pid, signature}`: re-read the
>   signature; **if and only if it still matches**, tree-kill it before spawning fresh.
>   A mismatch means pid reuse — leave it alone.
> - Add this to `mcpHostTeardown.test.ts`: spawn the fixture, record the pair, kill the
>   *supervisor* without teardown, run `startAll()` on the same store, assert the old
>   pid is gone and exactly one new one exists.
>
> This also strengthens acceptance step 7, which today only tests the clean path.
>
> ### R10 — `startAll()` must be single-flight; it has two callers, not one
>
> The plan places it inside the `apiProxy.start()` → `startAgentServer` window, i.e.
> inside `AgentInfrastructureController.start()`. That function is invoked from **two**
> sites (`main/index.ts:1125` and `:1230`) and is renderer-triggered, so a renderer
> reload re-enters it. `ensurePythonVenv` is already single-flight for exactly this
> reason — follow it. Second call must be a no-op returning the same promise, **not** a
> second spawn wave.
>
> ### R11 — The env allowlist is right, and two omissions will break real users
>
> `HOME LOGNAME PATH SHELL TERM USER` + `TMPDIR LANG LC_ALL TZ` is a good floor. Missing:
>
> - **`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`** (and lowercase variants). A scientist
>   on a university or hospital network is behind a proxy, and a server that cannot
>   reach the internet with no explanation is indistinguishable from a broken server.
> - **`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`** — same population, TLS interception.
>
> Both carry a caveat worth writing down: a proxy URL can embed credentials
> (`http://user:pass@host`). Allowlist them, and **redact them in the log tail and in
> the detail panel's env display** the same way `apiProxy` redacts a `query`-auth
> secret from its refusal line. Add a `mcpHostEnv.test.ts` case: a canary password
> inside `HTTPS_PROXY` must not appear in the ring buffer.
>
> ### R8 — `diagnose.ts` needs a named list, and the top entry is stdout pollution
>
> A module called `diagnose.ts` with no enumerated cases becomes `String(err)` with a
> nicer font. Name them, and write one test per case:
>
> | Symptom | Plain-English message |
> |---|---|
> | **Server writes to stdout** | *The most common stdio MCP bug there is.* Any `console.log` in the server corrupts JSON-RPC framing; the surfaced error is an inscrutable JSON parse failure. Message: "This server prints messages to its output, which Acabox uses to talk to it. Ask its author to log to stderr instead." Add a `--noisy` flag to the echo fixture and test it. |
> | `ENOENT` on the command | "Acabox could not find `<cmd>`. It is not installed, or not on the path Acabox sees." Link to R3's runtime note. |
> | exit 127 | Same family, different cause: the command ran but *its* interpreter is missing. Distinguish them — CLAUDE.md already records that callers "kept getting this wrong". |
> | `EACCES` | "…is not executable." |
> | `NODE_MODULE_VERSION N … requires M` | "This server ships a compiled add-on built for a different version of Node." Do not offer a rebuild — Increment 6.4 correctly refuses source builds. |
> | Handshake timeout with a live pid | "Started, but never answered. It may be waiting for a password or a browser sign-in." This is the Keychain-prompt case the facebook server hits. |
> | Non-zero exit within 2s, stderr empty | "Exited immediately and said nothing." Show the log tail rather than inventing a cause. |
>
> ### R12 — Two Acabox instances now collide on **files** instead of ports
>
> "No port" is presented as removing a whole hazard class, and it does remove the
> `findFreePort` adoption bug. But dev and packaged builds are designed to coexist
> (CLAUDE.md), and both will now spawn *their own copy of the same server binary*,
> pointed at the same user data. For a stateless server that is fine. For a stateful one
> — SQLite, a cookie store, a lockfile — it is corruption, and the plan's own first
> candidate (`facebook-marketplace-mcp`, reading the live Chrome cookie DB) is exactly
> that shape.
>
> Per-channel `userData` separates the *installed copy*, not the data it touches. Two
> cheap mitigations, pick one: (a) an advisory lockfile per `id` under a shared path
> outside `userData`, with the second instance showing **Off · running in another
> Acabox window**; or (b) simply state the constraint in the disclosure copy. (a) is
> ~2h and is the honest answer.
>
> ### R13 — Nothing reclaims disk on remove
>
> `remove()` is in the façade list with no stated semantics. An installed server carries
> `node_modules` (a filesystem server is ~40MB), the `<userData>/mcp-servers/<id>/`
> copy, and its logs. This repo already has an unpruned-accumulation bug on record
> (`workspace-file-backups/<stamp>/`, "no counterpart to `pruneSkillsTrash`") — do not
> add a second. Specify: remove stops the process, deletes the userData tree, and
> reports bytes reclaimed. The workspace source in Increment 5 is *user* content and
> goes to trash, not `rm` — the `skillStore` `newTrashDir`/`moveInto` precedent.

---

### Increment 3 — done and **visually verified** (2026-08-05). 898 tests / 59 suites.

Built in two passes (plumbing, then UI) and then driven over CDP against a live dev
instance, because a green suite has never been evidence that a page renders — this repo's
Status section is full of entries where it wasn't.

**Verified rendered:** the rail item and page; the empty state; the built-in disclosure
(exactly 7 relays, read-only, no dots, no actions); Command Desk conformance against
`KnowledgePage` side by side; the args-rows editor with a live shell-quoted preview that
correctly quotes only the argument containing a space; the full disclosure text ending
*"It does not make it safe."*, unclipped; Connectors working remote-only; and — checked
via computed style, not eyeballed — the StatusBar segment and rail dot **absent** at zero,
as the no-mocks rule requires. Renderer console clean apart from the two normal dev-mode
notices.

**The empty state is the reviewer's critique answered, and it had to be seen to be
believed:** *"No servers yet. Ask Claude to build one for you — describe what you need in
a chat and it can write and run a small server."* with `Open chat` primary and
`Advanced: add a server yourself` secondary. The page subtitle states the product
distinction outright — *"Local MCP servers Acabox runs on this machine — separate from
Connectors, which are remote services Acabox connects to."*

**Three stale-copy bugs found and fixed**, all invisible to tests:
- **`ChromeBar.tsx:33` said `ACABOX — LOCAL VM`.** The fork deleted the Podman container;
  nothing has run in a VM since. Found by reading the screenshot, not by anyone looking
  for it — the same class of stale claim the de-Podman pass cleaned out of the agent-facing
  docs, still sitting in the app's own title bar.
- `ConnectorsSettings.tsx:364` — the Custom card still advertised "or a local command",
  contradicting the dropdown one click later, which no longer offers stdio.
- `builtinServerLabel()` title-cased `apis` into "Apis". Now an acronym map, keyed on the
  whole segment so it cannot shout a substring of a longer name.

**Not verified:** the "Published by your tools" section with a mini-app actually mounted.
The only installed tool has a **pre-existing, unrelated build failure**
(`Could not resolve "lucide-react"` / `"react-plotly.js"` — missing npm-site deps, visible
on Home before any of this work), so its iframe never mounts. The empty case is confirmed;
the populated case is not.

### Increment 2 wiring — done (2026-08-05). 841 tests / 53 suites, tsc clean.

`reconcileOrphans()` at main boot right after the single-instance lock, before anything
can spawn; `mcpHost.startAll()` in `AgentInfrastructureController.start()` between
`apiProxy.start()` and `startAgentServer`, fire-and-forget; the async `will-quit` seam
with R14's watchdog; and R9's `--smoke-test-mcp`.

**End-to-end proof, in the real app:** `npm start -- -- --smoke-test-mcp` exits 0 with
*"startAll() spawned the echo fixture, it reached ready, and echo() round-tripped"* — the
real Electron main process, the real webpack bundle, a real child, a real MCP tool call.
`--smoke-test` still exits 0 with the teardown running **exactly once**.

**Teardown ordering — keep it as built.** `runTeardown()` (synchronous, ending in three
SQLite closes) runs *before* the awaited `mcpHost.shutdown()`, which inverts R14's
suggested "hosted MCP first, DB last". That is deliberate and it is the safer order, for
a reason R14 did not consider: if `shutdown()` hangs and the 5s watchdog fires, teardown
has **already completed**, so the databases were closed cleanly. Shutdown-first would
risk `app.exit(0)` with open handles — trading a real data-integrity guarantee for a
hazard that has no concrete mechanism, since a hosted server is a separate OS process
with no access to Acabox's SQLite handles. Noted in `appTeardown.ts` so nobody "fixes" it
back without re-deriving this.

**Two smaller notes.** R9's "~20 lines" for `--smoke-test-mcp` was optimistic — ~90 once
registration, cleanup and error paths are real, though the shape it specified held up.
And `reconcileOrphans()` is idempotent *by construction*, not by luck: a record's
`{lastPid, lastPidSignature}` is cleared on first check, so the explicit boot call and
`startAll()`'s internal one cannot double-kill.

### Increment 2 build notes — findings from the real implementation (2026-08-05)

Built and green: **837 tests / 53 suites**, tsc clean. Modules as designed
(`processTree`, `hostedEnv`, `store`, `supervisor`, `callQueue`, `diagnose`, `index`).
Five places the spec met the real code and lost.

**1. `StdioClientTransport.onclose` throws the exit code away.** It is a bare
zero-argument callback — the shipped SDK does
`_process.on('close', _code => { this._process = undefined; this.onclose?.(); })`,
discarding `_code` before any caller sees it. So `diagnose()`'s exit-127 and
"exited immediately and said nothing" cases — the two R8 names explicitly — could
never have fired from a real crash, only from a hand-built test input. Worked around
by attaching a raw `'exit'` listener to the transport's TypeScript-private (but
JS-public) `_process`, in a try/catch, degrading silently to "no exit code" if a future
SDK renames it. **A silent degradation needs a loud test**, so one drives a real child
exiting 127 and asserts the number reaches the user-facing failure text; if upstream
renames the field, that test fails instead of `diagnose()` quietly becoming useless.

**2. R8 is wrong that stdout pollution fails the call.** It calls this "the #1 stdio
failure", but measured against the `--noisy` fixture, the SDK's `ReadBuffer.readMessage()`
simply skips the malformed line and continues — the call **succeeds**. The corruption is
only observable via `onerror`. Diagnosis therefore had to be a side-channel warning, not
a call-rejection. Useful accident: V8's own `JSON.parse` error text already embeds a
truncated snippet of the offending bytes (`Unexpected token 'h', "this line i"... is not
valid JSON`), which is what makes R8's "name the offending output" possible without
re-implementing the SDK's line buffering.

**3. R12 needed no machinery.** `app.requestSingleInstanceLock()` already exists
(`main/index.ts:343`) and refuses a second instance of the same channel before any boot
code runs, so the automatic double-spawn R12 describes cannot happen. Dev and production
coexist by design, but `userData` — and therefore `servers.json` and the workspace — is
channel-scoped, so their configs are independent. Residual risk is only a user
deliberately pointing both channels at the same external stateful resource: opt-in twice,
not a race. No lock built.

**4. `shellPath.ts:114`'s silent fallback is fixed, and it was load-bearing here.** New
exported `didResolveLoginShellPath()` — a reader over state the module already kept, no
behaviour or signature change. `buildHostedEnv` now records `{path, resolved}`, and
`diagnose()` pairs `resolved: false` with an exit 127 to say plainly that Acabox could not
read the login shell's PATH and to name the PATH it used instead. This closes the
"in passing" item in the bug table below and converts the whole "works in Terminal, fails
from the Dock" class into a diagnosis. Caught by a test that first failed for the *wrong*
reason: it asserted `PATH !== process.env.PATH`, which is false in the legitimate fallback
case — the property that matters is not which string comes out, but whether the caller can
tell.

**5. A real leaked process, found by the test harness rather than by reading.** The
supervisor's test-reset seam cleared its handle map without settling each handle's
in-flight attempt. Node still fires a killed child's `exit`/`close` on the original
transport regardless of who signalled it, so a stale `onExit` closure still holding
`intent: 'running'` scheduled a genuine ghost restart — an untracked, leaked process.
That was the cause of Jest's "did not exit" warning and a surviving fixture. Fixed by
settling every attempt before clearing.

---

## Increment 3 — The Servers page (2.5 days)

**Nav:** the `knowledge` tab precedent (commit `2333c577`) is 2 files / 6 edits:
`Rail.tsx:8` (`RailTab`), `Rail.tsx:21-28` (`{tab:'servers', label:'Servers',
icon:'dns'}`, placed after `knowledge`), `index.tsx:112` (`SidebarTab` — a second,
textually independent union), the import, a `case` in `handleRailNavigate:869-899`,
and a `display:none` sibling block in `contentArea`.

**Sections:**
1. `.connectorWarn` — unmanaged `.mcp.json` (moved from Settings, only when present)
2. `.toolsAskCard` — "Add a server"
3. **Running here** — local hosted processes (always rendered)
4. **Authored by Claude** — agent-written servers awaiting approval (Increment 5)
5. **Published by your tools** — mini-app servers, rendered only when non-empty
6. **Built into Acabox** — the 7 relays, read-only, collapsed behind a
   `.connectorLink`. Derive from `BASE_AGENT_ALLOWED_TOOLS`
   (`shared/agentAllowedTools.ts:43-64`) by splitting `mcp__<server>__<tool>` — that
   constant is authoritative because `filterMcpServers` drops any relay with no
   matching entry. This section is why `activity`/`knowledge`/`apis` are refused as
   names in the add form.
7. Footer link → Settings for remote connectors.

**One vocabulary, seven words.** Structural rule that keeps it clean: *the status line
(`.connectorRow__status`) carries the shared word; the mono line
(`.connectorRow__target`) carries kind-specific facts.* So `pid 41823` can never land
next to `Available`.

| Word | Dot | From |
|---|---|---|
| Available | `--ok` | process alive **and** handshake returned |
| Starting | `--pending` | spawning / installing / handshaking |
| Stopped | `--idle` | not running, and we did not ask it to be |
| Off | `--idle` + `.connectorRow--off` | `enabled === false` |
| Failed | `--error` | crashed / non-zero exit / handshake failed — always ` · <reason>` |

Ship `serverStateLabel()` / `serverStateDotClass()` from a new
`shared/mcpServers.ts`, the way `command-desk/toolStatusDisplay.ts` centralises the
tool vocabulary "so the home grid, the rail and the tool tab bar can't drift apart the
way RUNNING/SLEEPING did".

**Live status — pattern A, mandatory.** Every tab stays mounted forever
(`index.tsx:1022-1263` `display:none`), so a page that fetches on mount is correct once
and wrong thereafter. Copy the jobs chain exactly: main `subscribe()` → broadcast
`webContents.send('mcpServers:changed', …)` in the boot block at `index.tsx:860-868` →
`ipcMain.handle('mcpServers:list')` for the snapshot → `preload.ts` `list()` +
`onChanged()` returning its own `removeListener` closure (shape of `:147-164`) →
`types.d.ts` interface + `Window` member → **subscribe once in the app shell at
`index.tsx:812-837`**, not in the page → a `useSyncExternalStore` module store
(`renderer/mcpServerStore.ts`, modelled on `toolStatusStore.ts`) with a **diffing
`republish()`** so repeated identical pushes don't repaint.

Apply the same treatment to `main/miniAppMcpRegistry.ts` (add a listener set, notify at
the end of `register`/`unregister`/`unregisterByRoute`/`unregisterByWebContents`) so
section 5 is live rather than a one-shot read.

**Rail badge: a red dot, not a count.** A server count is not news; a failing server
is. `Rail` already calls `useToolStatuses()` directly at `:57`, so it calls
`useServerCounts()` the same way and stays prop-free.

**StatusBar:** one segment, `N SERVERS DOWN`, gated on `> 0`, inserted before
`.cdStatusBar__spacer` (`:83`). No always-on count — the file's own doc comment
(`:32-36`) says segments render only on real data.

**Detail view: a right-docked 420px panel inside the page**, not a modal (content
streams) and not a sub-route (the shell has no router, and `toolsViewMode` is already
the messiest state in `index.tsx`). Contents: tool inventory with the provenance of the
*list itself* ("Read from the server at 14:32" / **"Never read — the server has not
started"**), resolved command (as typed / absolute resolved path / argv as a JSON
array), cwd, env **keys** masked, last error, log tail, provenance, availability
toggle.

**Reuse, don't invent.** `KnowledgeRow` (`components/knowledge/KnowledgeRow.tsx`) is
`.connectorRow` markup verbatim with `RowChip`/`RowAction` — extend it with one
optional `dot?: {tone}` prop rather than writing a `ServerRow`. Only five new classes
are needed: `.serversArgRow`, `.serversArgvPreview`, `.serversDetail(+__*)`,
`.serversLog`, `.serversBuiltin`.

**Connectors cleanup, same increment:** delete the `stdio` branch from
`ConnectorsSettings.tsx` (transport picker, command field, args field) so that surface
means *remote services* and nothing else. Zero migration — no stdio connector exists.
Also fix, in both halves, the `preserveUntouchedSecrets` data-loss path:
`draftToConnector` must always emit `headers` as an object (`{}` when empty) instead of
`...(Object.keys(headers).length ? {headers} : {})`, **and** `connectorsStore.ts:151`
must treat `undefined` as "keep stored" and `{}` as "clear". Either half alone still
leaves a silent-destroy path. And demote a cached `connected` report to grey
`Not checked · last seen HH:MM` whenever `live === false`.

> ### R1 — Increment 3a: the catalog. Without this the feature is unreachable.
>
> **This is the single change that decides whether the stated target is met.**
>
> Everything in Increment 3 is a *management* surface — it assumes a server already
> exists and asks how to display it. The *acquisition* surface is one `.toolsAskCard`
> labelled "Add a server", opening a form with a command field, an argv row editor and
> an env grid. That form is unusable by the target user, and worse, it is unusable in a
> way that produces a support burden rather than an error: they paste
> `npx -y @modelcontextprotocol/server-filesystem /Users/me/Data` from a README, it
> splits into argv, and it fails at spawn for a PATH reason the page cannot explain
> (R3).
>
> **This repo has solved this exact problem twice already and the precedent is
> explicit.** `shared/connectors.ts:58` — *"adding a service to Acabox is an entry in
> `CONNECTOR_CATALOG` below and nothing else"* — 7 entries. `shared/apis.ts:521`,
> `API_CATALOG` — 16 entries, of which ten need no credential, and CLAUDE.md records
> that **all 16 base URLs were curled, not recalled**. Do the same thing here.
>
> **New `shared/mcpCatalog.ts`.** One entry per server:
>
> ```ts
> {
>   id: 'filesystem',
>   label: 'Your files',                    // what it does, not what it is
>   blurb: 'Lets Claude read and write files in folders you choose.',
>   runtime: 'acabox-node',                 // see R3
>   source: { kind: 'npm', pkg: '@modelcontextprotocol/server-filesystem', version: '…' },
>   // Typed inputs — NOT a freeform argv row editor:
>   inputs: [{ key: 'root', kind: 'directory', label: 'Which folder?',
>              default: '<workspace>', help: 'Claude will only see files here.' }],
>   requiredEnv: [],                        // [{ key, label, help, docsUrl }] when needed
>   writesByDefault: false,                 // feeds Increment 7
>   verifiedOn: '2026-08-05',
> }
> ```
>
> Consequences, each of which is the actual UX fix:
>
> - **A non-technical user never types argv.** `kind: 'directory'` renders a native
>   folder picker (`dialog.showOpenDialog` — already used by the workspace-directories
>   flow). `kind: 'secret'` renders one labelled password field with a "where do I get
>   this?" link, not an env-var key/value grid. The freeform command+argv form still
>   exists, behind a collapsed **Advanced — enter a command yourself** disclosure, and
>   keeps every warning the plan already wrote for it.
> - **The argv-with-spaces bug stops being a UX problem at all** for catalog servers,
>   because argv is constructed from typed inputs, never parsed from a string. Keep the
>   `ServersPage.test.tsx` round-trip assertion for the Advanced path.
> - **Question 6 ("what does the user actually run on day one?") answers itself.** The
>   plan's honest answer is *probably nothing*. A catalog of 4–6 verified entries is
>   that answer. My suggested starting set, all first-party or well-maintained, all
>   credential-free except the last: **filesystem** (scoped to a shared research
>   folder), **fetch** (retrieve a URL as text — complements `WebFetch` without the
>   context cost), **sqlite** (point it at a `.db` in the workspace), **git** (history
>   over a shared folder), **memory**, and **github** (the one that needs a token, and
>   therefore the one that exercises `requiredEnv` end to end).
> - **Adopt the `API_CATALOG` verification doctrine literally.** A test that spawns
>   **every catalog entry** on a real machine and asserts `initialize` +
>   `tools/list` returns. Recalled command lines rot; the connector catalog shipped a
>   404 `docsUrl` doing it from memory. `verifiedOn` is a date you can grep for staleness.
> - **Success needs plain-language confirmation.** After readiness, do not show
>   `tools/list` JSON. Show: *"Claude can now read and write files in ~/Data."* Derive it
>   from the catalog entry's `blurb` plus the resolved inputs — never from tool names,
>   which are written for a model, not a person. For an Advanced/GitHub-installed server
>   there is no blurb, so fall back to *"Claude gained 12 new abilities from this
>   server"* + the list. Being vague is fine; being wrong is not.
> - **Sections 3 and 4 of the page need an empty state that is a call to action**, not
>   "Nothing is running." The plan specifies `Nothing is scheduled.` for Increment 8 and
>   should specify the equivalent here — but for a page whose whole purpose is
>   acquisition, empty state should be the catalog itself.
>
> Cost: **~2 days**, and it removes work from Increment 6 (a catalog `npm` entry is an
> installer with a known-good input, which is a far easier first customer than an
> arbitrary GitHub repo).

### Catalog verification results — measured 2026-08-05. **R1's premise does not survive.**

R1 proposed six starting entries: filesystem, fetch, sqlite, git, memory, github. Each
was checked against the live npm registry and, where it exists, actually spawned and
driven through a real `initialize` + `tools/list`. Registry facts re-verified
independently with `npm view`.

| candidate | on npm? | version | runtime | handshake | tools | ~tokens |
|---|---|---|---|---|---|---|
| `server-filesystem` | ✅ | 2026.7.10 | Node | ✅ | 14 | ~2,000 |
| `server-memory` | ✅ | 2026.7.4 | Node | ✅ | 9 | ~1,042 |
| `server-fetch` | ❌ **never existed** | PyPI only | **Python** | ✅ only when pinned | 1 | ~276 |
| `server-sqlite` | ❌ **never existed** | PyPI, >1yr stale, archived | **Python** | ❌ | — | — |
| `server-git` | ❌ **never existed** | PyPI only | **Python** | ✅ only when pinned | 12 | ~1,167 |
| `server-github` | ✅ but **npm-DEPRECATED** | 2025.4.8 (16 mo stale) | Node | ✅ | 26 | ~3,970 |

**Three findings, in descending order of how much they change the plan.**

**1. Only two candidates are viable, not four-to-six.** `fetch`/`sqlite`/`git` were never
npm packages under `@modelcontextprotocol/*` — they are Python, launched via `uvx`, which
v1 excludes by the `runtime` constraint (R3). Independently, all three are *currently
broken* on the normal install path: they declare `mcp>=1.0.0` with no upper bound, and
PyPI's `mcp` shipped a breaking `2.0.0` on **2026-07-28**, eight days before this check
(`AttributeError: 'Server' object has no attribute 'list_tools'` and similar). Pinning
`mcp<2.0.0` fixes it — which is the proof it is an upstream regression, not local
misconfiguration. `server-github` exists but npm itself marks it *"Package no longer
supported"*; the maintained GitHub server today is a **Go binary** shipped via Docker,
so it cannot be `source.kind: 'npm'` at all.

**2. Both survivors duplicate capabilities Acabox already has** — this is the part the
verification did not draw out, and it is the more damaging one.
`BASE_AGENT_ALLOWED_TOOLS` (`shared/agentAllowedTools.ts:44`) already grants
`Bash, Read, Write, Edit, Glob, Grep` across the whole workspace with every shared
directory symlinked in. `server-filesystem` is therefore **strictly worse than what
ships today** — the same operations, scoped to *one* folder, for a permanent ~2,000-token
context tax. `server-memory` overlaps `MEMORY.md` plus the knowledge/findings ledger, and
CLAUDE.md already records that memory-vs-skills confusion is a live problem here; a
second, differently-shaped memory would deepen it.

**So Q6's honest answer is still "nothing."** The measurement did not produce a day-one
catalog; it proved there isn't one among the first-party reference servers. That is
exactly the outcome the reviewer told us to check for before spending two days on a
supervisor — *"if the honest answer is still 'none', the supervisor is 2 days spent on a
page with nothing to put on it."*

**3. `server-github` cannot demonstrate the `requiredEnv` flow R1 wanted it for.** It
does not fail fast on a missing token: handshake and `tools/list` both succeed with zero
env set, because the token is read lazily and only attached as a header if present
(`common/utils.js:28`). A real call 401s later, at which point the UI has no signal.

**Context cost (S6): affordable, and not the constraint.** filesystem + memory =
**12,170 chars ≈ 3,043 tokens**, permanent per-turn for the session's life. Real but
modest, and additive with the 7 relays / skills / `MEMORY.md`. R7's per-server tool
filtering is still worth designing in before a third server exists, but context budget is
not what blocks this feature.

**Two smaller measured corrections to annotations elsewhere in this document:** R15 cites
`fetch` as the canonical name-based-heuristic failure ("`fetch` … which can POST") — the
real tool's `inputSchema` is `{url, max_length, start_index, raw}` with no method or body,
so it is GET-only. And **`filesystem`, `memory` and `git` all self-declare `readOnlyHint`
per tool**, so a curated `readOnlyTools` list can be *derived from the server* for
annotated servers rather than hand-maintained; `server-github` carries no annotations at
all, which is the case that needs the manual list.

### DECISION (2026-08-05): agent-authored is the acquisition story. R1's catalog is cut.

Recorded here rather than left open, because it changes what gets built and the
measurement removed the alternative rather than merely weakening it.

**Increment 3a ships without a curated catalog.** There is nothing credible to put in it:
three candidates were never on npm, one is npm-deprecated abandonware, and the two
survivors are strictly-worse duplicates of tools the agent already has. Shipping
`filesystem` as the flagship entry would mean charging a permanent ~2,000-token context
tax to give the agent a *narrower* version of the `Read`/`Write`/`Glob`/`Grep` it already
holds — and then telling a scientist that is the feature.

**Increment 5 — Claude authors a server — becomes the acquisition path**, and moves ahead
of the installer. Both the original plan and the review independently picked it on Q2;
this removes the competing option. It is also the only path where Acabox creates the
demand it serves rather than waiting for an ecosystem: the user describes a capability,
Claude writes a small stdio server, the user reviews and enables it, and the host copies
it out of the agent-writable workspace and runs that copy.

**What survives from R1**, because the argument was right even though the inventory was
not:
- **Typed inputs, not a freeform argv row editor.** A `kind: 'directory'` input rendering
  a native folder picker is how a scientist configures a server. The Advanced
  command+argv form stays, collapsed, with every warning R1 specified. This applies just
  as much to an agent-authored server declaring its own inputs as it would have to a
  catalog entry.
- **Plain-language confirmation.** "Claude can now read and write files in ~/Data", never
  a `tools/list` dump. For an authored server the blurb comes from the manifest Claude
  wrote, which it can be asked to write in the user's terms.
- **The verification doctrine.** Whatever ships in a catalog later gets spawned in a real
  test and carries a `verifiedOn` date. This exercise is the argument for that rule:
  every one of R1's six recalled entries was wrong in some way.

**Not "no catalog ever."** A catalog of genuinely non-redundant third-party servers — web
search, paper retrieval, browser automation — is still the right shape. But those are
third-party code with a real trust surface, they need the write gate (Increment 7) and
the installer (Increment 6) underneath them, and none of that is v1. Revisit after the
ship gate, with the same measure-don't-recall rule.
>
> ### R9 — The per-increment smoke test does not exercise any of this
>
> Every increment lists `npm start -- -- --smoke-test` exits 0 as verification. Per
> CLAUDE.md (measured 2026-07-29), the smoke test quits at `main/index.ts:832`, and the
> agent server is started by the **renderer** via `agentInfrastructure.start`, which it
> never reaches. Increment 4 puts `mcpHost.startAll()` on that same renderer-triggered
> path (`AgentInfrastructureController.ts:341` is where `apiProxy.start()` lives), so
> **the smoke test will prove nothing about `mcpHost` while appearing to.** CLAUDE.md
> records that this exact misreading already "sent at least one session hunting a
> non-existent regression."
>
> Either say plainly that smoke covers boot-not-MCP, or — better — add a
> `--smoke-test-mcp` flag that runs `startAll()` against a store containing only the
> echo fixture and exits on readiness. That is a ~20-line addition and it is the only
> automated end-to-end signal this feature would otherwise have.

---

## Increment 4 — Agent reach (2.5 days). The headline.

- `hostedServers` added to the config built at
  `controllers/AgentInfrastructureController.ts:363-385`.
- New agent-server route `POST /hosted` taking
  `{ id: { name, tools: [{name, description, inputSchema}] } }`, building one relay
  server per id whose `tools/call` handler is the **existing**
  `createMcpRelayHandler` — unchanged.
- Ids share one namespace with connectors: pass `hostedIds` into `validateConnector`'s
  `existingIds` at `connectorsStore.upsertConnector:174` and vice versa, so
  `RESERVED_CONNECTOR_IDS` keeps meaning something.
- `replaceConnectorAllowedTools` is unchanged; its **callers** pass the union
  (connectors ∪ hosted) as both `priorIds` and `nextIds`.

**Two mandatory guards, both from bugs this repo has already had:**

1. **`rememberAgentHosted(hosted)`** alongside `rememberAgentSkills`/
   `rememberAgentConnectors` (`containerService.ts:725`, `:743`). Without it, an
   agent-server crash-restart replays a boot config with zero hosted servers — the
   exact regression those two functions exist to prevent.
2. **A re-push on agent-server (re)start.** Add
   `containerService.onAgentServerRestarted(cb)` fired from the exit handler's restart
   path at `:536`; `mcpHost` re-pushes its **live** inventory. Strictly better than
   replaying a snapshot, because a server that is `failed` at that moment must not be
   re-registered. `AgentInfrastructureController.start()` already does this dance for
   skills at `:393`.

**Riskiest single edit:** `applyConnectorsToSession` (`agent-server/index.ts:778`)
becomes `applyDynamicMcpToSession` and must send `{...relays, ...connectors,
...hosted}`. Its docstring already records a *measured* bug — `setMcpServers` replaces
the entire dynamic set, so omitting the relays silently disconnects them. A third half
gives that bug three ways to fire. Guard with a boot assertion in the style of
`assertKnowledgeToolAllowed`, plus the exhaustive test below.

**Boot ordering:** `mcpHost.startAll()` goes after `apiProxy.start()` and before
`startAgentServer`, and must **not block boot** — it returns as soon as spawns are
issued, with readiness arriving asynchronously. Same never-throws contract as
`apiProxy.start()`.

> ### R6 — Non-blocking boot creates a race the user meets on their first turn
>
> Correct decision (a slow server must not hold the app hostage), but it has a
> consequence the plan does not name: **for the first N seconds after launch, a hosted
> server's tools do not exist.** A user who opens Acabox and immediately asks "search my
> files" gets a Claude that says it can't — and then can, thirty seconds later, with no
> explanation for either answer. For a non-technical user that reads as unreliability,
> which is worse than a hard failure.
>
> The mechanism to fix it is already being built: **S3 proves `setMcpServers` can add a
> server mid-session.** So make it a stated requirement rather than an implication:
>
> 1. `POST /hosted` is called **per server, at the moment its readiness lands** — not
>    once with a batch after `startAll()` settles.
> 2. That push must reach **live** sessions, not only the next one. This is the same
>    call as `applyDynamicMcpToSession`, so it is free — but it is also the riskiest
>    edit in the plan (below), so test it explicitly: *a session created while a server
>    is `Starting` can call that server's tool after readiness, in the same turn.*
> 3. While any server is `Starting`, the StatusBar segment should say so
>    (`1 SERVER STARTING`) — the plan only specifies `N SERVERS DOWN`. This is the one
>    place a transient count *is* news, because it explains a capability the user just
>    found missing.
>
> Consider also seeding the session guidance with one line — *"MCP server `files` is
> still starting; its tools will appear shortly"* — so the model can say the true thing
> instead of "I don't have that capability."
>
> ### R7 — Nobody has costed the context. This repo has blown that budget before.
>
> Every hosted tool's name, description and full JSON Schema goes into every request,
> in every turn, for the life of the session. A filesystem server is ~12 tools; a GitHub
> server is ~35. Three servers is plausibly 60+ tool definitions, permanently resident,
> on top of 7 relays, the skill roster, `MEMORY.md` and CLAUDE.md.
>
> This is not hypothetical here. CLAUDE.md, 2026-07-29: *"The roster was silently over
> budget and is now fixed… the 21 shipped skills need **10,193** [chars against an 8,000
> budget]"* — and the miss was 55% because it was estimated rather than measured. Same
> failure mode, same fix: **measure it (S6), then decide.**
>
> If the number is uncomfortable, the mitigation is a per-server **tool selection** —
> the catalog entry declares a `defaultTools` subset, the detail panel lets the user
> widen it, and the relay only registers what is selected. That is a `filter` on the
> inventory before `POST /hosted` and costs almost nothing *if designed in now*; it is a
> schema migration if bolted on later. It also composes with Increment 7's write gate:
> the same panel answers "which of this server's tools can Claude use" and "can they
> write."

### Increment 4 — done, and **S2 is answered** (2026-08-13). 983 tests / 64 suites.

tsc clean, `npm run build:agent-server` clean with zero warnings, `--smoke-test`
exits 0, and the built `dist/agent-server.js` boots standalone to a healthy
`/health`. `POST /hosted` driven against that real bundle: two servers register
(`auto-approve=[mcp__spike, mcp__weird]`), a `$ref` and a schema-less tool both
degrade instead of throwing, and an empty payload clears both the servers and
the auto-approve list — full-replacement semantics confirmed on the wire.

**The acceptance turn, run for real through the app.** A hosted server whose
JSON Schema was hand-written as raw JSON (deliberately *not* zod-derived — the
echo fixture goes through `zod-to-json-schema`, so testing the converter against
that dialect would be testing it against itself), reporting back the `typeof`
of everything it received:

```
args {mode:"fast", count:12, tags:["x","y","z"]}  → string · integer · array<string>
args {mode:"careful", tags:["solo"]}              → count ABSENT
```

`count` arrived as `12`, not `"12"`. **The second line is the sharp one**: the
optional was omitted rather than invented, which is the assertion that fails if
`required` is mishandled anywhere in `jsonSchemaToZod`. S2 passes; the untyped-
passthrough fallback is not needed and is off the table.

**And the headline property, across two genuinely separate chats:**

```
22:02:12  spike_counter → count 1, pid 21376
22:02:21  spike_counter → count 2, pid 21376
```

Same pid, counter held only in process memory. Under the superseded per-turn
model this reads `1`, `1` on two different pids. The relay path is visible
end-to-end in the log: `[AgentServer] MCP relay: spike/spike_counter` →
`[AgentSession] MCP relay: …`.

**Acceptance step 6 (no orphan after quit) passes, observed.** A real quit exited
via `[APP] will-quit: exiting via the shutdown path` — Increment 1's fix — and
`pgrep -f spikeMcpServer` came back empty.

#### Two defects found by running it, not by reading it

1. **The membership check was on the hot path.** The first cut asked
   `mcpHost.list()` on every hosted tool call, and that goes through
   `readStoreFileSync()` + a `safeStorage` decrypt of the sealed store,
   synchronously, on the main thread — a blocking decrypt inside a loop the
   model controls. It is now two-tier: `isHosted()` (supervisor handle map,
   free) first, `list()` only on a miss, which preserves the honest "this
   server is stopped" message for a configured-but-never-started id. Pinned by
   a test that **counts `safeStorage` decrypts**, because collapsing it back to
   one call still passes every behavioural test in the file. Verified
   non-vacuous by regressing the code and watching it fail.

2. **`main/mcpHost/` was silent on every healthy path.** Every log call in the
   whole subsystem sat on a failure branch, so a real session that spawned a
   server, served two chat turns from it and shut it down at quit produced
   `grep -ci mcphost` = **0**. That also made *this document's own* acceptance
   instruction — "grep the log for a stable `[McpHost]` prefix on every state
   transition" — impossible to carry out as written. Fixed in `notify()`, the
   single funnel every status change already passes through, latched on an
   actual state change so a same-state update (refreshed inventory, pid
   landing) does not repeat a line. `info`, not `debug`: the app ships with
   debug suppressed, and *which local processes did Acabox start on my machine*
   has to be answerable from the default log.

#### FIXED (2026-08-13): hosted servers tripped the knowledge omission watch

Observed in the acceptance run's log, on a turn that called nothing but a unit-
converter-grade probe:

```
[Knowledge] Chat … queried spike without reading the findings ledger
```

`omissionWatch.connectorIdOfTool()` treats every `mcp__<id>__*` call as a
connector unless `<id>` is in `RESERVED_CONNECTOR_IDS`. Hosted servers are not,
so **every hosted-server turn raises an omission row.** This was unreachable
before Increment 4 — hosted servers could not be called at all — so the work
made a previously-dead path live and noisy.

The module's own design note is what settles it:

> "the channel would fill with rows that are correct to ignore and the user
> would learn to ignore all of them inside a fortnight. A notification channel
> that has been trained away is worse than no channel."

A hosted server population is dominated by small local utilities — that is the
entire point of the agent-authored acquisition story — so leaving this on
produces exactly the trained-away channel the rule was designed to prevent. The
genuine "went to the warehouse" case (a hosted server wrapping a real lab
database) is real but is the minority, and is better served by a per-server
opt-in than by defaulting everything in.

**Fix:** hosted ids are excluded from the connector classification, threaded in
from `agentSession` as `hostedIds` rather than imported — `connectorIdOfTool` is
pure over a tool name, and reaching into `main/mcpHost` from `omissionWatch`
would also close a cycle (`agentSession` → `omissionWatch`, `agentSession` →
`mcpHost`). The parameter is **optional and over-reports when omitted**, so a
caller that cannot cheaply supply it still gets the connector rule; that
direction is deliberate and pinned by a test.

**Two call sites, not one** — the second is easy to miss and was: `noteTurn`
recomputes the id list independently to build the row's `connectors` field,
which is the *evidence the card shows the user* ("this chat queried Hex
without…"). Fixing only `classifyTurn` would have left a correctly-suppressed
hosted server still named to the user as a warehouse on any turn where a real
connector also ran.

#### Still unverified

- **Acceptance step 7** (reopen after a quit: the server reads Stopped, no
  orphan adopted). The store was cleared before it could be run.
- **Mid-session arrival (R6).** The acceptance turns were sent after the server
  was already `ready`. The push-per-readiness code path runs — it was observed
  firing during a `starting → ready` transition — but "a session created while a
  server is Starting can call that server's tool in the same turn" has not been
  demonstrated end to end.

---

## Increment 5 — Claude authors a server (2 days)

The agent writes a standalone stdio MCP server into
`<workspace>/.mcp-servers/<id>/` (`index.mjs` + `manifest.json`), guided by a new
skill `manage-mcp-server` with a working scaffold. The host adopts it as a row in
**Authored by Claude**, arriving **`enabled: false`** — written as a literal in the one
registration function with no caller-settable field, verbatim the `skillStore.ts:1243`
precedent and for the same reason.

**The security model is the skills Pristine/Store/Render split, and it is the point.**
The agent has Write + Bash on the workspace, so code it can still edit is code it can
change *after* you approve it. So: **on enable, the host copies the tree to
`<userData>/mcp-servers/<id>/` and runs that copy.** The agent's workspace copy is the
source; the running copy is not agent-writable. The row shows
`3 changes in the workspace since you approved · Review` with one button to re-promote.

This is deliberately *not* an MCP tool the agent can call to register itself. The agent
writes files; the host notices; **the user enables.** That preserves the property
`shared/connectors.ts:1-22` was designed for.

Not folded into the mini-app manifest: an iframe-published MCP is browser JS using the
bridge; a headless server is node code. One manifest covering both is a trap.
`miniAppMcpRegistry` stays exactly as it is and simply gains a UI section.

### Increment 5, skill half — done (2026-08-13)

`src/cobuilding/skills/manage-mcp-server/` — `SKILL.md` plus a **runnable**
`assets/scaffold/` (`index.mjs` + `manifest.json`). Verified by driving the real
scaffold under Electron-as-node (v22.17, the runtime Acabox ships): clean
`initialize` → `tools/list`, JSON-RPC on stdout and nothing else, diagnostics on
stderr, exit 0 the moment stdin closes.

**Zero dependencies is a hard requirement here, not a style preference**, and the
reason was measured rather than assumed — two independent mechanisms both forbid
them:

- The install wrapper cannot target these directories at all. `assets/install:112`
  hardcodes `APP_DIR=".applications/$APP"` and refuses when that directory does not
  exist, so there is no supported path to `.mcp-servers/<id>/`.
- Even a hand-installed package would not resolve at runtime: `NODE_PATH` is
  **deliberately excluded** from `HOSTED_ENV_ALLOWLIST` (`hostedEnv.ts:42`), which
  is the whole point of the allowlist.

So the scaffold hand-rolls its JSON-RPC framing. That is also the more honest
target to develop against — a good share of real stdio MCP servers are hand-written
rather than SDK-based.

**The two rules the skill shouts, because each produces a failure that looks
unrelated to its cause:** (1) nothing but JSON-RPC on stdout — one stray
`console.log` corrupts the next frame and surfaces as an inscrutable parse error;
(2) exit when stdin closes, which is how the human acceptance test's `pgrep`-after-
quit step can pass at all, and the same rule the dictation helper follows.

**Roster budget checked, not assumed** (CLAUDE.md records this budget being
silently blown once, by 55%, because it was estimated): 22 skills now total
**12,929** frontmatter chars against a ~40,000 ceiling
(`contextTokens × 4 × 0.05`). Comfortable.

**Open contract for the host half:** `manifest.json` is `{id, label, description}`
and the entry point is `index.mjs` by convention — the manifest does **not** declare
a command. No host-side reader for it exists yet; whoever writes the adoption code
owns matching these field names, or changing both together.

---

## Increment 6 — Install from GitHub (3 days)

1. **Fetch** — reuse `main/knowledge/skillImporter.ts`: `parseGithubUrl`, `resolveRef`
   (SHA-pinned; "a pin recorded as a branch name is not a pin"), the codeload tarball,
   `/usr/bin/tar` with its four `--no-*` flags, and **`stripSymlinks` first** (bsdtar
   refuses `..` but *does* materialise absolute symlinks). One surgical change: extract
   `fetchSubtreeRaw()` out of `fetchSubtree`, which today requires a `SKILL.md`. Do
   **not** export `downloadTarball`/`extractSubpath` individually — their correct
   sequencing is the whole point.
2. **Scan** — `scanTree` for file/byte caps; refuse if any symlink survived.
3. **Build** — new `main/mcpHost/npmProject.ts`, the one genuinely new capability
   (`packageInstaller.ts:365` is the only npm call in all of `main/` and is
   unconditionally `-g --prefix`; `containerService.exec` has **no cwd option**).
   `npm install --omit=dev --ignore-scripts` in the server's own dir, npm resolved via
   `nodeSetup.ensureNpmAvailable()`.
4. **Native-module ABI, resolved by two decisions rather than a build system.**
   Run Node servers under `process.execPath` + `ELECTRON_RUN_AS_NODE=1` — the same
   launch shape as the agent server (`containerService.ts:491`) — so
   `NODE_MODULE_VERSION` is a constant we control. And **never attempt a source
   build**: `--ignore-scripts` means `node-gyp` never runs, so Xcode CLT (which this
   repo treats as optional, `build-dictation-helper.js:31`) is never required. A
   mismatched prebuild fails at first start with a string `diagnose.ts` turns into
   plain English. Same posture as `packageInstaller`'s outright refusal of R.
5. **Probe** once under `intent:'probe'` to record the real tool list, then register
   disabled.

**Install progress is a live log pane, not a progress bar** — codeload sends no
`content-length`, so a percentage would be fabricated (the rule `ImportSkillPanel`
already follows). On failure the pane stays with `Copy log` and
**`Ask Claude to fix this`**, which composes a real chat turn carrying the last 60
lines — the agent has Bash in the workspace and can actually go fix it.

> ### R2 — "Install from GitHub" is the wrong first installer. npm is.
>
> Almost every MCP server a user will encounter is distributed on npm and documented as
> `npx -y <pkg>`. The plan's own designated safe example —
> `npx -y @modelcontextprotocol/server-filesystem` — is an npm package, and **Increment
> 6 as written cannot install it.** So the increment builds the harder path (arbitrary
> repo, arbitrary layout, arbitrary build) and skips the one that covers the majority of
> real servers and every catalog entry from R1.
>
> Split it, and reorder:
>
> - **6a — npm install (≈1 day).** `npm install <pkg>@<version> --omit=dev
>   --ignore-scripts --prefix <userData>/mcp-servers/<id>`, then resolve the package's
>   `bin` entry from its `package.json`. Everything downstream — the build step, the
>   probe, the `diagnose` mapping, the log pane — is shared with 6b. **Pin the exact
>   version, never a range**, for the same reason `skillImporter` pins a 40-char SHA:
>   "a pin recorded as a branch name is not a pin" applies verbatim to `^1.2.0`.
>   Record the resolved version + integrity hash from `npm ls --json`.
> - **6b — GitHub install (≈2 days).** As written, unchanged, minus the npm-project
>   work it now inherits.
>
> Two notes on 6a: `ensureNpmAvailable()` already exists (`nodeSetup.ts:45`) and already
> throws a typed `NpmUnavailableError` — reuse it, and route it through `diagnose.ts` so
> "no npm on this machine" is one sentence and not a stack. And **do not use `npx` as
> the launch mechanism** even though it is what every README says (see R3).
>
> ### R3 — "`NODE_MODULE_VERSION` is a constant we control" is only true for half the servers
>
> Point 4 is sound *for servers Acabox installs and launches itself*. It does not hold
> for the Advanced path, where the user types a command:
>
> - `npx …` — measured: the string `npx` appears **zero times** anywhere in
>   `src/cobuilding/main/`. It is not resolved, and under a GUI launch it is not on
>   `PATH` at all without `getLoginShellPath()`. Even resolved, `npx` execs the **user's
>   system node**, whatever version that is — so the ABI is theirs, not ours, and the
>   whole argument in 6.4 evaporates. It also silently downloads and runs code from the
>   network on every start, which the disclosure copy does not mention.
> - `python`, `uv`, `deno`, a shell script — same class.
>
> Make it explicit on the record rather than implicit in the increment:
>
> ```ts
> runtime: 'acabox-node' | 'system'
> ```
>
> - **`acabox-node`** — Acabox installed it; we launch `process.execPath` +
>   `ELECTRON_RUN_AS_NODE=1` against a resolved absolute entry file. Every claim in 6.4
>   holds. All catalog entries are this.
> - **`system`** — the user gave us a command. We resolve it once against
>   `getLoginShellPath()`, **store and display the absolute resolved path** (the detail
>   panel already promises "as typed / absolute resolved path / argv as a JSON array" —
>   good, keep it), and the status line carries `Runs with your system Node 22.14` or
>   `Command not found on your path`. Re-resolve on every start, because Homebrew
>   upgrades move binaries.
>
> This is also the honest fix for the `shellPath.ts:114` silent-failure bug already
> listed as "in passing" — a `system` runtime is precisely the "works in Terminal, 127
> from the Dock" generator, and now the page can say which of the two worlds it looked
> in.

---

## Increment 7 — Write gate (1.5 days)

A per-tool `allowWrites` boolean on the record, default false, **checked in the host
relay handler before forwarding**. Mirrors the shipped `apis:setAllowWrites` pattern.

This is the first place in this codebase where an MCP tool can be refused: there is no
`canUseTool` handler anywhere (three comments assert its absence, zero
implementations), so today every tool a server offers is auto-approved. Do **not**
implement this as an `allowedTools` entry — that list is auto-approve, not a
restriction, so it would be a no-op, and a no-op security control is worse than none.

> ### R15 — Move this ahead of Increment 6, and reconsider "one boolean per server"
>
> **Ordering.** Product question 3 already reaches the right conclusion conditionally
> ("if Increment 6 ships first, move the write gate ahead of it") and then leaves the
> order alone. Make it unconditional. The gate is 1.5 days; the installer is 3. Shipping
> a stranger's-code installer before the only mechanism that can refuse a tool call
> means the window where "every tool from any repo is auto-approved" is a *shipped
> state*, not a plan artifact. Cost of reordering: zero — nothing in Increment 7 depends
> on 6.
>
> **The boolean.** "One boolean per server" is the right *first* shape and the plan is
> right to refuse per-tool policy UI up front. But be precise about how a tool is
> classified as a write, because getting this wrong is the difference between a real
> boundary and a comforting one:
>
> - **Do not infer from the tool name.** `create_*`/`delete_*` heuristics fail on
>   `run_query`, `execute`, `fetch` (which can POST), and anything named in another
>   idiom. MCP has no machine-readable read/write annotation that can be trusted from an
>   untrusted server — and a server that self-declares `readOnly: true` is *the
>   attacker's own claim*, exactly the way its tool descriptions are instruction text
>   the model follows (which the disclosure copy already says well).
> - So the honest v1 is: **`allowWrites: false` means the server is refused entirely for
>   any tool not on an explicit allow list the user built**, or it means nothing. Pick
>   one and say which. My recommendation: default the *catalog* entries with a curated
>   `readOnlyTools` list (we verified them — that is what `verifiedOn` buys), and for
>   non-catalog servers make the boolean mean "all tools" vs "none", with the detail
>   panel offering per-tool checkboxes as the escape hatch. That is the same shape as
>   R7's tool selection and should be **the same UI control**, not a second one.
> - Whatever the rule, the refusal message the model receives must be actionable and
>   name the fix, matching the API proxy's shipped behaviour (CLAUDE.md: the agent
>   "quot[ed] the actionable message verbatim" on a 405). Test that the refusal reaches
>   the transcript and that the secret-bearing `env` never does.

### DECISION (2026-08-13): there is no boolean. Increment 7 ships per-tool selection.

R15 says pick one meaning for the boolean and say which. Picking honestly
collapses it, and **cutting the catalog removed the half that made the hybrid
work** — there are no curated `readOnlyTools` lists any more, because there are
no catalog entries to carry them.

Follow the argument to its end:

- A tool cannot be classified read-vs-write from an untrusted server. Name
  heuristics fail on `run_query`/`execute`/`fetch`, and a self-declared
  `readOnly: true` is *the attacker's own claim* — the same category as the
  tool descriptions the disclosure copy already warns are instruction text.
- So `allowWrites: false` can only honestly mean **all tools or none**.
- But "none" is already spelled `enabled: false`. **A boolean write gate would
  therefore be a second name for a switch that already exists** — and R15's own
  standard is that a no-op security control is worse than none.

So the control is **per-tool selection**: the user chooses which of a server's
tools Claude may call. This is not scope creep away from the write gate; it is
the write gate, expressed as the only classification anyone in the system is
actually entitled to make — **the user's**. It is also exactly what R15 asks
for ("the same UI control, not a second one") and what R7 needs for the context
budget, and R7 is explicit that bolting it on later is a schema migration.

**Enforced in two layers, and the distinction matters:**

1. **Filter the inventory before `POST /hosted`.** An unselected tool is never
   registered, so it does not exist as far as the model is concerned and its
   schema costs no context. This is the *optimisation*.
2. **Re-check in the host relay handler before forwarding.** This is the
   *boundary*. Layer 1 alone is not one: a selection narrowed mid-session
   leaves the CLI holding a relay registered from the earlier, wider push, so
   the only place that can refuse the call with certainty is the host, at the
   moment of the call — which is precisely where the plan already said the gate
   belongs, and the reason it must not be an `allowedTools` entry.

`enabledTools?: string[]` on the record. **Absent means all tools**, which
keeps every existing record valid with no migration and matches what a user who
added and started a server plainly intended. An empty array means none, and is
distinct from absent.

---

## Increment 8 — Scheduler on Activity (1.5 days)

`ScheduledTaskEditor.tsx` (372 lines) and `ScheduledTasksSidebar.tsx` (122 lines) exist
and are imported nowhere; `scheduledTasksAPI` appears only in `preload.ts:351` and
`types.d.ts:1087`. The backend is complete and **the scheduler is already running**
(`startScheduledTasks` at `main/index.ts:984`, 8 IPC channels, its own
`scheduling.db` with run history).

Add an **"On a schedule"** `.toolsSection` at the top of `ActivityPanel` — the page
that already shows what ran while you weren't watching, i.e. the *output* of exactly
these tasks. One `KnowledgeRow` per task; always rendered, with
`Nothing is scheduled.` when empty. `Open` uses the same docked-panel pattern as the
server detail.

New `renderer/components/schedule/SchedulePanel.tsx`:
- **Keeps verbatim:** `intervalToCron`/`cronToInterval`/`validateInterval`
  (`ScheduledTaskEditor.tsx:8-61`), `cronToHuman` (`ScheduledTasksSidebar.tsx:5-40`),
  every `scheduledTasksAPI` call site.
- **Replaces:** lucide icons → `MSymbol`; `.scheduledTask*` → `.connectorField*` /
  `.gsStep__btn*`; `.miniAppsModal__*` → `.toolsConfirmOverlay`.
- **Deletes:** both orphan components and `ScheduledTasks.css` (334 lines, zero
  `var(--`, never swept in the palette pass because nothing imports it).

The Servers detail panel gets a `Run something on a schedule with this server →` link.
**A scheduled task runs through the same `createAgentSession` path as a chat turn**, so
it has the identical MCP surface, and `mcp__notification__show_notification` is already
on the always-allowed list (`shared/agentAllowedTools.ts:60`) with the whole
click→navigate chain wired. "Notify me when the overnight check finds something" needs
zero new backend.

**Fix in the same increment:** the deep-link tab union has **three** copies —
`shared/types.ts:175-177`, `main/mcpServers/notificationMcpServer.ts:28`, and
**`agent-server/index.ts:232`**. The third is a zod enum that silently *strips* an
unknown value, so fixing the first two alone produces a notification that navigates
nowhere with no error. Define the array once and import it into both zod sites. All
three are already missing `knowledge` and `activity`.


### SHIPPED (2026-08-31)

Built as specified, with three deviations worth recording:

1. **Rows use `cdActivityRow`, not `KnowledgeRow`.** The plan says reuse
   `KnowledgeRow`; that is right on Servers, which is a `.connectorRow` page,
   and wrong here — ActivityPanel is built entirely from `cdActivityRow`, and a
   different row shape in the first section of the page would read as a
   different product. Reuse the page's vocabulary, not the plan's.
2. **The page needed a shell.** ActivityPanel is mounted in a container that
   scrolls (`index.tsx`, `overflow: 'auto'`), so an absolutely-positioned panel
   inside it scrolls away with the content. It now has the same three-part
   structure as ServersPage — non-scrolling relative shell, scrolling body,
   panel as a **sibling** of the body.
3. **One deviation from the verbatim lift, found by a test.** `cronToInterval`
   parsed a zero step into `{interval: 0}`, which `intervalToCron` wrote
   straight back out and `cronToHuman` rendered as "Every 0 minutes". A
   non-positive step now falls through to the default. The editor could never
   produce one, but the list is fed from a hand-editable `scheduling.db`.

Also: **there is no `scheduledTasks:changed` broadcast**, so the section polls
every 30s while the tab is visible. A run started by the scheduler's own clock
would otherwise leave `last_run_at` stale for as long as the page stays mounted
— and every tab stays mounted forever. A broadcast would be better and is the
natural Increment 9 follow-up.

Deleted: `ScheduledTaskEditor.tsx`, `ScheduledTasksSidebar.tsx`,
`ScheduledTasks.css` — **828 lines**, all of it unreferenced.

The tab-union fix landed as `SIDEBAR_TAB_IDS` in `shared/types.ts`, imported by
both zod sites. `shared/__tests__/sidebarTabs.test.ts` scans the source for a
fourth copy and asserts the two known sites still import the constant, so the
test cannot pass vacuously if someone deletes one.

---

## Increment 9 — Hardening (1 day)

Log rotation, health backoff tuning, "crashed 3 times" UI state, `docs/design/`
write-up, and CLAUDE.md Status.

**Total: 16–20 days.** Stop after any increment. Increment 3 alone already closes
"mini-app MCP servers have zero UI" and the stale-green defect.

> ### R18 — Re-estimate: the target outcome is not inside 16–20 days
>
> The figure covers the increments as written. It does not cover the catalog (R1, ~2d),
> the npm installer split (R2, +0.5d net), the runtime field (R3, ~0.5d), the orphan
> reaper (R5, ~0.5d), readiness push + starting state (R6, ~0.5d), tool selection
> (R7, ~1d if designed in now), the diagnose case list (R8, ~0.5d), the instance lock
> (R12, ~0.25d), or remove-reclaims-disk (R13, ~0.25d). **Call it 22–27 days** for the
> full plan, or:
>
> | Slice | Days | What is true at the end |
> |---|---|---|
> | 0 + 1 | 2.5 | Spike answered; the Cancel-button teardown bug is gone regardless of whether any of this ships. **Do this even if the feature is cancelled.** |
> | + 2 + 3 + 3a(R1) | +6.5 | A non-technical user can add a catalog server and see it running. It does nothing yet. |
> | **+ 4** | **+3** | **The headline is true: a persistent server the agent can reach.** ← *ship gate* |
> | + 7 | +1.5 | Tools can be refused. |
> | + 5 | +2 | Claude authors one. The differentiated half (Q2 agrees). |
> | + 6a/6b | +3 | Install from npm / GitHub. |
> | + 8 + 9 | +2.5 | Scheduler surfaced; hardened. |
>
> **≈12 days to the ship gate**, against the plan's ~9.5 for the same gate — the
> difference is entirely R1, and R1 is what the stated target buys.
>
> Increment 8 (scheduler) is genuinely excellent work and genuinely unrelated to MCP
> hosting — it revives 494 lines of dead UI over a backend that is *already running*.
> **Consider pulling it out as its own 1.5-day PR now.** It has no dependency on
> anything above, it is the highest ratio of user-visible value to risk in the whole
> document, and bundling it means it ships in week four instead of tomorrow.

---

## Required disclosure copy (verbatim, non-dismissible)

On the confirm step for any local server:

> Adding this server means Acabox will run `<resolved command>` on your machine, with
> your user account and your files, every time you start it. Every tool it offers is
> auto-approved: Acabox supplies no permission handler, so Claude calls them without
> asking you, and the server's own description of each tool is instruction text the
> model will follow. A pinned commit makes it reproducible and auditable. It does not
> make it safe.

Under a running server's status: *"Running as you, with access to your files. Its tools
are auto-approved."*

Beside the args editor: *"Each row is one argument, passed exactly as typed. Acabox
does not run a shell, so quotes and `$VARIABLES` are not interpreted — a path with a
space belongs in one row, unquoted."*

Foot of the mini-app section: *"A tool publishes its server while it is open and
withdraws it when you close it. Claude can only call these while the tool is on screen
— there is nothing to configure and nothing to start."*

> ### R19 — The disclosure is honest and unreadable. Both matter.
>
> *"Acabox supplies no permission handler"* is a true sentence about our architecture
> and an empty one to a scientist. Same for *"the server's own description of each tool
> is instruction text the model will follow"* — that is the prompt-injection risk stated
> precisely, and it will not land. The last two lines ("A pinned commit makes it
> reproducible and auditable. It does not make it safe.") are the best writing in the
> document and should survive untouched.
>
> Suggested rewrite of the first paragraph — same content, no jargon, and it keeps the
> two facts that actually change behaviour (it runs as you; Claude won't ask first):
>
> > Acabox will run this program on your Mac whenever you start it. It has the same
> > access to your files and accounts that you do.
> >
> > Claude will use its tools **without asking you first**, and the program tells Claude
> > what its tools do — so a program that describes itself dishonestly can mislead
> > Claude. Only add programs from a source you trust.
> >
> > A pinned commit makes it reproducible and auditable. It does not make it safe.
>
> Two additions:
>
> - **The `npx`/network case needs its own line** (R3): a command that downloads code on
>   every start is a materially different promise from a pinned install, and the current
>   copy — "*a pinned commit makes it reproducible*" — implies a pin that `npx -y` does
>   not have. If the Advanced command matches `npx`/`uvx`/`curl … | sh`, say so:
>   *"This command downloads code from the internet each time it starts. What runs
>   tomorrow may not be what you are approving today."*
> - **The argv note is good and should be shown next to the field, not only in the
>   disclosure.** With R1's typed inputs, catalog users never see it at all — which is
>   the point.
>
> Do not make the disclosure dismissible-once-per-server; the plan says non-dismissible
> and that is right. But do **not** repeat it under every running server's status —
> *"Running as you, with access to your files. Its tools are auto-approved."* on every
> row turns into wallpaper. Put it once at the section head.

---

## Verification

Doctrine from `main/__tests__/{jobRegistry,apiProxy,skillImporter}.test.ts`: real
processes, real binaries, at most one seam, mock only `electron` (`app.getPath`) and
`electron-log`. **Run with `npm test`**, never bare `npx jest` — the Electron ABI is
the point.

New fixture `main/__tests__/fixtures/echoMcpServer.mjs`: a real ~50-line stdio MCP
server with `echo`, `slow(ms)` (writes start/end timestamps), `crash`, and an
`--ignore-sigterm` flag that also spawns a `sleep 60` grandchild.

| Suite | Key assertions |
|---|---|
| `mcpHostEnv.test.ts` | Set `ANTHROPIC_API_KEY`/`ACABOX_API_TOKEN` to canary strings; assert **no value in the built env contains any canary substring**. Assert on *values*, not key names — that is what catches the next spread. |
| `mcpHostSupervisor.test.ts` | crash → restart → same tool on a different pid. `/bin/false` → exactly 6 attempts then `failed`. **Backoff reset:** healthy 250ms then crash gets attempt #1's delay, not #4's. |
| `mcpHostTeardown.test.ts` | `--ignore-sigterm` + grandchild: `shutdown({graceMs:300})` leaves neither alive. Twice does not throw and does **not** kill an unrelated process spawned in between (pid-signature guard). |
| `mcpHostQueue.test.ts` | 5×`slow(300)` at concurrency 1 → strict non-overlap; at 3 → overlap. 33rd call rejects in <50ms (assert *latency*, so a regression into a timeout fails). |
| `agentServerHostedRelay.test.ts` | All 8 combinations of relays × connectors × hosted: the object passed to `setMcpServers` contains **every key of all three**. |
| `mcpHostPersistence.test.ts` | Tampered seal is dropped, not repaired. `register` yields `enabled:false` even when passed `true`. |
| `quitTeardown.test.ts` | Cancel does not run teardown; accept runs it exactly once. |
| `ServersPage.test.tsx` | Cached `connected` + `live:false` renders **no** `.connectorDot--ok`. No `.connectorRow__status` matches `/pid \d+/`. Built-in list equals `BASE_AGENT_ALLOWED_TOOLS` computed *in the test*. Args editor round-trips a path containing a space. |

### The acceptance test — human-run

A fixture server exposing `spike_counter`, which increments an integer held **in
process memory, never on disk**. Memory is the point: a per-turn child restarts and
answers `1` every time, so the assertion is not "the tool works" but "**the same
process answered twice, across two turns**."

1. `npm start`. Add the server on the Servers page. Start it. Note the pid shown.
2. Turn 1: "call spike_counter" → **1**.
3. Turn ends; the row still reads Available **with the same pid**.
4. Turn 2, a genuinely new session: "call spike_counter again" → **2**. ← *this single
   assertion proves the feature*
5. Stop it from the page. Turn 3: the model reports it unavailable and does **not**
   hang for 120s.
6. Quit Acabox. `pgrep -f spike_counter` returns nothing.
7. Reopen. The server reads Stopped, not Available; no orphan adopted.

Steps 6–7 are the ones most likely to fail. Note that GUI Electron launches produce no
stdout under an agent's shell (CLAUDE.md:245), so: background `npm start` with output
redirected to a file (the pattern `scripts/smoke-test-cobuild.sh:29-31` already uses),
grep `~/Library/Application Support/acabox/development/cobuilding.log` for a stable
`[McpHost]` prefix on every state transition, and drive the UI over CDP. Only the two
chat turns need a human.

Plus per increment: `npx tsc --noEmit` clean, `npm start -- -- --smoke-test` exits 0,
and one CDP screenshot.

> ### R17 — Verification additions
>
> The doctrine is right and the suite is strong. Seven gaps:
>
> 1. **`--smoke-test` proves nothing here** — see R9. Either drop it from the
>    per-increment list with a note, or add `--smoke-test-mcp`.
> 2. **A stdout-polluting fixture.** Add `--noisy` to `echoMcpServer.mjs` (one
>    `console.log` before the handshake) and assert `diagnose` produces the
>    plain-English message, not a JSON parse error. This is the most common real-world
>    stdio MCP failure and nothing in the table covers it (R8).
> 3. **An orphan test** (R5): kill the supervisor without teardown, re-run `startAll()`
>    against the same store, assert exactly one live pid.
> 4. **A catalog test** (R1): every entry in `MCP_CATALOG` spawns, handshakes, and
>    returns a non-empty `tools/list` on this machine. The `API_CATALOG` precedent —
>    "all 16 base URLs were curled, not recalled" — is the standard to match.
> 5. **A canary test for the proxy env** (R11): a password inside `HTTPS_PROXY` must not
>    appear in the ring buffer, the detail panel, or the log tail. Extend
>    `mcpHostEnv.test.ts`'s "assert on *values*, not key names" rule to the log path,
>    which is the surface a screenshot leaks.
> 6. **One packaged run** (R4/S5). The plan verifies dev only. `process.execPath +
>    ELECTRON_RUN_AS_NODE=1`, asar/`extraResource` reachability, and the bundled MCP SDK
>    all resolve differently when packaged, and `prune: false` means `node_modules`
>    ships whole — which helps, but is not the same as proven. Do it once at Increment 0
>    (cheap, informs the design) and once at Increment 9 (confirms the shipped thing).
> 7. **Acceptance test, one more step.** After step 4, **force-quit** (`kill -9` the
>    main pid rather than ⌘Q), reopen, and assert exactly one `spike_counter` process
>    exists and the counter restarted at 1. That is the step that catches R5, and it is
>    strictly more likely to occur in real use than the clean quit in step 6.
>
> One framing note on the acceptance test as written: **it is excellent** — "the same
> process answered twice, across two turns" is exactly the right single assertion, and
> in-memory state is the right way to make it unfakeable. Keep that sentence in the test
> file itself.

---

## Pre-existing bugs this work should fix in passing

| Bug | Verdict |
|---|---|
| Double / phantom quit teardown (`index.ts:3032-3086`) | **Now** — Increment 1, blocks everything |
| `preserveUntouchedSecrets` destroys `env`/`headers` (`connectorsStore.ts:151` + `ConnectorsSettings.tsx:99`) | **Now** — Increment 3, needs both halves |
| Three-copy deep-link tab union, one of which silently strips | **Now** — Increment 8 |
| `exec`/`execStreaming` have no `cwd` option (`containerService.ts:299`, `:339`) | **In passing** — additive, Increment 2 needs it |
| `descendantsOf` private to `jobRegistry` (`:154-165`) | **In passing** — extract with its "deliberately NOT `kill(-pid)`" comment intact; duplicating it is how one copy eventually grows a `kill(-pid)` |
| `shellPath.ts:114` fails silently | **In passing** (~30 min) — a user-supplied `command` will generate exactly the "works in Terminal, 127 from the Dock" reports this hides |
| Stale port-range comment (`containerService.ts:840-841`) | **In passing** — one line; CLAUDE.md records it already misled a session |
| B12 kernel-gateway instance identity | **Defer** — architecture D adds no new port, so this stays exactly as broken, which is not a regression |
| Relay timeout mismatch (60s vs 120s) | **Defer** — but a hosted server inherits 120s, so consider a per-server timeout |

---

## Explicitly not building

1. **The loopback Streamable-HTTP bridge** — unless the spike says the sdk path fails.
   Port range, bearer token, session table, JSON-RPC id remapping, SSE upgrade, spec
   negotiation. That is the majority of the original 15–20 day estimate and buys
   nothing when the only client is Claude and Claude already speaks sdk-server. Also
   directly contrary to "local only".
2. **A signed record / HMAC** — solved by storage placement plus the `safeStorage`
   seal.
3. **A bundled Node runtime** — ~50MB, a second ABI universe, a new notarization
   surface. `process.execPath` + `ELECTRON_RUN_AS_NODE=1` is already proven here.
4. **Python servers (`uvx`/`pipx`)** — the venv exists but `uvx` does not, and a second
   package manager doubles the trust-gate surface.
5. **OAuth for hosted servers** — they are local processes the user launched.
6. **Hot reload on file change** — `backgroundBuilder` exists; a second watcher is a
   subsystem.
7. **Per-tool policy UI before the write gate works** — one boolean per server first.

> ### R20 — Revisit #4 (Python). It is the wrong exclusion for *this* audience.
>
> Every other item on this list I agree with without qualification — #1 in particular is
> a genuinely good call and saves the majority of the original estimate.
>
> But #4 reasons from *our* cost ("a second package manager doubles the trust-gate
> surface") rather than from the user. Acabox is an app for scientists; the scientific
> tooling ecosystem is Python, and this repo **already runs a Python venv with pip**
> (`pythonSetup.ts`, `packageInstaller.ts`) with `pandas numpy matplotlib` in it. So the
> cost is not "a second package manager" — pip is already here, already bootstrapped,
> already installing user packages. It is `uvx` specifically that does not exist, and
> `uvx` is not required: a Python MCP server is `pip install <pkg>` into the existing
> venv plus `<venv>/bin/python -m <module>` as the command, which is the *same* two steps
> as 6a and reuses `ensurePythonVenv` verbatim.
>
> Not arguing to build it in v1 — the exclusion is fine for the ship gate. Arguing that
> the stated reason is wrong, which matters because a wrong reason tends to survive into
> the next review. Rewrite it as: *"Deferred, not refused. `pip` into the existing venv
> is the mechanism; `uvx` is not needed and should not be added. Revisit once the npm
> path (6a) has shipped and the install/probe/diagnose pipeline is shared."*
>
> Also missing from this list, and worth adding explicitly so nobody builds it by
> accident: **no MCP tool that lets the agent register or start a server.** Increment 5
> states the principle beautifully ("The agent writes files; the host notices; the user
> enables") but the principle lives in a paragraph two sections away from the list that
> future readers will actually check.

## Note on `facebook-marketplace-mcp` as the first customer

Good integration test, bad launch partner. It exercises every hard part honestly
(native-module ABI, interpreter resolution, env passthrough, a mandatory build step, a
Keychain prompt from a GUI app) and has on-disk state that *proves* respawn tolerance.
But: 4 commits, all 2026-04-09/10, nothing since; no license, no tests. Its GraphQL
`doc_id`s were captured 2026-04-10 and Facebook rotates them per deploy, so **it will
most likely return zero results**, and its own README states it violates Meta's ToS.
Its `auth.ts:113` selects `WHERE host_key LIKE '%facebook.com'` — every cookie,
including the session cookie that also authenticates Messenger. Use a throwaway
account, and keep `npx -y @modelcontextprotocol/server-filesystem` as the boring second
example so "local MCP servers work" is not judged on "Facebook returned nothing."

---

## Product questions

Engineering questions are settled above or deferred to the spike. These are the ones a
product review should actually decide. Each carries my recommendation so there is
something to push against.

**1. Is `Servers` the right name, at the right prominence?**
It is infrastructure vocabulary in an app for scientists, and it would make a seventh
rail item. Alternatives: `Connections`, `Capabilities`, `Integrations`, or no top-level
slot at all (a section under Tools). *Recommendation: keep `Servers` and the top-level
slot.* The page answers "what can Claude reach", which is a question the user asks
directly, and the three existing homes for that answer (buried Settings, invisible
registry, hardcoded relays) is why they asked in the first place.

**2. Which half is the headline — agent-authored, or GitHub install?**
The plan builds both (Increments 5 and 6, 5 days combined). If only one shipped:
GitHub install is more immediately useful; **agent-authored is more differentiated** —
"ask Claude to build you a tool server, then host it" is a thing no other app does, and
it is the fork's own charter. *Recommendation: agent-authored first.* It also creates
its own demand, which matters given question 6.

**3. Is a disclosure enough, or does the write gate need to move earlier?**
Every tool a hosted server offers is auto-approved, because there is no `canUseTool`
handler anywhere in the app. Increment 7 adds a per-tool write gate, but it lands
*after* the installer. For a private single-user tool a disclosure may genuinely be
enough. *Recommendation: leave the order, but only because Increment 5's servers are
Claude's own code that the user read. If Increment 6 (a stranger's repo) ships first,
move the write gate ahead of it.*

**4. Do mini-app published servers stay iframe-bound?**
The plan gives them a UI section but does not make them headless — so the charter line
"mini-apps can create and run MCP servers" stays half-true: they run only while the
tool is on screen. Making them headless is a separate ~3 days and a second code path.
*Recommendation: leave them. Increment 5 supersedes the use case — if you want a
persistent server, Claude writes you one; the iframe kind is for tools that expose
their own on-screen state.*

**5. Does the scheduler belong on Activity?**
Decided as yes (Increment 8), on the argument that a schedule and the output it
produces should be on one screen. Worth a second opinion: it is also the only nav
placement where someone looking for "automations" would not think to look.

**6. What does the user actually run on day one?**
Honest answer today: probably nothing. `facebook-marketplace-mcp` will most likely
return zero results (its GraphQL ids are ~4 months stale), and no other concrete server
has been named. If that stays true, the feature's value is speculative until Increment
5 lands. *Recommendation: treat this as the real risk, not the engineering. Name three
servers you would run before starting Increment 6.*

**7. Is there a smaller version worth stopping at?**
Spike + teardown fix + Servers page = **5 days**, and it already delivers: mini-app MCP
servers become visible for the first time, the stale-green status lie is fixed, and the
stdio config surface becomes usable. It does *not* deliver a persistent process.
*Recommendation: build to Increment 4 (~9.5 days) — that is the first point where the
headline claim is true — then re-decide.*

---

## Review: answers to the product questions

> **Q1 — the name.** *"Servers" is infrastructure vocabulary in an app for scientists*
> is the right diagnosis and "keep it" is the wrong conclusion. The page's job is to
> answer **"what can Claude reach?"** — so name it that. My preference, in order:
> **`Connections`** (covers hosted servers, remote connectors and APIs, which are three
> homes for one question today and should converge), then `Capabilities`, then
> `Integrations`. `Servers` last: it is the only one of the four that names the
> *implementation*, and the plan itself argues the user is asking a capability question.
>
> There is also a cheap way to stop debating it: the rail item is
> `{tab, label, icon}` in one array (`Rail.tsx:21-28`) and the label is a string. Ship
> whichever, and change it after watching one non-technical user look for it. Do
> **not** let this block Increment 3.
>
> One structural point the question does not raise: if the page really answers "what can
> Claude reach", then **remote connectors and registered APIs belong on it too**, and
> Settings keeps only the credential editing. The plan currently leaves a footer link to
> Settings, which preserves the split the user complained about. Not a v1 requirement —
> but if the answer to Q1 is `Connections`, that is the shape it wants to grow into, and
> knowing that now costs nothing.
>
> **Q2 — headline.** Agree: agent-authored (Increment 5) first, and R1 strengthens the
> case. A GitHub installer with no catalog serves users who could already run the server
> in a terminal; "ask Claude to write me one" serves the user this app is for. With R1's
> catalog in place, Increment 6 also stops being the *only* acquisition path, which
> makes deferring it cheap.
>
> **Q3 — disclosure vs. gate.** Make the reorder unconditional. See R15.
>
> **Q4 — mini-app servers stay iframe-bound.** Agree, no reservations. The disclosure
> copy for that section is the clearest paragraph in the document.
>
> **Q5 — scheduler on Activity.** Agree with the placement *and* with the doubt. Both
> are satisfiable: put the list on Activity, and add a single rail-level entry point
> later if anyone actually fails to find it. More useful than the placement debate:
> **pull it out as its own PR now** (R18) — it is unrelated to MCP and is being held
> hostage by a four-week plan.
>
> **Q6 — what runs on day one.** *"Treat this as the real risk, not the engineering"* is
> the most important sentence in the document, and R1 is my answer to it. "Name three
> servers you would run before starting Increment 6" is the right instruction — I would
> make it stronger: **name them before starting Increment 2**, because if the honest
> answer is still "none", the supervisor is 2 days spent on a page with nothing to put
> on it. My proposed six are in R1; the first three (filesystem, fetch, sqlite) are
> credential-free, verifiable today, and immediately useful to someone with a folder of
> research data — which is the entire user base.
>
> On `facebook-marketplace-mcp`: the assessment is correct and, if anything, understated.
> A server that reads *every* `facebook.com` cookie including the Messenger session, from
> a repo with no license and no commits in four months, whose own README says it violates
> the platform's terms, and whose GraphQL ids are stale enough that it will most likely
> return nothing — that is not a launch partner and arguably not an integration test
> either, since a test that returns zero results cannot distinguish "works" from
> "broken." Use it as a **manual** ABI/Keychain exercise once, on a throwaway account,
> and keep it out of the catalog and out of the docs.
