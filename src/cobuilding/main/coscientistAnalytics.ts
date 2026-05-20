/**
 * CoScientist analytics — main-process emit module.
 *
 * Sends events to the Academia arbitrary-events pipeline
 * (POST /api/v0/arbitrary_event → Firehose → Redshift).
 *
 * Design notes:
 * - Auth-gated: no events fire until setAuthenticated(true) is called.
 *   Pre-login state is silently dropped (no queue). The auth gate is
 *   flipped by cobuildingAuthService once a valid session is confirmed
 *   for this process (either persisted-session validation or fresh QR).
 *
 * - Single POST per event (no batching) for alpha simplicity. On
 *   transport failure we log.warn and drop — adding a local queue is
 *   future work if data loss bites.
 *
 * - The module is the source of truth for telemetry context. Renderer
 *   processes fetch it via IPC on boot (`telemetry:getContext`) and
 *   listen for auth-state changes (`telemetry:auth-state-changed`).
 *
 * See `src/cobuilding/docs/ANALYTICS.md` for the full strategy.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, BrowserWindow, ipcMain } from 'electron';
import log from 'electron-log';
import { callBackendApi } from '../../apiCall';
import { getDeviceId } from '../../utils/deviceId';
import {
  ANALYTICS_SCHEMA_VERSION,
  COSCIENTIST_EVENT_TYPE,
  CONTENT_BEARING_EVENTS,
  truncatePayload,
  type CoScientistArch,
  type CoScientistChannel,
  type CoScientistEvent,
  type CoScientistEventEnvelope,
  type CoScientistPlatform,
  type CoScientistSurface,
  type TelemetryContext,
} from '../shared/analyticsTypes';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const SESSION_ID = randomUUID();
let context: TelemetryContext | null = null;
let authenticated = false;

// True until the first `app.launched` event fires in this process. Used to
// stamp `cold_start: true` on that first event so dashboards can tell a
// fresh process boot from a same-process re-auth.
let coldStart = true;

// Heartbeat interval handle (cleared on app quit).
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// Renderer windows subscribed to auth-state changes.
const authStateSubscribers: BrowserWindow[] = [];

function firstLaunchSentinelPath(): string {
  return path.join(app.getPath('userData'), '.coscientist-first-launch-seen');
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Compute and store the telemetry context. Must be called once at app
 * boot, before any track() call. Reads correlation fields from Electron
 * APIs (app.getVersion / app.isPackaged) and node process info.
 */
export function initAnalytics(): TelemetryContext {
  const platform = process.platform as CoScientistPlatform;
  const arch = process.arch as CoScientistArch;

  context = {
    installation_id: getDeviceId(),
    release: app.getVersion(),
    channel: (app.isPackaged ? 'production' : 'development') as CoScientistChannel,
    surface: 'main',
    platform,
    arch,
    os_version: os.release(),
    electron_version: process.versions.electron ?? '',
    chromium_version: process.versions.chrome ?? '',
    node_version: process.versions.node ?? '',
  };

  log.info('[Analytics] Initialized:', {
    session_id: SESSION_ID,
    installation_id: context.installation_id,
    release: context.release,
    channel: context.channel,
  });

  return context;
}

export function getSessionId(): string {
  return SESSION_ID;
}

export function getContext(): TelemetryContext | null {
  return context;
}

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

export function isAuthenticated(): boolean {
  return authenticated;
}

/**
 * Flip the auth gate. Until this is called with `true`, all track()
 * calls no-op silently. Called by cobuildingAuthService at the point
 * we confirm a valid session for this process.
 *
 * Renderer processes are notified via 'telemetry:auth-state-changed'
 * so they can update their own gate.
 */
export function setAuthenticated(value: boolean): void {
  if (authenticated === value) return;
  authenticated = value;
  log.info(`[Analytics] Auth state: ${value ? 'authenticated' : 'unauthenticated'}`);

  // Notify subscribed renderers. Filter out destroyed windows.
  for (let i = authStateSubscribers.length - 1; i >= 0; i--) {
    const win = authStateSubscribers[i];
    if (win.isDestroyed()) {
      authStateSubscribers.splice(i, 1);
      continue;
    }
    win.webContents.send('telemetry:auth-state-changed', value);
  }
}

/**
 * Fire the app-lifecycle events that mark "this process has a valid
 * authenticated session." Idempotent — safe to call from both the
 * persisted-session path and the fresh-QR path. The first call flips
 * the auth gate, fires `app.launched` (with `cold_start: true` on the
 * first call of the process), and fires `app.first_launch` on the
 * first authenticated session ever on this install.
 *
 * Subsequent calls in the same process are no-ops at the event level —
 * the auth gate is already on, `cold_start` would be false, and the
 * launch markers shouldn't re-fire.
 */
export function markAuthenticated(): void {
  if (authenticated) return;
  setAuthenticated(true);

  const isCold = coldStart;
  coldStart = false;

  track({ name: 'app.launched', metadata: { cold_start: isCold } });

  const sentinel = firstLaunchSentinelPath();
  let firstLaunch = false;
  try {
    if (!fs.existsSync(sentinel)) {
      firstLaunch = true;
      fs.writeFileSync(sentinel, new Date().toISOString(), 'utf8');
    }
  } catch (err) {
    log.warn('[Analytics] Failed to read/write first-launch sentinel:', err);
  }

  if (firstLaunch) {
    track({ name: 'app.first_launch', metadata: {} });
  }
}

/**
 * Start the periodic `app.heartbeat` emit. Safe to call at app boot;
 * the auth gate inside track() will swallow heartbeats fired before
 * the user has logged in. Each tick checks `BrowserWindow.getFocusedWindow()`
 * and only emits if a CoScientist window has focus.
 */
export function startHeartbeat(): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    if (!authenticated) return;
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return;
    track({
      name: 'app.heartbeat',
      metadata: { interval_seconds: HEARTBEAT_INTERVAL_MS / 1000 },
    });
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget event emission.
 *
 * Returns void (not Promise) because callers should never await — the
 * POST happens in the background and failures are logged, not surfaced.
 *
 * `options.surface` overrides the default 'main' surface for this call
 * (e.g. background-agent-initiated briefing creates pass 'background').
 */
export function track<E extends CoScientistEvent>(
  event: E,
  options?: { surface?: CoScientistSurface },
): void {
  if (!authenticated) return;
  if (!context) {
    log.warn('[Analytics] track() called before initAnalytics()');
    return;
  }

  const surface = options?.surface ?? context.surface;
  let metadata: Record<string, unknown> = { ...event.metadata };
  if (CONTENT_BEARING_EVENTS.has(event.name)) {
    metadata = truncatePayload(metadata);
  }

  const envelope: CoScientistEventEnvelope = {
    v: ANALYTICS_SCHEMA_VERSION,
    event_name: event.name,
    installation_id: context.installation_id,
    session_id: SESSION_ID,
    release: context.release,
    channel: context.channel,
    surface,
    platform: context.platform,
    arch: context.arch,
    os_version: context.os_version,
    electron_version: context.electron_version,
    chromium_version: context.chromium_version,
    node_version: context.node_version,
    metadata,
  };

  postEvent(envelope).catch((err) => {
    log.warn(`[Analytics] POST failed for ${event.name}:`, err?.message ?? err);
  });
}

async function postEvent(envelope: CoScientistEventEnvelope): Promise<void> {
  // Route through callBackendApi (not raw APIclient.post) so the CSRF
  // token gets attached on non-GET requests. The same helper backs the
  // academia:fetch IPC bridge — same path the existing review-side
  // analytics uses successfully.
  await callBackendApi({
    method: 'POST',
    endpoint: 'v0/arbitrary_event',
    data: {
      arbitrary_event: {
        event_type: COSCIENTIST_EVENT_TYPE,
        data: envelope,
      },
    },
  });
  // Temporary visibility log so we can see successful posts during alpha
  // bring-up. Drop or downgrade to log.debug once we have dashboards
  // showing the same data.
  log.info(
    `[Analytics] posted ${envelope.event_name} surface=${envelope.surface} session=${envelope.session_id.slice(0, 8)}`,
    envelope.metadata,
  );
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/**
 * Register IPC handlers used by renderer processes to bootstrap their
 * telemetry context and stay in sync with auth state. Call once at app
 * boot, before any renderer mounts.
 */
export function registerAnalyticsIpc(): void {
  ipcMain.handle('telemetry:getContext', () => {
    if (!context) return null;
    return {
      ...context,
      session_id: SESSION_ID,
      authenticated,
    };
  });

  ipcMain.handle('telemetry:subscribe-auth-state', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !authStateSubscribers.includes(win)) {
      authStateSubscribers.push(win);
      win.on('closed', () => {
        const idx = authStateSubscribers.indexOf(win);
        if (idx !== -1) authStateSubscribers.splice(idx, 1);
      });
    }
    return { authenticated };
  });

  // Renderer-emitted events are POSTed via this bridge. Renderer never
  // talks to the backend directly — main owns the API client and cookies.
  ipcMain.handle(
    'telemetry:track',
    async (
      _event,
      payload: { event_name: string; metadata: Record<string, unknown>; surface?: CoScientistSurface },
    ) => {
      if (!authenticated) return { ok: false, reason: 'unauthenticated' };
      if (!context) return { ok: false, reason: 'uninitialized' };

      const surface = payload.surface ?? context.surface;
      const envelope: CoScientistEventEnvelope = {
        v: ANALYTICS_SCHEMA_VERSION,
        event_name: payload.event_name as CoScientistEvent['name'],
        installation_id: context.installation_id,
        session_id: SESSION_ID,
        release: context.release,
        channel: context.channel,
        surface,
        platform: context.platform,
        arch: context.arch,
        os_version: context.os_version,
        electron_version: context.electron_version,
        chromium_version: context.chromium_version,
        node_version: context.node_version,
        metadata: payload.metadata,
      };

      try {
        await postEvent(envelope);
        return { ok: true };
      } catch (err: any) {
        log.warn(`[Analytics] POST failed for ${payload.event_name}:`, err?.message ?? err);
        return { ok: false, reason: 'post-failed' };
      }
    },
  );
}
