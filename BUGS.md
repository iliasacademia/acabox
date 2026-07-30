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
B14-B18 (2026-07-29, api-tokens design review; B16 was already fixed in the
implementation, the other four fixed 2026-07-29 in one pass):
B14 — the per-app API grant was bypassable. `buildSubprocessEnv()` handed ONE
app-wide proxy token to every child it spawned, including the subprocess behind
a mini-app's `hostAPI.exec()`, so an ungranted tool could curl the proxy and be
served as the chat agent. The token is now the IDENTITY: `apiProxy.tokenFor()`
mints a stable per-caller token, `authorize()` resolves the bearer to a caller,
and `execLogged` derives that caller from `source === 'iframe' && appDirName`.
Keying off appDirName ALONE would have been wrong — `parseAppDirFromArgs` gives
the agent an appDirName whenever it runs `.applications/install … --app x`, which
would have silently downgraded the agent to one tool's grants mid-install.
Grants stay out of the token and are resolved per request through an injected
`setToolGrantResolver`, so a revoke lands on the next call; both doors now share
that one resolver instead of the IPC door reading the manifest itself.
B15 — `resolveTargetUrl` mishandled two ordinary path forms. A base URL with no
trailing slash dropped its last segment (RFC 3986 relative resolution), and a
leading-slash path escaped to the host root and was then refused by the
base-path check — so `hostAPI.api.fetch(id, '/entries')`, the idiomatic form,
403'd while the bare form worked. `normalizeBaseUrl` is applied on save AND
inside `resolveTargetUrl` (so entries stored by an earlier build are corrected
without a migration), and a single leading slash is stripped — only one, so
`//host/x` stays a host swap for the allow list to judge. NB an existing test
asserted the dropped-segment behaviour as correct; it was encoding the bug.
B16 — was already correct in the implementation: `apiProxy.start()` runs at
`AgentInfrastructureController.ts:341`, before `startAgentServer` at `:386`, so
the proxy's listening lifetime contains the agent server's and the frozen child
env always carries a live base URL and token.
B17 — no upstream timeout, so a hung API held a turn open forever. Now a 30s
deadline to RESPONSE HEADERS shared across all redirect hops (not per hop, which
would have allowed 5×30s), implemented with an AbortController cleared the
instant `fetch` resolves — `AbortSignal.timeout()` would have stayed armed and
aborted a long download mid-stream, and uncapped body streaming is the property
that justified a proxy over an MCP tool.
B18 — `x-http-method-override` / `x-method-override` / `x-http-method` were not
stripped, so a framework honouring them could reinterpret an allowed GET as a
mutation on the far end and walk through the read-only gate.

B19/B20 (2026-07-29, self-review of fix/streaming-stuck-thinking; fixed same
day — originally filed as B14/B15, renumbered on merge because feat/api-tokens
had concurrently allocated those ids to its design review):
B19 — `emitEvent` iterated the LIVE listener Set while `emitDone` snapshotted.
The session registry registers its listener first and the renderer's event pipe
second, so on the deferred-destroy path the registry handled `turn-complete` by
destroying the session, which ran the destroy hooks, which deleted the pipe from
the Set before the iteration reached it — and a Set iterator skips an element
removed before it is visited. The renderer never received the terminator on
exactly the navigate-away-mid-turn path the branch fixes, so the run only ended
via the 45s stall watchdog. Dispatch is now a shared exported
`dispatchChatEvent` that snapshots; the registry test emits THROUGH it, because
the reason B19 shipped green was a mock that spread-copied while production did
not. Verified live afterwards: detach 2s into a real turn, 38 further events
plus turn-complete still delivered.
B20 — the processing label was one module-global string, so a stalled
background thread painted RECONNECTING… onto whichever thread the user was
viewing. Now a Map keyed by threadId, with `resetProgress(threadId)` scoped to
match.

B21-B25 (2026-07-29, all fixed 2026-07-29 in the same pass):
B21 — the dropped-upstream pass deleted a built-in with a bare rmSync, bypassing
the trash every other destructive op uses, and its guard was
`modifiedFiles(...).length === 0` — a function that deliberately SKIPS
host-owned paths, so `references/findings/**` was invisible to the very test
deciding whether erasing was safe. Now routed through `newTrashDir`/`moveInto`,
and `hostOwnedFiles()` asks the other half: a dropped skill holding findings is
kept as custom rather than removed. Three tests, incl. one that writes a finding
and asserts the skill still reads unmodified before dropping it upstream.
B22 — the blast-radius grep was execFileSync on the Electron main thread, so a
`record_finding` over real research directories froze the whole UI. Now
`execFile` (SIGKILL on timeout, per the shellPath lesson), `recordFinding` and
`findBlastRadius` are async, and a single BLAST_TOTAL_BUDGET_MS covers all roots
and tokens together — the per-root timeout was charged once per root PER TOKEN
and so had no ceiling. Pinned by a liveness test: a 15ms timer must fire during
a grep over 3000 files (~80ms measured), which a synchronous grep cannot allow.
B23 — guarded in `normalizeState`, the single funnel every state-file reader
comes through, rather than in `reconcile` alone; covers every consumer for free.
Test asserts a sentinel file outside the store survives a traversal id.
B24 — adoption and recovery now arrive DISABLED for an UNKNOWN directory, closing
the path where the agent (which has Write+Bash on the workspace) could create
`<workspace>/.claude/skills/<x>` and be on the roster at the next boot. A
directory matching a SHIPPED skill stays enabled deliberately: recovery exists
for a lost state file, and answering that by emptying the roster is worse than
the risk. Residual noted in the code — an agent could name its directory after a
shipped skill, but that reads as a MODIFIED built-in and cannot add a new skill.
B25 — guarded inside `deleteSkill` rather than at the `skills:delete` IPC, so
every caller is covered rather than the one that was noticed.

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

- **R11** (2026-07-29) — `main/index.ts:557 (streaming fix)` (`ensureForwarding`) — "now that `removeForwarding`
  no longer tears down the pipe, `sender.on('destroyed', onSenderGone)` accumulates one listener
  per visited thread and trips Node's 10-listener `MaxListenersExceededWarning`." Investigated:
  a pipe's lifetime is bounded by its session's, and a session is destroyed as soon as its last
  subscriber detaches with no turn running, so concurrent pipes ≈ concurrent live sessions
  (a handful even with parallel chats; the longest-lived outlier is a 5-minute OAuth pin).
  Never approaches the limit, and the ceiling is a console warning rather than a fault.
- **R12** (2026-07-29) — `chatAdapter.ts` stall loop — "a `setTimeout`/`clearTimeout` pair per
  streamed event (thousands per turn with text deltas) is a hot-path cost." Measured against
  reality: timer create/clear is sub-microsecond and dwarfed by the IPC hop and React render
  already happening per event. Not worth complicating the loop with a shared timer.

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
