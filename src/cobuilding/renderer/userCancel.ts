/**
 * Is this abort reason assistant-ui's own user cancel (the Stop button)?
 *
 * The local runtime aborts a run with `new AbortError(detach)`: `detach: false`
 * from `cancelRun()` (Stop), `detach: true` from `detach()` (the thread was
 * switched away while main keeps the turn running). Only the first is a stop.
 * Matched by shape because the class is not exported.
 */
export function isUserCancel(reason: unknown): reason is Error {
  return reason instanceof Error
    && reason.name === 'AbortError'
    && (reason as { detach?: unknown }).detach === false;
}
