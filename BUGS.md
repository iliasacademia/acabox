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

- **B14** (2026-07-29) — `agentSession.ts:194` (`emitEvent`) vs `sessionRegistry.ts:308`
  (`destroyEntry` → `fireDestroyHooks`) — `emitEvent` iterates the LIVE `listeners` Set
  (`for (const listener of listeners)`, no spread copy — unlike `emitDone` at :200 which does
  copy). The registry's own listener is registered first (`registerSession`) and the renderer
  forwarding pipe second (`ensureForwarding`), so on the deferred-destroy path the registry's
  `turn-complete` handler runs first, destroys the session, fires the destroy hook, and deletes
  the forwarding listener from the Set **before the iteration reaches it**. Per spec a Set
  iterator skips elements deleted before they are visited (verified). Net effect: the renderer
  never receives `turn-complete` for exactly the navigate-away-mid-turn case the
  `fix/streaming-stuck-thinking` work targets, so the run only ends via the 45s stall watchdog.
  Reproduced with a faithful no-copy mock: pipe received `[]`. Fix: `for (const listener of
  [...listeners])` in `emitEvent`, matching `emitDone`.
- **B15** (2026-07-29) — `progressStore.ts:106` / `chatAdapter.ts` stall branch — `processingLabel`
  is a single module-global, but the stall watchdog writes `RECONNECTING_LABEL` from a per-thread
  run. A background thread that stalls sets the label for whatever thread the user is currently
  viewing, so a healthy chat can display `RECONNECTING…`. Realistic given parallel chats. Fix:
  key the processing label by threadId, or only render it for the thread that set it.

- **B12** (2026-07-22) — `containerService.ts:27` (`findFreePort`) vs `agent-server/index.ts:752`
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

- **R9** (2026-07-29) — `main/index.ts:557` (`ensureForwarding`) — "now that `removeForwarding`
  no longer tears down the pipe, `sender.on('destroyed', onSenderGone)` accumulates one listener
  per visited thread and trips Node's 10-listener `MaxListenersExceededWarning`." Investigated:
  a pipe's lifetime is bounded by its session's, and a session is destroyed as soon as its last
  subscriber detaches with no turn running, so concurrent pipes ≈ concurrent live sessions
  (a handful even with parallel chats; the longest-lived outlier is a 5-minute OAuth pin).
  Never approaches the limit, and the ceiling is a console warning rather than a fault.
- **R10** (2026-07-29) — `chatAdapter.ts` stall loop — "a `setTimeout`/`clearTimeout` pair per
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
