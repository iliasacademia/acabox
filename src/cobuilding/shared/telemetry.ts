/**
 * Cobuilding telemetry — shared API.
 *
 * This file has NO Sentry imports so it can be bundled into both the main and
 * renderer chunks without webpack pulling Node-only modules (fs, http, etc.)
 * into the renderer.
 *
 * Each side (main / renderer) initializes Sentry via its own dedicated file
 * (`src/cobuilding/main/sentry.ts` / `src/cobuilding/renderer/sentry.ts`),
 * and registers a `captureError` implementation here. All other call sites
 * (subsystems, the Debug → Telemetry panel, the ErrorBoundary) just import
 * `captureError` from this module — they don't know which side they're on.
 */

export interface CaptureOptions {
  /** Subsystem tag (e.g. 'container', 'agent', 'kernel'). Becomes the Sentry `subsystem` tag. */
  subsystem?: string;
  /** Additional context attached as Sentry `extra`. */
  extra?: Record<string, unknown>;
}

type Capturer = (error: unknown, options?: CaptureOptions) => void;

let captureImpl: Capturer | null = null;

/**
 * Register the side-specific capture function. Called from
 * `initSentryMain()` / `initSentryRenderer()` after Sentry's SDK is up.
 */
export function setCaptureImpl(fn: Capturer): void {
  captureImpl = fn;
}

/**
 * Capture an error to Sentry. Safe to call from any process.
 *
 * Until `initSentryMain()` / `initSentryRenderer()` has run on the current side,
 * this is a no-op (so early-boot errors are swallowed silently rather than
 * throwing). The init calls happen as one of the first things on each entry
 * point, so the window is very small.
 *
 * Also a no-op when `SENTRY_DSN` is empty — the init functions skip
 * `setCaptureImpl` in that case.
 */
export function captureError(error: unknown, options?: CaptureOptions): void {
  if (captureImpl) captureImpl(error, options);
}
