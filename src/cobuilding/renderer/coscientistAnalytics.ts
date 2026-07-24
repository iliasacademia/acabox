/**
 * CoScientist analytics — renderer-process emit module.
 *
 * The renderer never talks to the backend directly. Every track() call
 * forwards to the main process via `telemetry:track` IPC, which owns
 * the API client, session cookies, telemetry context, and auth gate.
 *
 * Why renderer→main→backend (instead of building the envelope here
 * and POSTing via academia:fetch): single source of truth for SESSION_ID
 * and correlation keys, no risk of drift between renderer copies and
 * main, and auth gating happens in one place.
 *
 * See `src/cobuilding/docs/ANALYTICS.md` for the strategy.
 */

import type {
  CoScientistEvent,
  CoScientistSurface,
  TelemetryContext,
} from '../shared/analyticsTypes';

// ---------------------------------------------------------------------------
// IPC bridge types (matches preload.ts)
// ---------------------------------------------------------------------------

interface TelemetryContextWithMeta extends TelemetryContext {
  session_id: string;
  authenticated: boolean;
}

interface TelemetryAPI {
  getContext: () => Promise<TelemetryContextWithMeta | null>;
  subscribeAuthState: () => Promise<{ authenticated: boolean }>;
  track: (
    eventName: string,
    metadata: Record<string, unknown>,
    surface?: CoScientistSurface,
  ) => Promise<{ ok: boolean; reason?: string }>;
  onAuthStateChanged: (cb: (authenticated: boolean) => void) => () => void;
}

declare global {
  interface Window {
    telemetryAPI?: TelemetryAPI;
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let context: TelemetryContextWithMeta | null = null;
let authenticated = false;
let initPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Bootstrap the renderer-side analytics: fetch context from main and
 * subscribe to auth-state changes. Idempotent — subsequent calls return
 * the same promise.
 *
 * Should be called once near app entry, before any track() call.
 */
export function initAnalytics(): Promise<void> {
  if (initPromise) return initPromise;

  if (!window.telemetryAPI) {
    // Tests / fallback — analytics is a no-op without the IPC bridge.
    initPromise = Promise.resolve();
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const fetched = await window.telemetryAPI!.getContext();
      if (fetched) {
        context = fetched;
        authenticated = fetched.authenticated;
      }
      const { authenticated: authState } = await window.telemetryAPI!.subscribeAuthState();
      authenticated = authState;

      window.telemetryAPI!.onAuthStateChanged((value) => {
        authenticated = value;
      });
    } catch (err) {
      // Analytics failures must never break the app. Log and continue.
      // eslint-disable-next-line no-console
      console.warn('[Analytics] init failed:', err);
    }
  })();

  return initPromise;
}

export function isAuthenticated(): boolean {
  return authenticated;
}

export function getContext(): TelemetryContextWithMeta | null {
  return context;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget event emission from the renderer.
 *
 * Auth-gated locally as a fast path (no IPC if we know we're not
 * authenticated). Main re-checks the gate on its side as the
 * source-of-truth.
 *
 * Returns void — callers should not await. The POST happens in the
 * background and any failure is logged.
 */
export function track<E extends CoScientistEvent>(
  event: E,
  options?: { surface?: CoScientistSurface },
): void {
  if (!authenticated) return;
  if (!window.telemetryAPI) return;

  window.telemetryAPI
    .track(event.name, event.metadata, options?.surface)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[Analytics] track(${event.name}) failed:`, err);
    });
}
