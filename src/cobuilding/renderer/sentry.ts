/**
 * Cobuilding renderer-process Sentry init.
 *
 * Imported only from renderer-process code paths so the main-process bundle
 * doesn't pull in `@sentry/electron/renderer` (which depends on `window`).
 */

import * as Sentry from '@sentry/electron/renderer';
import { setCaptureImpl } from '../shared/telemetry';

/**
 * Initialize Sentry in the renderer process. Must be called before
 * `createRoot()` in the entry point.
 *
 * No DSN / release / environment needed — they're inherited via IPC from the
 * main-process Sentry instance.
 *
 * No-op if `SENTRY_DSN` is empty.
 */
export function initSentryRenderer(): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({});

  setCaptureImpl((error, options) => {
    Sentry.captureException(error, {
      tags: options?.subsystem ? { subsystem: options.subsystem } : undefined,
      extra: options?.extra,
    });
  });
}
