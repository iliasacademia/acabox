import { execFileSync } from 'child_process';

/**
 * Process-tree utilities: killing a real OS process tree safely, without
 * `kill(-pid)`.
 *
 * Extracted from `jobRegistry.ts` (~:125-169) rather than duplicated, because
 * a mini-app's shell command and a hosted MCP server's stdio child
 * (`docs/design/mcp-hosting.md`, Increment 2) are the same shape of problem —
 * "something spawned a process tree we now need to stop" — and the comment
 * below explaining why that is NOT `kill(-pid)` is the single most valuable
 * paragraph in either file. `jobRegistry.ts` imports `descendantsOf` and
 * `pidSignatureOf` from here; its own behaviour is unchanged.
 */

/**
 * A fingerprint of a running process, so a recycled pid can't be mistaken for
 * our job after a restart. Deliberately **start time only**: pid + start time
 * is unique, whereas the command line is not stable. `sh -c "…"` execs into the
 * program it runs, so `ps` reports `/bin/sh -c sleep 30` at spawn and `sleep 30`
 * a moment later — including the command here made every shell command fail to
 * re-adopt. Caught by test, 2026-07-28.
 */
export function pidSignatureOf(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8', timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    return null; // no such process
  }
}

/**
 * Every descendant of `pid`, deepest first, so a tree can be killed from the
 * leaves up without orphaning anything.
 *
 * Deliberately NOT `kill(-pid)`: a process-group kill is the usual shortcut,
 * but these children are spawned without `detached`, so they share Acabox's own
 * process group — a negative-pid signal would kill the app itself. Adopted jobs
 * from an older build make that worse, since we can't know how they were
 * spawned. Walking the tree is safe regardless.
 */
export function descendantsOf(pid: number, depth = 0): number[] {
  if (depth > 10) return [];
  let children: number[] = [];
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf-8', timeout: 5000 });
    children = out.trim().split('\n').filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    return []; // no children (pgrep exits non-zero when it matches nothing)
  }
  const deeper = children.flatMap((c) => descendantsOf(c, depth + 1));
  return [...deeper, ...children];
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

/**
 * Kill an entire process tree outright: collect `[...descendantsOf(pid), pid]`
 * (deepest descendant first, the order `descendantsOf` already returns), send
 * SIGTERM to all of them, wait `graceMs` for voluntary exit, then send SIGKILL
 * only to survivors whose `pidSignatureOf` still matches the signature
 * captured for that pid before the wait began.
 *
 * That last clause is the recycled-pid guard, and it earns its keep at exactly
 * this call site: `graceMs` exists to give a well-behaved process time to shut
 * down, and that is also enough time for its pid to be reaped by the OS and
 * handed to some unrelated process before the SIGKILL pass runs. Skip the
 * check and a slow shutdown can SIGKILL that unrelated process instead of (or
 * as well as) the one this call actually meant to stop. Verified live: the
 * `--ignore-sigterm` fixture's `sleep 60` grandchild survives a bare
 * `kill(topPid, 'SIGKILL')` — reparented to pid 1 — which is exactly the
 * orphaning this function exists to prevent by walking the whole tree rather
 * than signalling one pid.
 */
export async function killTree(pid: number, opts: { graceMs: number }): Promise<void> {
  const tree = [...descendantsOf(pid), pid];

  // Captured now, before any signal goes out, so the window in which a freed
  // pid could be handed to an unrelated process is as small as it can be —
  // not narrowed to "between SIGTERM and SIGKILL", which would still leave the
  // gap between reading the tree and sending the first signal unguarded.
  const signatureBeforeWait = new Map<number, string | null>();
  for (const p of tree) signatureBeforeWait.set(p, pidSignatureOf(p));

  for (const p of tree) signal(p, 'SIGTERM');

  await new Promise<void>((resolve) => setTimeout(resolve, opts.graceMs));

  for (const p of tree) {
    const stillThere = pidSignatureOf(p);
    if (stillThere && stillThere === signatureBeforeWait.get(p)) {
      signal(p, 'SIGKILL');
    }
    // Anything else is left alone: no live process at that pid needs nothing
    // further, and a live process whose signature no longer matches is not
    // the one we set out to stop.
  }
}
