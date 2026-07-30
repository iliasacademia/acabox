# BUGS.md — living bug ledger

> **Protocol — read this before running `/self-review` or proposing findings.**
>
> 1. **Read this file first.** Do not re-raise anything already listed (Outstanding or Rejected).
> 2. **Outstanding** = known bugs, not yet fixed. When fixed, **delete the entry** — git history is
>    the record; a recurrence is a fresh regression.
> 3. **Rejected** = findings proposed before and judged not-a-bug or won't-fix. Kept **permanently**
>    with the reason so they aren't re-litigated.
> 4. **IDs are stable.** Allocate the next free number (`B<n>` / `R<n>`); never reuse a retired one.
> 5. Each entry needs a **location** and a **one-line claim** so a future review can match it.

## Outstanding

- **B14** (2026-07-29) — `docs/design/api-tokens.md`, "Why mini-apps do NOT get the loopback URL" —
  the per-app API grant is bypassable: `hostAPI.exec()` → `container:execLogged`
  (`index.ts:1019`) → `containerService.exec()` (`:273`) uses `buildSubprocessEnv()` (`:370`), so a
  mini-app's subprocess inherits `ACABOX_API_TOKEN` and can curl the proxy as the chat caller,
  reaching every enabled API regardless of its grant. Fix direction: per-caller scoped tokens keyed
  off the `meta.appDirName` `execLogged` already receives; the token becomes the caller identity.
- **B15** (2026-07-29) — `docs/design/api-tokens.md`, `resolveTargetUrl` rules 1/4 — a `baseUrl`
  without a trailing slash silently drops its last path segment, and rule 4's base-path check
  rejects the leading-slash path form (`/entries`) that the Phase-2 mini-app API and REST docs both
  produce. Measured on Node. Fix: normalize baseUrl to a trailing `/` at save, strip a leading `/`
  from the request path, keep rule 4 as a post-normalization `..` guard only.
- **B16** (2026-07-29) — `docs/design/api-tokens.md`, "The loopback server" — spec says the proxy
  starts "alongside the agent server", but `startAgentServer` freezes the child env at spawn
  (`containerService.ts:435`, called from `AgentInfrastructureController.ts:325`). Binding the proxy
  after that point leaves `ACABOX_API_BASE`/`ACABOX_API_TOKEN` unset for the agent server's whole
  life, with no error. Invariant to state and test: the proxy's listening lifetime strictly contains
  the agent server's.
- **B17** (2026-07-29) — `docs/design/api-tokens.md`, `performApiRequest` — no upstream request
  timeout is specified, unlike every comparable path here (exec 600s, MCP registry 60s, connector
  reload 15s). A hung upstream holds the agent's turn open indefinitely. Must not apply to body
  streaming, which is the feature's justification.
- **B18** (2026-07-29) — `docs/design/api-tokens.md`, `performApiRequest` step 6 — the caller-header
  strip list omits `X-HTTP-Method-Override` / `X-Method-Override` / `X-HTTP-Method`, which some REST
  frameworks honor to convert a GET into a mutation, bypassing the read-only gate. Unverified which
  catalog APIs honor them; cost to close is three strings.

- **B12** (2026-07-22, NARROWED 2026-07-29) — **agent-server half is FIXED**: `main/freePort.ts`
  now probes `127.0.0.1` (`LOOPBACK`) and `/health` echoes a per-app-run instance token that
  `isAgentServerHealthy()` requires before adopting a server. **Kernel-gateway half is still open**:
  `containerService.ts:811-815` spawns the gateway with `--KernelGatewayApp.allow_origin=*` and no
  `--KernelGatewayApp.auth_token`, and `isKernelGatewayHealthy()` carries no instance identity, so
  two Acabox instances picking from the shared 23400-23499 range can still cross-attach to each
  other's kernel. Original entry below for context.
  `containerService.ts:27` (`findFreePort`) vs `agent-server/index.ts:752`
  and the kernel gateway (`containerService.ts:538`) — the free-port probe binds `0.0.0.0` while
  the agent server and kernel gateway bind `127.0.0.1`; on macOS the wildcard probe succeeds even
  when another process holds the same port on loopback (SO_REUSEADDR), so a second app instance
  (packaged + dev together) picks the same port and, because neither `/health` nor the kernel
  gateway carries an instance identity, silently cross-attaches to the other instance's server.
  The pollution review's port-range move (kernel → 23400-23499) only removes overlap with the
  *original* container-era app; two Acabox instances still collide. Fix direction: probe on
  `127.0.0.1`, and add a per-instance token to `/health` + `--KernelGatewayApp.auth_token`.
  (Found by the rename/pollution reviews 2026-07-22; pre-existing, not rename-introduced.)

<!--
B13 (User-Agent WritingAgent→Acabox login-gating concern) is retired: academia
login was removed entirely (see "Removed academia login" in CLAUDE.md), so there
is no login/credential fetch left to break. academia:fetch still sends the Acabox
UA but is optional and unauthenticated.

B1/B2/B3 (all `shellPath.ts`) resolved together: `getLoginShellPath()` is now
wired into `buildSubprocessEnv` (B1), pre-warmed off the event loop via
`prewarmLoginShellPath()` in `HostProcessService.start()` (B2), and reads the
exported PATH through a nested POSIX `sh -c` so it is colon-joined under every
shell including fish (B3). See git history for details.

B4/B5/B6 resolved together: `ensureNpmAvailable` probes `which npm` under the
login-shell PATH (B4); `findSystemPython` probes under the login-shell PATH and
returns the interpreter's ABSOLUTE `sys.executable` — not the ledger's
"same fix as B4" env-threading, which would have let the probe and the
un-augmented `python -m venv` spawn resolve different interpreters (B5); and
`start()` now awaits `prewarmLoginShellPath()` (Promise.all with the symlink
sync) so the first sync `getLoginShellPath()` is guaranteed warm (B6). Both
probe sites also self-prewarm, covering calls that precede start().

B7/B8/B9/B10 (post-fix review of the above, all fixed same day):
B7 — shellPath spawn timeouts used the default SIGTERM, which interactive
shells ignore, making the 5s timeout a no-op against a blocking rc file
(empirically reproduced); now killSignal: 'SIGKILL'. B8 — one failed/slow
resolution permanently cached the minimal launchd PATH with no retry; now
success-only caching with a separate sync-served fallback that the async
prewarm may retry, plus err.stdout marker salvage on timeout. B9 — prewarm
had no single-flight guard, so concurrent cold callers spawned duplicate
login shells; now a shared in-flight promise. B10 — findSystemPython's
anchored first-two-lines parse rejected interpreters whose sitecustomize
prints banners (tolerance regression vs the old unanchored --version match);
now marker-delimited (`__CB_PY__…__CB_PY__`).

B11 (post-fix review round 2, fixed same day) — the async prewarm's execFile
handed the login shell an open pipe stdin (unlike the sync path's 'ignore'),
so an rc file that reads stdin (zsh compaudit prompt, `read`) blocked until
timeout on every retry while the short-circuit on fallbackPath kept the
working sync spawn unreachable; now `pending.child.stdin?.end()` gives reads
instant EOF.
-->

## Rejected

- **R9** (2026-07-29) — `docs/design/api-tokens.md` — "the API write gate can't be a real boundary,
  because the agent has unrestricted auto-approved Bash and there is no `canUseTool` handler." Not a
  bug **for the agent**: API secrets are `safeStorage`-encrypted (`main/secretStore.ts`), so a Bash
  subprocess cannot decrypt them and the proxy is the only route to a usable credential — a refused
  method is refused absolutely. This is genuinely unlike `block-secret-reads.sh`. Note the claim does
  NOT extend to mini-apps, where `exec` is arbitrary code execution; that half is B14.
- **R10** (2026-07-29) — `docs/design/api-tokens.md` — "the loopback exception in `validateApi`
  (inherited from `connectors.ts#isLoopbackHost`) lets a user register a custom API pointed at
  `127.0.0.1`, turning the proxy into an SSRF gadget against Acabox's own agent server and kernel
  gateway." No privilege gain: the agent already has unrestricted Bash and can curl those loopback
  ports directly, and a mini-app has `hostAPI.exec`. Worth one guard anyway (the proxy should refuse
  to target its own port, to avoid trivial self-recursion), but not a security finding.

- **R1** (2026-07-22) — `containerService.ts:129` — "`void prewarmLoginShellPath()` can leak an
  unhandled promise rejection." Not a bug: every await inside the function is wrapped in
  try/catch and all fallback paths return normally; there is no rejecting path.
- **R2** (2026-07-22) — `shellPath.ts:46` — "fish expands `$PATH` inside the inner command,
  defeating colon parsing." Not a bug: the inner `sh -c '…"$PATH"…'` is single-quoted, and fish
  (like POSIX shells) does not expand variables inside single quotes; the nested `sh` reads the
  *exported* PATH, which every shell including fish exports colon-joined.
- **R3** (2026-07-22) — `shellPath.ts:46` — "`%` in a PATH entry breaks the printf, or a literal
  `__CB_PATH__` in PATH corrupts marker parsing." Not a bug: PATH is passed as a printf *argument*
  (consumed by `%s`), not as the format string; a real PATH entry containing `__CB_PATH__` is not
  a realistic input.
- **R4** (2026-07-22) — `containerService.ts:13,20` — eslint `no-unused-vars` errors for `os` and
  `captureError`. Pre-existing at HEAD (reproduced via `git stash` on 2026-07-22); not introduced
  by the shellPath change set. Won't-fix within this change; clean up separately if desired.
- **R5** (2026-07-22) — `containerService.ts:132` / `shellPath.ts` — "start() hard-depends on
  prewarm settling, and a daemon grandchild inheriting the shell's stdout/stderr pipes can hold
  execFile's 'close' open indefinitely." Not a bug: Node's exec/execFile timeout handler destroys
  child.stdout/stderr *before* sending killSignal, forcing 'close' regardless of who still holds
  the write ends. (The related shell-ignores-SIGTERM hang was real and fixed as B7.)
- **R6** (2026-07-22) — `nodeSetup.ts:56` — "on win32, `where npm` lists the extensionless POSIX
  `npm` script first, so the resolved path is non-executable." Accurate observation, but the sole
  caller (`packageInstaller.ts:287`) uses `ensureNpmAvailable` purely as an availability probe and
  discards the returned path; nothing spawns it. Latent future-caller hazard only; this fork is
  macOS-targeted throughout.
- **R7** (2026-07-22) — `index.ts:899` — "container:exec IPC is reachable from the ContainerTests
  debug panel before start(), hitting a cold sync getLoginShellPath on the main thread." Not
  reachable: `ContainerTests.tsx` is imported nowhere in the renderer (dead code); the only live
  renderer caller (MiniAppViewer bridge) requires an active workspace, whose boot path awaits
  containerService.start() → prewarm first.
- **R8** (2026-07-22) — `containerService.ts:124` — "the isStarting early-return lets a concurrent
  start() proceed without the warm-cache guarantee (StrictMode double-mount / Retry race)." Not
  reachable: React StrictMode is not enabled (single mount-effect fire), and SetupBanner's Retry is
  only reachable after the first ensureSetup settled and isStarting was reset in `finally`. The B9
  single-flight guard further shrinks any residual window.
