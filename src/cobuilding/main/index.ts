import { app, BrowserWindow, dialog, globalShortcut, ipcMain, net, protocol, shell, systemPreferences } from 'electron';
import { WorkspaceController } from './controllers/WorkspaceController';
import { registerWorkspaceHandlers } from './ipc/workspaceIpc';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { registerFileHandlers, assertWithinAllowedDirs } from './fileHandlers';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { createAgentSession } from './agentSession';
import { createCalendarAgentSession } from './calendarAgentSession';
import type { CalendarMutationEvent } from './calendarAgentSession';
import { registerSession, unregisterSession, getRegisteredSession, hasSession, destroyAllSessions, addSubscriber, removeSubscriber } from './sessionRegistry';
import type { IPCAttachment } from '../shared/types';
import { provisionWorkspace } from './skills';
import { containerService, skipImageBuild } from './containerService';
import { processCpuMonitor } from '../../utils/processCpuMonitor';
import { getAllPodmanDataPaths } from './podmanBinaries';
import { ensureClaudeBinaryReady } from './sdkBinarySetup';
import { scanWorkspaceDirectory } from './directoryScanner';
import { fetchPapers, type FetchPapersInput } from './papers/papersService';
import { persistPapersAsBriefings } from './papers/paperBriefings';
import { getReport, getLatestReport, updateReportData } from './db/reportRepository';
import {
  listBriefings,
  setBriefingStatus,
  type BriefingStatus,
} from './db/briefingsRepository';
import { getScannedFilesByType, getScannedFiles, updateFileTag, removeFileTag } from './db/scannedFilesRepository';
import { kernelGatewayService } from './kernelGatewayService';
import { initDatabase, getDatabase, closeDatabase } from './db/database';
import { initObservationsDatabase, getObservationsDatabase, closeObservationsDatabase } from './db/observationsDatabase';
import {
  listSessions,
  listSessionsByDocPathLike,
  setSessionDocumentPath,
  getSession,
  createSession,
  updateSessionTitle,
  deleteSession,
  getMessages,
  findSessionForApp,
  findMessageByMessageId,
} from './db/chatRepository';
import {
  getActiveWorkspace,
  listWorkspaceDirectories,
  type Workspace,
} from './db/workspaceRepository';
import { setupUpdater, setupUpdaterIpcHandlers } from './updater';
import { createTray, createDockIcon, rebuildTrayMenu, setShowWindowCallback } from './tray';
import { startBrowserMonitor, stopBrowserMonitor } from './browserMonitor';
import { getAllSessions } from './browserMonitor/repository';
import { initFileMonitor, startFileMonitor, stopFileMonitor, isFileMonitorRunning } from './fileMonitor';
import { getAllFileSessions, getTodayFileSessions } from './fileMonitor/repository';
import { initActivityQuery } from './activityQuery';
import { initSessionFiles, getAllSessionFiles } from './db/sessionFilesRepository';
import { initSchedulingDatabase, getSchedulingDatabase, closeSchedulingDatabase } from './db/schedulingDatabase';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  setTaskEnabled,
  listTaskRuns,
  getTaskBySessionSource,
} from './db/scheduledTaskRepository';
import { startScheduledTasks, stopScheduledTasks, getTaskScheduler } from './scheduledTasks';
import { runScheduledTask } from './scheduledTasks/runner';
import type { CreateTaskData, UpdateTaskData, NotificationNavigationAction } from '../shared/types';
import { migrateWorkspaceFiles } from './migrateWorkspaceFiles';
import { BackgroundBuilder } from './backgroundBuilder';
import { discoverApps, getEnvironmentInfo, getInstallSteps, installDepsInContainer } from './environmentGenerator';
import { packageInstaller, installStepsToRequests, type Registry, type PackageState } from './packageInstaller';
import { checkLogin, getCurrentUser, logout, setBaseUrl, BASE_URL, hasSessionCookie } from '../../apiClient';
import { getDeviceId } from '../../utils/deviceId';
import { createCobuildingAuthSession, verifyCobuildingAuthCode } from './cobuildingAuthService';
import { fetchGatewayCredentials, destroyTokenManager, getCredentials, setCredentials } from './cobuildingTokenManager';
import { createQuickChatWindow, showQuickChat, updateMainWindowRef } from './quickChat';
import { registerCalendarHandlers } from './ipc/calendar';
import { registerDebugHandlers } from './ipc/debug';
import { registerReactionsHandlers, getReactionsEnabled, ensureReactionsTask } from './ipc/reactions';
import { AcademiaHttpServer } from '../../server/httpServer';
import { setHttpProxyPort, stopHttpsServer, registerOfficeAddinIpcHandlers } from './officeAddin';
import {
  isConnected as isGoogleDocsConnected,
  disconnect as disconnectGoogleDocs,
  startOAuthFlow as startGoogleDocsOAuth,
  hasCredentials as googleDocsHasCredentials,
} from './googleDocsService';
import { windowMonitorService } from '../../windowMonitorService';
import { wordAccessibility } from '../../native/wordAccessibility';
import { FEATURES, IPC_CHANNELS, NavigateToPagePayload } from '../../shared/types';
import { validateExternalUrl } from '../../utils/urlValidation';
import { ACADEMIA_DIR, AGENT_MEMORY_SUBDIR } from '../shared/paths';
const isSmokeTest = process.argv.includes('--smoke-test');

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let cobuildingHttpBaseUrl: string | null = null;
let cobuildingHttpAuthToken: string | null = null;

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

const DEFAULT_MAX_ATTACHMENT_SIZE_MB = 30;

function getMaxAttachmentSizeMB(): number {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return typeof data.maxAttachmentSizeMB === 'number' ? data.maxAttachmentSizeMB : DEFAULT_MAX_ATTACHMENT_SIZE_MB;
  } catch {
    return DEFAULT_MAX_ATTACHMENT_SIZE_MB;
  }
}

function setMaxAttachmentSizeMB(sizeMB: number): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.maxAttachmentSizeMB = sizeMB;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

export type ApiProvider = 'cloudflare' | 'anthropic' | 'custom';

function getApiProvider(): ApiProvider {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    if (data.apiProvider === 'cloudflare' || data.apiProvider === 'anthropic' || data.apiProvider === 'custom') return data.apiProvider;
    return 'cloudflare';
  } catch {
    return 'cloudflare';
  }
}

function setApiProvider(provider: ApiProvider): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.apiProvider = provider;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function getCustomAnthropicKey(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.customAnthropicApiKey ?? null;
  } catch {
    return null;
  }
}

function setCustomAnthropicKey(key: string, baseURL?: string): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.customAnthropicApiKey = key;
  data.customAnthropicBaseURL = baseURL || null;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function getCustomAnthropicBaseURL(): string | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.customAnthropicBaseURL || undefined;
  } catch {
    return undefined;
  }
}

// Configure electron-log for cobuilding — write to userData so dev/prod logs are separated
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'cobuilding.log');
log.transports.file.level = 'debug';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v' + app.getVersion() + '] [{level}] {text}';
log.transports.console.level = app.isPackaged ? false : 'debug';

import { systemLogger } from './systemLogger';
systemLogger.init();

process.on('uncaughtException', (error) => {
  log.error('[FATAL] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('[FATAL] Unhandled rejection:', reason);
});

app.setName('Academia Coscientist');
app.setPath('userData', path.join(app.getPath('appData'), 'academia-electron', app.isPackaged ? 'production' : 'development'));

// Register deep link protocol — must happen before app is ready
app.setAsDefaultProtocolClient('cobuilding-agent');

let pendingDeepLinkUrl: string | null = null;

function handleDeepLinkUrl(url: string) {
  try {
    const parsed = new URL(url);
    const verificationCode = parsed.searchParams.get('verification_code');
    const deviceId = parsed.searchParams.get('device_id');
    if (!verificationCode || !/^\d{6}$/.test(verificationCode)) {
      log.warn('[Deep Link] Received URL with missing or invalid verification_code:', url);
      return;
    }
    if (!deviceId) {
      log.warn('[Deep Link] Received URL with missing device_id:', url);
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('auth:deepLinkCallback', { verificationCode, deviceId });
    } else {
      pendingDeepLinkUrl = url;
    }
  } catch (err) {
    log.error('[Deep Link] Failed to parse URL:', err);
  }
}

// macOS: deep link when app is already running
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('cobuilding-agent://')) {
    handleDeepLinkUrl(url);
  }
});

let mainWindow: BrowserWindow | null = null;

function sendProgressTo(channel: string) {
  return (stage: string, message: string, percent?: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, { stage, message, percent });
    }
  };
}

function makeBackgroundProgress() {
  const toProgress = sendProgressTo('container:progress');
  const toBackgroundBuild = sendProgressTo('container:backgroundBuild');
  return (stage: string, message: string, percent?: number) => {
    toProgress(stage, message, percent);
    const bgStage =
      stage === 'ready' ? 'background-build-done'
        : stage === 'error' ? 'background-build-error'
        : stage;
    toBackgroundBuild(bgStage, message, percent);
  };
}

// Setup events (pull, install-podman, setup-done) drive both the SetupBanner
// and PodmanDebug's Base Image spinner.
function makeSetupProgress() {
  const toSetup = sendProgressTo('setup:progress');
  const toProgress = sendProgressTo('container:progress');
  return (stage: string, message: string, percent?: number) => {
    toSetup(stage, message, percent);
    toProgress(stage, message, percent);
  };
}

function handleNotificationNavigation(action: NotificationNavigationAction | null): void {
  log.info('[NotificationNav] handleNotificationNavigation called with action:', JSON.stringify(action));
  if (!mainWindow || mainWindow.isDestroyed()) {
    log.info('[NotificationNav] mainWindow is null or destroyed — recreating window');
    createMainWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    if (action) {
      log.info('[NotificationNav] Sending notification:navigate IPC to renderer:', JSON.stringify(action));
      mainWindow.webContents.send('notification:navigate', action);
    }
  }
}
const workspaceController = new WorkspaceController();

let activeApiBaseUrl: string = (() => {
  if (app.isPackaged) return BASE_URL;
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    if (data.apiEndpoint === 'production') {
      const url = 'https://api.academia.edu/';
      setBaseUrl(url);
      return url;
    }
  } catch { }
  return BASE_URL;
})();

async function refreshCredentialsForSession(): Promise<{ apiKey: string; baseURL?: string }> {
  const result = await fetchGatewayCredentials(getApiProvider() === 'cloudflare');
  return { apiKey: result.apiKey, baseURL: result.baseURL };
}

// Shared edit state store — keyed by toolCallId, synced between overlay and desktop
const editStates = new Map<string, string>();

// Tracks IPC forwarding listeners per (threadId, webContentsId) to avoid duplicates.
// Both chat:subscribe and chat:send use this to ensure exactly one forwarding listener
// per session per renderer.
const forwardingListeners = new Map<string, () => void>();

// ─── Cross-surface chat-event fanout (desktop ↔ overlay) ──────────────
//
// DEPRECATED: The overlay now uses a unified WebSocket for chat events
// (see websocket.ts + overlayHandlers.ts). The SSE fanout below is kept
// as a fallback during migration and will be removed in a future release.
//
// The desktop chat panel receives streaming events via Electron IPC
// (`webContents.send('chat:event', …)`). The Word overlay is a WKWebView
// served over the local HTTP server — it has no `webContents`, so the IPC
// path can't reach it. Without a separate channel, a turn started in the
// desktop never streams to an overlay viewing the same conversation; the
// overlay only hears about it on the next manual refresh.
//
// `sseSessionSubscribers` holds the open SSE response streams listening
// on `GET /api/cobuilding/sessions/:id/events`. `sseFanoutListeners`
// tracks the single agent-session listener attached per session that
// fans events out to every subscriber. Once attached, the fanout listener
// stays for the lifetime of the agent session — fans out for both
// desktop-initiated and overlay-initiated turns.
const sseSessionSubscribers = new Map<string, Set<NodeJS.WritableStream>>();
const sseFanoutListeners = new Map<string, () => void>();
let sseSubscriberSeq = 0;

function broadcastSseToSubscribers(sessionId: string, event: string, data: unknown): void {
  const subs = sseSessionSubscribers.get(sessionId);
  if (!subs || subs.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const stream of subs) {
    try { stream.write(payload); } catch { /* dead connection — request.raw 'close' will reap it */ }
  }
}

/**
 * Attach exactly one fanout listener to the agent session for `sessionId`,
 * which forwards events to every active SSE subscriber for that session.
 * Idempotent — safe to call from every chat-send entry point.
 */
function ensureSseFanout(sessionId: string): void {
  if (sseFanoutListeners.has(sessionId)) return;
  const session = getRegisteredSession(sessionId);
  if (!session) return;
  const unsubscribe = session.addListener({
    onEvent: (msg) => {
      if (msg.type !== 'heartbeat') {
        log.debug(`[SseFanout] event sessionId=${sessionId} type=${msg.type}`);
      }
      broadcastSseToSubscribers(sessionId, 'event', msg);
      // Also nudge the desktop renderer when a user-message lands from
      // another surface. agentSession emits 'user-message' immediately
      // after inserting a foreign-typed user turn into the DB; firing
      // chat:foreign-done now (rather than waiting for onDone) makes
      // the user turn visible on the desktop before the assistant
      // streams its reply, which is exactly the gap that was missing
      // user "ok" turns from the desktop view in screenshots.
      if (msg.type === 'user-message' && mainWindow && !mainWindow.isDestroyed()) {
        log.info(`[SseFanout] firing chat:foreign-done sessionId=${sessionId} cause=user-message`);
        mainWindow.webContents.send('chat:foreign-done', sessionId);
      }
    },
    onDone: () => {
      broadcastSseToSubscribers(sessionId, 'done', {});
      // Also signal the desktop renderer (which can't subscribe to SSE —
      // it has its own IPC chain) that a turn finished for this session,
      // so it can refetch history if its active thread matches. Without
      // this, an overlay-typed user message stays missing on the desktop
      // even though the assistant's streamed reply already arrived via
      // `ensureForwarding`'s chat:event path.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chat:foreign-done', sessionId);
      }
    },
    onError: (err) => broadcastSseToSubscribers(sessionId, 'error', { error: err }),
  });
  sseFanoutListeners.set(sessionId, unsubscribe);
}

function ensureForwarding(threadId: string, sender: Electron.WebContents): void {
  const key = `${threadId}:${sender.id}`;
  // Always register the renderer's interest in this thread, even before a
  // session exists. The registry tracks pre-session subscribers so a session
  // created later inherits the right count, and visibility-based cleanup
  // doesn't fire on a session that has subscribers waiting in the wings.
  const subscriberKey = `ipc:${sender.id}`;
  addSubscriber(threadId, subscriberKey);

  if (forwardingListeners.has(key)) return;

  const session = getRegisteredSession(threadId);
  if (!session) {
    log.debug(`[Forwarding] No session found for ${threadId}, skipping listener attach (subscriber recorded)`);
    return;
  }

  log.debug(`[Forwarding] Setting up IPC forwarding for ${threadId}`);

  const unsubscribe = session.addListener({
    onEvent: async (msg) => {
      if (sender.isDestroyed()) {
        log.debug(`[Forwarding] Dropping event for ${threadId}: sender destroyed`);
        cleanup();
        return;
      }
      if (msg.type === 'turn-complete') {
        log.info(`[Forwarding] Sending ${msg.type} event for ${threadId}`);
        if (containerService.isOverlayEnabled() && containerService.isRunning()) {
          try {
            await Promise.race([
              containerService.syncOverlay(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
            ]);
          } catch (err) {
            log.warn(`[Forwarding] Post-turn overlay sync failed: ${(err as Error).message}`);
          }
        }
      }
      sender.send('chat:event', threadId, msg);
    },
    onDone: () => {
      log.info(`[Forwarding] chat:done for ${threadId}`);
      // Send chat:done but do NOT cleanup — forwarding persists across conversation
      // turns so it doesn't need to be re-established on each message. Cleanup only
      // happens on error or sender destruction.
      if (!sender.isDestroyed()) {
        sender.send('chat:done', threadId);
      } else {
        cleanup();
      }
    },
    onError: (err) => {
      log.debug(`[Forwarding] Session error for ${threadId}: ${err}`);
      if (!sender.isDestroyed()) sender.send('chat:error', threadId, err);
      cleanup();
    },
  });

  const cleanup = () => {
    log.debug(`[Forwarding] Cleaning up forwarding for ${threadId}`);
    unsubscribe();
    forwardingListeners.delete(key);
    sender.removeListener('destroyed', cleanup);
    removeSubscriber(threadId, subscriberKey);
  };

  forwardingListeners.set(key, cleanup);
  sender.on('destroyed', cleanup);
}

/**
 * Explicit cleanup path the renderer fires when it navigates away from a
 * thread (component unmount, thread change, idle timeout in
 * useSessionSubscription). Removing the forwarding listener drops the
 * subscriber count for the (threadId, sender) pair; once the last surface
 * detaches, the registry's visibility policy decides whether to destroy the
 * agent session now or after the current turn finishes.
 */
function removeForwarding(threadId: string, senderId: number): void {
  const key = `${threadId}:${senderId}`;
  const cleanup = forwardingListeners.get(key);
  if (cleanup) {
    cleanup();
    return;
  }
  // No forwarding listener was ever installed (e.g. renderer subscribed
  // before the session existed). Still record the detach so the registry's
  // pre-session subscriber count drops.
  removeSubscriber(threadId, `ipc:${senderId}`);
}

function createMainWindow(): void {
  log.info('[APP] Creating main window...');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Academia Co-scientist',
    show: false,
    webPreferences: {
      preload: COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  log.info('[APP] Main window created.');

  updateMainWindowRef(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const url = COBUILDING_WINDOW_WEBPACK_ENTRY;
  log.info('[APP] Loading URL:', url);
  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    log.info('[APP] Window ready-to-show, calling show().');
    mainWindow?.show();
  });

  // Dispatch any deep link URL that arrived before the window was ready
  if (pendingDeepLinkUrl && mainWindow && !mainWindow.isDestroyed()) {
    const urlToDispatch = pendingDeepLinkUrl;
    pendingDeepLinkUrl = null;
    mainWindow.webContents.once('did-finish-load', () => {
      handleDeepLinkUrl(urlToDispatch);
    });
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error('[APP] Window failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log.info('[APP] Window did-finish-load.');
  });
}

app.whenReady().then(async () => {
  processCpuMonitor.start();

  if (process.platform === 'darwin') {
    systemPreferences.setUserDefault('NSNavPanelExpandedStateForSaveMode2', 'boolean', true as any);
  }

  await ensureClaudeBinaryReady();

  protocol.handle('local-file', async (request) => {
    const filePath = decodeURIComponent(request.url.slice('local-file://'.length));
    const resolved = workspaceController.isPathAllowed(filePath);
    if (!resolved) {
      log.warn(`[local-file] Forbidden: "${filePath}" outside workspace`);
      return new Response('Forbidden', { status: 403 });
    }
    const fileUrl = pathToFileURL(resolved).href;
    try {
      const response = await net.fetch(fileUrl);
      if (!response.ok) {
        log.warn(`[local-file] Fetch failed (${response.status}): ${fileUrl}`);
      }
      return response;
    } catch (err) {
      log.error(`[local-file] Error fetching "${fileUrl}":`, err);
      return new Response('Not Found', { status: 404 });
    }
  });

  initDatabase(app.getPath('userData'));
  initObservationsDatabase(app.getPath('userData'));
  commandLogger.init();
  log.info('[APP] App ready. Version:', app.getVersion(), 'Packaged:', app.isPackaged);
  log.info('[APP] userData path:', app.getPath('userData'));

  try {
    log.info('[APP] Initializing database...');
    initDatabase(app.getPath('userData'));
    initObservationsDatabase(app.getPath('userData'));
    log.info('[APP] Database initialized.');

    log.info('[APP] Loading active workspace...');
    const activeWorkspace = workspaceController.loadActiveWorkspace();
    log.info('[APP] Active workspace:', activeWorkspace ? activeWorkspace.name : 'none');

    if (activeWorkspace) {
      migrateWorkspaceFiles(workspaceController.workspacePath);
      provisionWorkspace(workspaceController.workspacePath);
      containerService.writeStartContainerScript(workspaceController.mountMap);
    }

    createMainWindow();

    registerFileHandlers(() => workspaceController.allAllowedPaths, () => mainWindow);
    initFileMonitor(() => workspaceController.workspacePath);
    initActivityQuery(() => workspaceController.workspacePath);
    initSessionFiles(() => workspaceController.workspacePath);
    registerCalendarHandlers(() => mainWindow);
    registerDebugHandlers();
    registerWorkspaceHandlers(workspaceController, () => mainWindow);
    registerReactionsHandlers(() => workspaceController.activeWorkspace, rebuildTrayMenu);
    setupUpdaterIpcHandlers();
    setupUpdater(rebuildTrayMenu);
    createTray();
    setShowWindowCallback(() => {
      if (!mainWindow) {
        createMainWindow();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    const dock = process.platform === 'darwin' ? app.dock : null;
    if (dock) {
      const dockIcon = createDockIcon();
      if (dockIcon) dock.setIcon(dockIcon);
    }
    log.info('[APP] Updater and tray initialized.');

    createQuickChatWindow(mainWindow!);
    const shortcutRegistered = globalShortcut.register('Alt+Shift+Space', () => {
      showQuickChat();
    });
    if (!shortcutRegistered) {
      log.warn('[APP] Failed to register global shortcut Option+Shift+Space — may be in use by another app');
    } else {
      log.info('[APP] Global shortcut Option+Shift+Space registered');
    }

    initSchedulingDatabase(app.getPath('userData'));
    if (getReactionsEnabled()) {
      startBrowserMonitor().then(() => rebuildTrayMenu());
      if (activeWorkspace) {
        ensureReactionsTask(activeWorkspace.id);
        const rTask = getTaskBySessionSource(activeWorkspace.id, 'reactions-system');
        if (rTask && !rTask.enabled) setTaskEnabled(rTask.id, true);
      }
    }
    startScheduledTasks(handleNotificationNavigation);

    // Start HTTP server and window monitor for the Word overlay
    if (FEATURES.MS_WORD_INTEGRATION_ENABLED && FEATURES.MS_WORD_V2_ENABLED) {
      (async () => {
        try {
          const httpServer = new AcademiaHttpServer(null, () => null);

          // Navigation handler — show main window and send navigation event to renderer
          httpServer.setNavigationHandler(async (payload) => {
            if (payload.page === 'external' && payload.url) {
              await shell.openExternal(payload.url);
              return;
            }
            if (!mainWindow || mainWindow.isDestroyed()) {
              createMainWindow();
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
              mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_PAGE, {
                page: payload.page,
                projectId: payload.projectId,
                conversationId: payload.conversationId,
                sessionId: payload.sessionId,
              } as NavigateToPagePayload);
            }
          });

          // Register cobuilding session routes for the Word overlay
          httpServer.addRouteRegistrar(async (fastify) => {
            // GET /api/cobuilding/sessions/:sessionId/messages
            fastify.get<{ Params: { sessionId: string } }>(
              '/api/cobuilding/sessions/:sessionId/messages',
              async (request, reply) => {
                const { sessionId } = request.params;
                const msgs = getMessages(sessionId);
                const parsed = msgs.map(m => {
                  let content: unknown;
                  try { content = JSON.parse(m.content); } catch { content = m.content; }
                  return { id: m.id, type: m.type, content, created_at: m.created_at };
                });
                reply.send({ messages: parsed });
              },
            );

            // GET /api/cobuilding/sessions/:sessionId/events
            //
            // Long-lived SSE stream of agent events for `sessionId`. Closes
            // the asymmetry where desktop-initiated turns wouldn't reach an
            // overlay viewing the same conversation: the overlay opens this
            // endpoint when the conversation is opened, and the per-session
            // fanout listener (attached on first chat-send via
            // `ensureSseFanout`) writes every event/done/error frame to
            // every active subscriber. The overlay treats `done` as a
            // signal to refetch /messages and re-render — minimal coupling
            // to the assistant-ui runtime, smallest possible diff to the
            // desktop renderer (zero — it stays on its existing IPC path).
            fastify.get<{ Params: { sessionId: string } }>(
              '/api/cobuilding/sessions/:sessionId/events',
              async (request, reply) => {
                const { sessionId } = request.params;
                reply.raw.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  Connection: 'keep-alive',
                });

                let subs = sseSessionSubscribers.get(sessionId);
                if (!subs) {
                  subs = new Set();
                  sseSessionSubscribers.set(sessionId, subs);
                }
                subs.add(reply.raw);

                // Each open SSE stream is one visibility-tracked subscriber.
                // Unique per connection so concurrent overlay windows on the
                // same session each hold the count up independently.
                const subscriberKey = `sse:${++sseSubscriberSeq}`;
                addSubscriber(sessionId, subscriberKey);

                // If the session already exists (the common case — the user
                // is opening an active conversation), attach the fanout
                // listener now. Otherwise it'll be attached the first time
                // chat:send / POST /send runs for this sessionId.
                ensureSseFanout(sessionId);

                // Initial heartbeat so the EventSource's `open` fires.
                reply.raw.write('event: connected\ndata: {}\n\n');

                request.raw.on('close', () => {
                  const set = sseSessionSubscribers.get(sessionId);
                  if (set) {
                    set.delete(reply.raw);
                    if (set.size === 0) sseSessionSubscribers.delete(sessionId);
                  }
                  removeSubscriber(sessionId, subscriberKey);
                });
              },
            );

            // POST /api/cobuilding/apply-edit — execute a user-approved edit.
            // Dispatches to the HostApp that owns the document (resolved by
            // file extension on `document_path`). Falls back to Word for
            // legacy callers that don't include `document_path`.
            fastify.post<{ Body: { toolCallId: string; document_path?: string; search_text: string; replacement_text: string; replace_scope?: string; match_case?: boolean } }>(
              '/api/cobuilding/apply-edit',
              async (request, reply) => {
                try {
                  const { findHostAppForDocument } = await import('./hostApps');
                  const { wordHostApp } = await import('./hostApps/wordHostApp');
                  const { toolCallId, document_path, search_text, replacement_text, replace_scope, match_case } = request.body;
                  const host = findHostAppForDocument(document_path) ?? wordHostApp;
                  host.onApplyEditWillRun?.();
                  let result;
                  try {
                    result = await host.applyEdit({
                      toolCallId,
                      document_path,
                      search_text,
                      replacement_text,
                      replace_scope: (replace_scope as 'first' | 'all') || 'first',
                      match_case: match_case ?? true,
                    });
                  } finally {
                    host.onApplyEditDidRun?.();
                  }
                  if (toolCallId) {
                    if (result.success) editStates.set(toolCallId, 'applied');
                    else editStates.delete(toolCallId);
                  }
                  reply.send(result);
                } catch (err) {
                  reply.code(500).send({ success: false, error: String(err) });
                }
              },
            );

            // POST /api/cobuilding/edit-state — set edit state (for deny)
            fastify.post<{ Body: { toolCallId: string; state: string } }>(
              '/api/cobuilding/edit-state',
              async (request, reply) => {
                const { toolCallId, state } = request.body;
                if (toolCallId && state) editStates.set(toolCallId, state);
                reply.send({ ok: true });
              },
            );

            // GET /api/cobuilding/edit-states — get all edit states
            fastify.get('/api/cobuilding/edit-states', async (_request, reply) => {
              reply.send(Object.fromEntries(editStates));
            });

            // Per-session pending context for messagePreprocessor injection.
            // Context is set before each sendMessage and consumed by the preprocessor,
            // so the DB stores only the user's raw text while Claude gets the context.
            const pendingContext = new Map<string, { documentPath?: string; selectedText?: string }>();

            // POST /api/cobuilding/sessions/:sessionId/send — streams response via SSE
            fastify.post<{ Params: { sessionId: string }; Body: { text: string; documentPath?: string; selectedText?: string; attachments?: IPCAttachment[] } }>(
              '/api/cobuilding/sessions/:sessionId/send',
              async (request, reply) => {
                const { sessionId } = request.params;
                const { text, documentPath: ctxDocPath, selectedText: ctxSelectedText, attachments } = request.body;
                if (!text || typeof text !== 'string') {
                  reply.code(400).send({ error: 'text is required' });
                  return;
                }
                const activeWorkspace = workspaceController.activeWorkspace;
                if (!activeWorkspace) {
                  reply.code(400).send({ error: 'No active workspace' });
                  return;
                }

                // Build the display message: selection quote + user instruction
                // This is what gets stored in the DB and shown in both overlay and desktop app.
                const displayMessage = ctxSelectedText
                  ? `"${ctxSelectedText}"\n\n${text}`
                  : text;

                // Store context for the messagePreprocessor to pick up
                // (adds document path and selection context for Claude without it appearing in the stored message)
                if (ctxDocPath || ctxSelectedText) {
                  pendingContext.set(sessionId, { documentPath: ctxDocPath, selectedText: ctxSelectedText });
                }

                // Hijack the response so Fastify doesn't try to send its own
                reply.hijack();
                reply.raw.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'X-Accel-Buffering': 'no',
                });

                const sendSSE = (event: string, data: unknown) => {
                  if (!reply.raw.destroyed) {
                    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                  }
                };

                const existingRunning = getRegisteredSession(sessionId);
                if (existingRunning?.isRunning) {
                  // Ensure IPC forwarding to the desktop app BEFORE sending the message,
                  // so the desktop receives streaming events immediately.
                  // Note: we deliberately do NOT fire NAVIGATE_TO_PAGE here.
                  // Auto-yanking the desktop into the chat tab on every
                  // overlay-typed message was disruptive — the desktop's
                  // SessionsListRefresher already surfaces new/updated
                  // sessions, and the live-message replication via
                  // `chat:foreign-done` keeps history in sync once the
                  // user navigates there themselves.
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    ensureForwarding(sessionId, mainWindow.webContents);
                  }
                  ensureSseFanout(sessionId);
                  const unsubscribe = existingRunning.addListener({
                    onEvent: (msg) => sendSSE('event', msg),
                    onDone: () => { sendSSE('done', {}); reply.raw.end(); unsubscribe(); notifySessionsChanged(); },
                    onError: (err) => { sendSSE('error', { error: err }); reply.raw.end(); unsubscribe(); },
                  });
                  existingRunning.sendMessage(displayMessage, attachments);
                  return;
                }

                const isNewSession = !hasSession(sessionId) && !getSession(sessionId);
                if (!hasSession(sessionId)) {
                  const existingDbSession = getSession(sessionId);
                  const session = createAgentSession(
                    sessionId,
                    {
                      onEvent: () => { },
                      onDone: () => { },
                      onError: () => { unregisterSession(sessionId); },
                    },
                    activeWorkspace,
                    existingDbSession?.sdk_session_id ?? undefined,
                    undefined,
                    undefined,
                    undefined,
                    // messagePreprocessor: inject document/selection context for Claude
                    // without storing it in the DB message. The host app resolved from
                    // documentPath chooses how to phrase the prefix (Word vs Obsidian).
                    (userText: string) => {
                      const ctx = pendingContext.get(sessionId);
                      pendingContext.delete(sessionId);
                      if (!ctx) return userText;
                      const { resolveSessionHostApp } = require('./agentSession');
                      const host = resolveSessionHostApp(ctx.documentPath);
                      const prefix = host.messagePrefix({
                        documentPath: ctx.documentPath,
                        selectedText: ctx.selectedText,
                      });
                      return prefix ? `${prefix}\n${userText}` : userText;
                    },
                    ctxDocPath,
                  );
                  registerSession(sessionId, session);
                }

                if (isNewSession) notifySessionsChanged();
                if (isNewSession) {
                  generateSessionTitle(sessionId, text);
                }

                const session = getRegisteredSession(sessionId)!;

                // Ensure IPC forwarding to the desktop app BEFORE sending the message,
                // so the desktop receives streaming events immediately.
                // Note: NAVIGATE_TO_PAGE is intentionally NOT fired here
                // (see matching note in the existingRunning branch).
                if (mainWindow && !mainWindow.isDestroyed()) {
                  ensureForwarding(sessionId, mainWindow.webContents);
                }
                ensureSseFanout(sessionId);

                const unsubscribe = session.addListener({
                  onEvent: (msg) => sendSSE('event', msg),
                  onDone: () => {
                    sendSSE('done', {});
                    reply.raw.end();
                    unsubscribe();
                    notifySessionsChanged();
                  },
                  onError: (err) => {
                    sendSSE('error', { error: err });
                    reply.raw.end();
                    unsubscribe();
                  },
                });

                request.raw.on('close', () => {
                  unsubscribe();
                });

                session.sendMessage(displayMessage, attachments);
              },
            );

            // Register overlay chat-send handler for the unified WebSocket
            const { setOverlayChatSendHandler, setOverlayBridgeHandler } = require('./overlayHandlers');
          setOverlayChatSendHandler((params: { sessionId: string; text: string; documentPath?: string; selectedText?: string; onEvent: (msg: any) => void; onDone: () => void; onError: (err: string) => void; onCleanup?: () => void }) => {
            const { sessionId, text, documentPath: ctxDocPath, selectedText: ctxSelectedText, onEvent, onDone, onError } = params;
            const activeWorkspace = workspaceController.activeWorkspace;
            if (!activeWorkspace) {
              onError('No active workspace');
              return;
            }
            const displayMessage = ctxSelectedText ? `"${ctxSelectedText}"\n\n${text}` : text;
            if (ctxDocPath || ctxSelectedText) {
              pendingContext.set(sessionId, { documentPath: ctxDocPath, selectedText: ctxSelectedText });
            }

            const existingRunning = getRegisteredSession(sessionId);
            if (existingRunning?.isRunning) {
              if (mainWindow && !mainWindow.isDestroyed()) {
                ensureForwarding(sessionId, mainWindow.webContents);
              }
              ensureSseFanout(sessionId);
              const unsubscribe = existingRunning.addListener({
                onEvent: (msg: any) => onEvent(msg),
                onDone: () => { onDone(); unsubscribe(); notifySessionsChanged(); },
                onError: (err: any) => { onError(String(err)); unsubscribe(); },
              });
              existingRunning.sendMessage(displayMessage);
              return;
            }

            const isNewSession = !hasSession(sessionId) && !getSession(sessionId);
            if (!hasSession(sessionId)) {
              const existingDbSession = getSession(sessionId);
              const session = createAgentSession(
                sessionId,
                { onEvent: () => { }, onDone: () => { }, onError: () => { unregisterSession(sessionId); } },
                activeWorkspace,
                existingDbSession?.sdk_session_id ?? undefined,
                undefined, undefined, undefined,
                (userText: string) => {
                  const ctx = pendingContext.get(sessionId);
                  pendingContext.delete(sessionId);
                  if (!ctx) return userText;
                  const { resolveSessionHostApp } = require('./agentSession');
                  const host = resolveSessionHostApp(ctx.documentPath);
                  const prefix = host.messagePrefix({ documentPath: ctx.documentPath, selectedText: ctx.selectedText });
                  return prefix ? `${prefix}\n${userText}` : userText;
                },
                ctxDocPath,
              );
              registerSession(sessionId, session);
            }
            if (isNewSession) notifySessionsChanged();
            if (isNewSession) {
              generateSessionTitle(sessionId, text);
            }

            const session = getRegisteredSession(sessionId)!;
            if (mainWindow && !mainWindow.isDestroyed()) {
              ensureForwarding(sessionId, mainWindow.webContents);
            }
            ensureSseFanout(sessionId);

            const unsubscribe = session.addListener({
              onEvent: (msg: any) => onEvent(msg),
              onDone: () => { onDone(); unsubscribe(); notifySessionsChanged(); },
              onError: (err: any) => { onError(String(err)); unsubscribe(); },
            });
            if (params.onCleanup) {
              // Allow caller to register a cleanup callback (e.g., on WebSocket close)
              const origCleanup = params.onCleanup;
              params.onCleanup = () => { unsubscribe(); origCleanup(); };
            }

            session.sendMessage(displayMessage);
          });

          setOverlayBridgeHandler(async (params: { action: string; payload: Record<string, unknown>; wid: string | null }) => {
            const { windowMonitorService } = require('../../windowMonitorService');
            const { action, payload, wid } = params;
            if (action === 'buttonClicked' && wid) {
              windowMonitorService.togglePopupForWindow(wid);
            } else if (action === 'closeWindow' && wid) {
              windowMonitorService.closePopupForWindow(wid, payload.clearReviewState !== false);
            } else if (action === 'setPopupSize' && wid) {
              const { width, height } = payload;
              if (typeof width === 'number' && typeof height === 'number') {
                windowMonitorService.setPopupSize(wid, width, height);
              }
            } else if (action === 'setDockRight' && wid) {
              windowMonitorService.setDockRight(wid, payload.docked === true);
            } else if (action === 'setDragOffset' && wid) {
              const { dx, dy } = payload;
              if (typeof dx === 'number' && typeof dy === 'number') {
                windowMonitorService.setButtonDragOffset(wid, dx, dy);
              }
            } else if (action === 'openPopup' && wid) {
              windowMonitorService.openPopupForWindow(wid);
            } else if (action === 'clearKickoff') {
              const kickoffId = typeof payload.kickoffId === 'string' ? payload.kickoffId : '';
              if (kickoffId) windowMonitorService.clearPendingKickoff(kickoffId);
            } else if (action === 'clearNavigateSession') {
              const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
              if (nonce) windowMonitorService.clearPendingNavigateSession(nonce);
            }
            return { success: true };
          });
          });

          const port = await httpServer.start();
          const baseUrl = httpServer.getBaseUrl();
          const authToken = httpServer.getAuthToken();
          cobuildingHttpBaseUrl = baseUrl;
          cobuildingHttpAuthToken = authToken;
          log.info(`[HTTP Server] Started on port ${port}, base URL: ${baseUrl}`);

          // Store HTTP port so the HTTPS server can proxy to it when started from debug panel
          setHttpProxyPort(port);

          if (baseUrl && authToken) {
            // Share server URL and auth token with the renderer for direct API calls
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript(
                `window.__COBUILDING_SERVER_URL__ = ${JSON.stringify(baseUrl)}; window.__COBUILDING_AUTH_TOKEN__ = ${JSON.stringify(authToken)};`
              );
            }
            // Set workspace directory so the overlay knows which docs are in the workspace
            const activeWorkspace = workspaceController.activeWorkspace;
            if (activeWorkspace) {
              windowMonitorService.setActiveWorkspaceDirectory(activeWorkspace.directory_path);
              windowMonitorService.setSessionsProvider(({ documentPath, documentPathLike }) => {
                if (!activeWorkspace) return [];
                const rows = documentPathLike !== undefined
                  ? listSessionsByDocPathLike(activeWorkspace.id, undefined, documentPathLike)
                  : listSessions(activeWorkspace.id, undefined, documentPath);
                return rows.map(s => ({
                  id: s.id,
                  title: s.title,
                  created_at: s.created_at,
                  is_running: getRegisteredSession(s.id)?.isRunning ?? false,
                }));
              });
            }
            // Auto-start the overlay so it appears over Word without
            // requiring the user to visit the desktop app home tab first.
            if (process.platform === 'darwin' && !windowMonitorService.isRunning()) {
              const hasPermission = wordAccessibility.checkPermission();
              if (hasPermission) {
                windowMonitorService.start(baseUrl, authToken, false);
                log.info('[overlay:autoStart] Window monitor started automatically');
              }
            }
          }

        } catch (error) {
          log.error('[HTTP Server] Failed to start:', error);
        }
      })();
    }

    if (isSmokeTest) {
      log.info('[SMOKE TEST] All services started — shutting down');
      console.log('[SMOKE TEST] All services started — shutting down');
      app.quit();
      return;
    }
  } catch (error) {
    log.error('[APP] Fatal error during startup:', error);
    dialog.showErrorBox(
      'Academia Coscientist - Startup Error',
      `The application failed to start.\n\n${error instanceof Error ? error.message : String(error)}\n\nCheck the log file for details:\n${log.transports.file.getFile().path}`,
    );
  }
}).catch((error) => {
  log.error('[APP] app.whenReady() rejected:', error);
});

app.on('activate', () => {
  if (!mainWindow) {
    createMainWindow();
  }
});

ipcMain.handle(
  'workspaces:create',
  async (_event, data: { name: string; directoryPath: string }) => {
    let apiKey = getCredentials().apiKey ?? '';
    if (!apiKey) {
      try {
        await fetchGatewayCredentials(getApiProvider() === 'cloudflare');
        apiKey = getCredentials().apiKey ?? '';
      } catch (err) {
        log.warn('[workspaces:create] Could not fetch API key:', err);
      }
    }
    const activeWorkspace = await workspaceController.create(data.directoryPath, apiKey);
    if (activeWorkspace) {
      containerService.writeStartContainerScript(workspaceController.mountMap);
      if (getReactionsEnabled()) {
        ensureReactionsTask(activeWorkspace.id);
      }
      const scheduler = getTaskScheduler();
      scheduler?.stop();
      scheduler?.start();
      // Tell the Word overlay about the freshly-created workspace so it
      // recognizes docs inside it (otherwise the overlay falls through to
      // the legacy "Not linked to a project" view on first onboarding).
      windowMonitorService.setActiveWorkspaceDirectory(activeWorkspace.directory_path);
      windowMonitorService.setSessionsProvider(({ documentPath, documentPathLike }) => {
        if (!activeWorkspace) return [];
        const rows = documentPathLike !== undefined
          ? listSessionsByDocPathLike(activeWorkspace.id, undefined, documentPathLike)
          : listSessions(activeWorkspace.id, undefined, documentPath);
        return rows.map((s) => ({ id: s.id, title: s.title, created_at: s.created_at, is_running: getRegisteredSession(s.id)?.isRunning ?? false }));
      });
      // Directory scan is triggered separately via scanner:start IPC
    }
    return activeWorkspace ?? null;
  },
);

ipcMain.handle('debug:restartOnboarding', async () => {
  backgroundBuilder.dispose();
  ensuredApps.clear();
  packageInstaller.reset();
  await stopAgentInfrastructure();
  containerService.stop();
  getTaskScheduler()?.stop();
  workspaceController.deactivateAll();
});

ipcMain.handle('workspaces:listDirectories', () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  return listWorkspaceDirectories(activeWorkspace.id);
});

// ─── Reports IPC ──────────────────────────────────────────────────

ipcMain.handle('reports:getLatest', (_event, reportType: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return null;
  return getLatestReport(activeWorkspace.id, reportType);
});

ipcMain.handle('reports:get', (_event, reportId: string) => {
  return getReport(reportId);
});

ipcMain.handle('reports:update', (_event, reportId: string, reportData: string) => {
  updateReportData(reportId, reportData);
});

// ─── Papers (Paper Monitor) IPC ─────────────────────────────────

ipcMain.handle('papers:fetch', async (_event, input: FetchPapersInput) => {
  const safeInput: FetchPapersInput = input ?? { topics: [] };
  log.info('[Papers] fetch start, topics:', safeInput.topics);
  try {
    const result = await fetchPapers(safeInput);
    log.info(
      `[Papers] fetch ok: ${result.papers.length} papers, ${result.errors.length} source/topic errors`,
    );
    if (result.errors.length > 0) {
      for (const e of result.errors) {
        log.warn(`[Papers] ${e.source}/"${e.topic}": ${e.message}`);
      }
    }
    const activeWorkspace = workspaceController.activeWorkspace;
    if (activeWorkspace && result.papers.length > 0) {
      try {
        persistPapersAsBriefings(activeWorkspace.id, result.papers);
      } catch (err) {
        log.warn(
          '[Papers→Briefings] persist failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[Papers] fetch failed:', message, err instanceof Error ? err.stack : '');
    return {
      papers: [],
      fetchedAt: new Date().toISOString(),
      errors: [{ source: 'arxiv' as const, topic: '*', message }],
    };
  }
});

// ─── Briefings IPC ──────────────────────────────────────────────

ipcMain.handle(
  'briefings:list',
  (_event, filter?: { status?: BriefingStatus[]; limit?: number }) => {
    const activeWorkspace = workspaceController.activeWorkspace;
    if (!activeWorkspace) return [];
    return listBriefings(activeWorkspace.id, filter ?? {});
  },
);

ipcMain.handle(
  'briefings:setStatus',
  (_event, id: string, status: BriefingStatus) => {
    setBriefingStatus(id, status);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('briefings:changed');
    }
  },
);

// ─── Scanned Files IPC ──────────────────────────────────────────

ipcMain.handle('scannedFiles:getByType', (_event, fileType: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  return getScannedFilesByType(activeWorkspace.id, fileType);
});

ipcMain.handle('scannedFiles:getAll', () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  return getScannedFiles(activeWorkspace.id);
});

ipcMain.handle(
  'scannedFiles:updateTag',
  (_event, filePath: string, fileName: string, fileType: string) => {
    const activeWorkspace = workspaceController.activeWorkspace;
    if (!activeWorkspace) return;
    updateFileTag(activeWorkspace.id, filePath, fileName, fileType);
  },
);

ipcMain.handle('scannedFiles:removeTag', (_event, filePath: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return;
  removeFileTag(activeWorkspace.id, filePath);
});

// ─── Directory Scanner IPC ──────────────────────────────────────

let scannerRunning = false;

ipcMain.handle('scanner:start', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }
  let { apiKey, baseURL } = getCredentials();
  if (!apiKey) {
    await fetchGatewayCredentials(getApiProvider() === 'cloudflare');
    ({ apiKey, baseURL } = getCredentials());
  }
  const scanDir = workspaceController.userDirectories[0]?.directory_path;
  if (!scanDir) {
    log.warn('[scanner:start] No user directories to scan');
    return;
  }
  if (scannerRunning) {
    log.warn('[scanner:start] Scan already in progress — ignoring duplicate request');
    return;
  }
  scannerRunning = true;

  scanWorkspaceDirectory({
    workspaceId: activeWorkspace.id,
    directoryPath: scanDir,
    memoryDir: path.join(workspaceController.workspacePath, AGENT_MEMORY_SUBDIR),
    apiKey: apiKey ?? '',
    baseURL,
    onMessage: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scanner:event', event);
      }
    },
    onBriefingsChanged: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('briefings:changed');
      }
    },
  }).catch((err) => {
    log.error('[scanner:start] Scan failed:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scanner:event', {
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }).finally(() => {
    scannerRunning = false;
  });
});

// ─── Agent Server & MCP Management ──────────────────────────────

const activeNotificationsSet = new Set<any>();

function registerHostMcpServers(workspace: { id: string; directory_path: string }, onNotificationClick?: (action: any) => void) {
  // Handler maps for MCP tool calls relayed from the in-container agent.
  // Each handler matches the tool's original implementation on the host side.
  const { queryActivity } = require('./activityQuery');
  const { getWordFilePath, getWordText, getWordSelection, saveWordDocument, openWordDocument } = require('../../server/wordActions');
  const { googleDocsGetActiveDoc, googleDocsGetText, googleDocsFindAndReplace } = require('./mcpServers/googleDocsMcpServer');
  const {
    appleNotesGetActiveNote,
    appleNotesGetText,
    appleNotesListNotes,
    appleNotesSearchNotes,
    appleNotesSaveNote,
    appleNotesOpenNote,
    appleNotesFindAndReplace,
  } = require('./mcpServers/appleNotesMcpServer');
  const { createObsidianHandlers } = require('./mcpServers/obsidianMcpServer');
  const { resolveObsidianDocumentPath } = require('./hostApps/obsidianHostApp');
  const { checkLogin } = require('../../apiClient');
  const { findReferencesForFile, findReferencesForText, createCitationReportFromText, getCitationReport, addClaimToReport, searchCitationsForClaim, formatCitations, listCitationReports } = require('./citeright/citeRightClient');
  const { saveUserContext: grantsSaveUserContext, createProject: grantsCreateProject, getProject: grantsGetProject, listProjects: grantsListProjects, setFavoriteOpportunity, setHiddenOpportunity, setHiddenReason: grantsSetHiddenReason, visitOpportunity, updateProject: grantsUpdateProject } = require('./grants/grantsClient');
  const { summarizeReport } = require('./citeright/reportSummary');
  const { createSession: createDbSession, insertMessage: insertDbMessage, updateSessionTitle } = require('./db/chatRepository');
  const { randomUUID } = require('crypto');

  // Build handler maps — each handler matches the signature used by the host MCP servers
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

  const handlers: Record<string, Record<string, (args: any) => Promise<any>>> = {
    activity: {
      query_activity: async (args: any) => {
        const result = queryActivity(args);
        if ('error' in result) return fail(result.error);
        const browserCount = result.browser_sessions
          ? result.browser_sessions.reduce((sum: number, group: any) => sum + (group.sessions as unknown[]).length, 0) : 0;
        const fileCount = result.file_sessions?.length || 0;
        const header = `Activity from ${result.query.since} to ${result.query.until}\nBrowser sessions: ${browserCount} | File sessions: ${fileCount}\n`;
        return ok(header + '\n' + JSON.stringify(result, null, 2));
      },
    },

    notification: {
      show_notification: async (args: any) => {
        try {
          const { Notification: ElectronNotification } = require('electron');
          const notification = new ElectronNotification({ title: args.title, body: args.body });
          activeNotificationsSet.add(notification);

          const release = () => {
            activeNotificationsSet.delete(notification);
          };

          if (onNotificationClick) {
            notification.on('click', () => {
              release();
              if (args.navigation) {
                const nav = args.navigation;
                if (nav.type === 'thread' && nav.threadId) {
                  onNotificationClick({ type: 'thread', threadId: nav.threadId, sidebarTab: nav.sidebarTab });
                } else if (nav.type === 'sidebar' && nav.sidebarTab) {
                  onNotificationClick({ type: 'sidebar', tab: nav.sidebarTab });
                } else {
                  onNotificationClick(null);
                }
              } else {
                onNotificationClick(null);
              }
            });
            notification.on('close', () => release());
          } else {
            release();
          }

          notification.show();
          return ok('Notification shown successfully.');
        } catch (err: any) {
          return fail(`Failed to show notification: ${err.message}`);
        }
      },
    },

    reaction: {
      create_reaction_thread: async (args: any) => {
        try {
          const sessionId = randomUUID();
          createDbSession(sessionId, workspace.id, 'reactions');
          insertDbMessage(sessionId, 'assistant', JSON.stringify([{ type: 'text', text: args.message }]));
          updateSessionTitle(sessionId, args.title);
          return ok(`Reaction thread created: ${args.title} (id: ${sessionId})`);
        } catch (err: any) {
          return fail(`Failed to create reaction thread: ${err.message}`);
        }
      },
    },

    'google-docs': {
      get_active_doc: googleDocsGetActiveDoc,
      get_text: googleDocsGetText,
      find_and_replace: googleDocsFindAndReplace,
    },

    'apple-notes': {
      get_active_note: appleNotesGetActiveNote,
      get_text: appleNotesGetText,
      list_notes: appleNotesListNotes,
      search_notes: appleNotesSearchNotes,
      save_note: appleNotesSaveNote,
      open_note: appleNotesOpenNote,
      find_and_replace: appleNotesFindAndReplace,
    },

    obsidian: createObsidianHandlers({
      workspaceDir: workspace.directory_path,
      getActiveNotePath: () => resolveObsidianDocumentPath(workspace.directory_path),
    }),

    'ms-word': {
      get_file_path: async () => { try { return ok(JSON.stringify(await getWordFilePath())); } catch (e: any) { return fail(String(e)); } },
      get_text: async (args: any) => { try { return ok(JSON.stringify(await getWordText(args.offset, args.limit))); } catch (e: any) { return fail(String(e)); } },
      get_selection: async () => { try { return ok(JSON.stringify(await getWordSelection())); } catch (e: any) { return fail(String(e)); } },
      save_document: async () => { try { return ok(JSON.stringify(await saveWordDocument())); } catch (e: any) { return fail(String(e)); } },
      open_document: async (args: any) => { try { return ok(JSON.stringify(await openWordDocument(args.path))); } catch (e: any) { return fail(String(e)); } },
      find_and_replace: async (args: any) => ok(JSON.stringify({ proposed: true, ...args })),
    },

    citeright: {
      find_references: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
        const pollOptions = { timeoutMs: (args.timeout_seconds ?? 600) * 1000, pollIntervalMs: (args.poll_interval_seconds ?? 3) * 1000 };
        const response = args.file_path ? await findReferencesForFile(args.file_path, pollOptions) : await findReferencesForText(args.document_text, pollOptions);
        return ok(JSON.stringify(summarizeReport(response)));
      },
      create_citation_report: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
        return ok(JSON.stringify(summarizeReport(await createCitationReportFromText(args.document_text))));
      },
      get_citation_report: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
        return ok(JSON.stringify(summarizeReport(await getCitationReport(args.report_id))));
      },
      add_claim_to_report: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
        return ok(JSON.stringify(summarizeReport(await addClaimToReport(args.report_id, args.text))));
      },
      search_citations_for_claim: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
        return ok(JSON.stringify(summarizeReport(await searchCitationsForClaim(args.report_id, args.claim_id))));
      },
      format_citations: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await formatCitations(args.works)));
      },
      list_citation_reports: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await listCitationReports(args.page, args.per_page)));
      },
    },

    'mini-apps': {
      open_mini_application: async (args: any) => {
        const appDir = path.join(workspace.directory_path, '.applications', args.dir_name);
        const exists = await fs.promises.access(appDir).then(() => true, () => false);
        if (!exists) return fail(`Mini-application directory not found: .applications/${args.dir_name}`);
        return ok(`Opened mini-application: ${args.dir_name}`);
      },
      // Builds the bundle with esbuild and reports success/failure to the
      // agent. The renderer-side handler waits for a successful complete
      // status before reloading the app's iframe — on failure (esbuild
      // non-zero, container down, etc.) the user's UI does not change and
      // the agent receives the build error to fix. Pure
      // `open_mini_application` is still available for opening already-built
      // apps without re-bundling.
      build_and_open_mini_application: async (args: any) => {
        const appDir = path.join(workspace.directory_path, '.applications', args.dir_name);
        const exists = await fs.promises.access(appDir).then(() => true, () => false);
        if (!exists) return fail(`Mini-application directory not found: .applications/${args.dir_name}`);

        const entry = `.applications/${args.dir_name}/src/index.tsx`;
        const outfile = `.applications/${args.dir_name}/dist/bundle.js`;
        const build = await containerService.exec([
          'esbuild',
          entry,
          '--bundle',
          `--outfile=${outfile}`,
          '--jsx=automatic',
          '--loader:.tsx=tsx',
          '--loader:.ts=ts',
          '--format=iife',
          '--alias:@reusable=/data/.applications/_reusable',
        ]);
        if (build.exitCode !== 0) {
          const detail = (build.stderr || build.stdout || '').trim() || 'Unknown build error';
          return fail(`Build failed for ${args.dir_name}:\n${detail}`);
        }

        return ok(`Built and opened mini-application: ${args.dir_name}`);
      },
    },

    zotero: {
      status: async () => {
        try {
          const { getZoteroLocalStatus } = require('../../zoteroLocalClient');
          const status = await getZoteroLocalStatus();
          return ok(JSON.stringify({ status }));
        } catch (e: any) { return fail(`Zotero status check failed: ${e.message}`); }
      },
      search_library: async (args: any) => {
        try {
          const { searchZoteroLibrary } = require('../../zoteroLocalClient');
          return ok(JSON.stringify(await searchZoteroLibrary(args.query, args.limit)));
        } catch (e: any) { return fail(`Zotero search failed: ${e.message}`); }
      },
      get_item: async (args: any) => {
        try {
          const { getZoteroItem } = require('../../zoteroLocalClient');
          return ok(JSON.stringify(await getZoteroItem(args.key)));
        } catch (e: any) { return fail(`Zotero get_item failed: ${e.message}`); }
      },
      add_doi: async (args: any) => {
        try {
          const { addDoiToZotero } = require('../../zoteroLocalClient');
          return ok(JSON.stringify(await addDoiToZotero(args.doi)));
        } catch (e: any) { return fail(`Zotero add_doi failed: ${e.message}`); }
      },
    },

    grants: {
      save_user_context: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await grantsSaveUserContext(args.data)));
      },
      create_project: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await grantsCreateProject(args.research_summary, args.name)));
      },
      get_project: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await grantsGetProject(args.project_id)));
      },
      list_projects: async () => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await grantsListProjects()));
      },
      favorite_opportunity: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await setFavoriteOpportunity(args.project_id, args.grant_opportunity_id, args.favorite)));
      },
      hide_opportunity: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await setHiddenOpportunity(args.project_id, args.grant_opportunity_id, args.hidden)));
      },
      set_hidden_reason: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await grantsSetHiddenReason(args.project_id, args.grant_opportunity_id, args.hidden_reason)));
      },
      visit_opportunity: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await visitOpportunity(args.project_id, args.grant_opportunity_id)));
      },
      update_project: async (args: any) => {
        const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
        return ok(JSON.stringify(await grantsUpdateProject(args.project_id, { name: args.name, research_summary: args.research_summary })));
      },
    },

    workspace: {
      get_scanned_files: async (args: any) => {
        try {
          const files = args.file_type
            ? getScannedFilesByType(workspace.id, args.file_type)
            : getScannedFiles(workspace.id);
          const cleaned = files.map(({ file_path, file_name, file_type }: { file_path: string; file_name: string; file_type: string }) => ({
            file_path, file_name, file_type,
          }));
          return ok(JSON.stringify({ files: cleaned, count: cleaned.length }));
        } catch (err: any) {
          return fail(`Failed to get scanned files: ${err.message}`);
        }
      },

      get_research_profile: async () => {
        try {
          const report = getLatestReport(workspace.id, 'directory_scan');
          if (!report) {
            return ok(JSON.stringify({ about_you: null, working_on: null, status: 'not_started' }));
          }
          if (report.status !== 'completed') {
            return ok(JSON.stringify({ about_you: null, working_on: null, status: report.status }));
          }
          let aboutYou: string | null = null;
          let workingOn: string | null = null;
          try {
            const parsed = JSON.parse(report.report_data);
            aboutYou = parsed.about_you ?? null;
            workingOn = parsed.working_on ?? null;
          } catch { /* ignore */ }
          if (!aboutYou || !workingOn) {
            const memoryDir = path.join(workspace.directory_path, AGENT_MEMORY_SUBDIR);
            if (!aboutYou) {
              try { aboutYou = await fs.promises.readFile(path.join(memoryDir, 'about_you.md'), 'utf-8'); } catch { /* not available */ }
            }
            if (!workingOn) {
              try { workingOn = await fs.promises.readFile(path.join(memoryDir, 'working_on.md'), 'utf-8'); } catch { /* not available */ }
            }
          }
          return ok(JSON.stringify({ about_you: aboutYou, working_on: workingOn, status: report.status }));
        } catch (err: any) {
          return fail(`Failed to get research profile: ${err.message}`);
        }
      },
    },
  };

  (globalThis as any).__hostMcpServers = handlers;
  log.info(`[MCP] Registered host MCP handlers: ${Object.keys(handlers).join(', ')}`);
}

/**
 * TODO: Remove this migration once most users have updated past this version.
 * Added: 2026-05-04. Safe to remove after ~2026-08-01.
 *
 * One-time migration: copy SDK session JSONL files from the bundled podman's
 * HOME directory to the container's CLAUDE_CONFIG_DIR on the workspace mount.
 * The old architecture stored sessions at ~/.cobuild-podman[-dev]/.claude/projects/
 * because the SDK inherited HOME from the bundled podman environment.
 */
function migrateHostSessionsToContainer(workspacePath: string): void {
  const markerPath = path.join(workspacePath, '.academia', 'claude-config', '.sessions-migrated');
  if (fs.existsSync(markerPath)) return;

  const os = require('os');
  // The bundled podman sets HOME to ~/.cobuild-podman (prod) or ~/.cobuild-podman-dev (dev).
  // The SDK stored sessions there under .claude/projects/{sanitized-workspace-path}/.
  const suffix = app.isPackaged ? '' : '-dev';
  const podmanHome = path.join(os.homedir(), `.cobuild-podman${suffix}`);
  const hostProjectsDir = path.join(podmanHome, '.claude', 'projects');
  const containerProjectsDir = path.join(workspacePath, '.academia', 'claude-config', 'projects', '-data');

  if (!fs.existsSync(hostProjectsDir)) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString());
    return;
  }

  let copied = 0;
  try {
    fs.mkdirSync(containerProjectsDir, { recursive: true });

    // Scan all project directories — the workspace path may have changed over
    // time, so copy sessions from all projects (not just the current one).
    for (const projectDir of fs.readdirSync(hostProjectsDir)) {
      const projectPath = path.join(hostProjectsDir, projectDir);
      if (!fs.statSync(projectPath).isDirectory()) continue;

      for (const file of fs.readdirSync(projectPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const src = path.join(projectPath, file);
        const dest = path.join(containerProjectsDir, file);
        if (fs.existsSync(dest)) continue;

        fs.copyFileSync(src, dest);
        copied++;

        // Copy subagent directories
        const sessionId = file.replace('.jsonl', '');
        const subagentDir = path.join(projectPath, sessionId, 'subagents');
        if (fs.existsSync(subagentDir)) {
          const destSubDir = path.join(containerProjectsDir, sessionId, 'subagents');
          fs.mkdirSync(destSubDir, { recursive: true });
          for (const sub of fs.readdirSync(subagentDir)) {
            fs.copyFileSync(path.join(subagentDir, sub), path.join(destSubDir, sub));
          }
        }
      }
    }
  } catch (err) {
    log.warn(`[SessionMigration] Error: ${(err as Error).message}`);
  }

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, new Date().toISOString());
  if (copied > 0) {
    log.info(`[SessionMigration] Migrated ${copied} session files from ${podmanHome} to container config`);
  }
}

/**
 * TODO: Remove this migration once most workspaces have been migrated past
 * this version. Added: 2026-05-05. Safe to remove after ~2026-08-05.
 *
 * Every mini-app must have a manifest.json describing its name, description,
 * icon (Lucide name), and lastOpened timestamp — the Tools page reads this to
 * render each app and order by recency. Apps created before this change don't
 * have one. On startup we scan .applications/* for missing manifests and
 * launch a background job per app that asks Claude to generate the metadata
 * from the app's source. Failures are logged and retried on next startup.
 */
async function migrateMissingManifests(workspace: Workspace): Promise<void> {
  const appsDir = path.join(workspace.directory_path, '.applications');

  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(appsDir, { withFileTypes: true });
  } catch {
    return;
  }

  const missing: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const manifestPath = path.join(appsDir, entry.name, 'manifest.json');
    try {
      await fsPromises.access(manifestPath);
    } catch {
      missing.push(entry.name);
    }
  }

  if (missing.length === 0) return;
  log.info(`[ManifestMigration] Generating manifests for ${missing.length} apps: ${missing.join(', ')}`);

  // Run sequentially to keep API load light. Each app is independent; one
  // failure doesn't affect the others.
  for (const dirName of missing) {
    try {
      await generateManifestForApp(workspace, dirName);
    } catch (err) {
      log.warn(`[ManifestMigration] Failed for ${dirName}: ${(err as Error).message ?? err}`);
    }
  }
}

async function generateManifestForApp(workspace: Workspace, dirName: string): Promise<void> {
  const appDir = path.join(workspace.directory_path, '.applications', dirName);
  const manifestPath = path.join(appDir, 'manifest.json');

  // Another startup run may have raced to write the file in the meantime.
  try {
    await fsPromises.access(manifestPath);
    return;
  } catch { /* keep going */ }

  const { apiKey: manifestApiKey, baseURL: manifestBaseURL } = getCredentials();
  if (!manifestApiKey) {
    log.warn(`[ManifestMigration] No API key — skipping ${dirName}`);
    return;
  }

  let appSource = '';
  try {
    appSource = await fsPromises.readFile(path.join(appDir, 'src', 'App.tsx'), 'utf-8');
  } catch { /* fall back to dir name */ }
  if (appSource.length > 8000) appSource = appSource.slice(0, 8000);

  const client = new Anthropic({ apiKey: manifestApiKey, baseURL: manifestBaseURL });
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `You are generating manifest.json metadata for a mini-app. Return only JSON with these fields:
- name: short user-visible title (≤ 40 chars)
- description: one-sentence summary of what the app does (≤ 80 chars)
- icon: a Lucide icon name in PascalCase (e.g. FlaskConical, LineChart, Microscope, Dna, Beaker, Image, Table, BarChart3) that visually fits

Directory name: ${dirName}

App source (truncated):
${appSource || '(no App.tsx found — infer from the directory name)'}

Output JSON only. No prose, no code fences.`,
    }],
  });

  const block = message.content[0] as { type: string; text?: string };
  const text = (block && block.type === 'text' && block.text) ? block.text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in model response');

  const parsed = JSON.parse(jsonMatch[0]) as { name?: unknown; description?: unknown; icon?: unknown };
  const fallbackName = dirName.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const manifest = {
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : fallbackName,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    icon: typeof parsed.icon === 'string' && parsed.icon.trim() ? parsed.icon : 'LayoutGrid',
    lastOpened: null,
  };

  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log.info(`[ManifestMigration] Wrote manifest for ${dirName}: ${manifest.name} / ${manifest.icon}`);
}

async function startAgentInfrastructure(workspacePath: string): Promise<void> {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return;

  try {
    await refreshCredentialsForSession();
  } catch (err) {
    log.warn('[startAgentInfrastructure] Credential refresh failed, using stored key:', err);
  }

  // 0. One-time migration of session files from bundled podman HOME
  migrateHostSessionsToContainer(workspacePath);

  // When overlay is active, host-side writes went to /data-host (lowerdir) which
  // isn't reliably visible through the overlay. Sync them into /data.
  if (containerService.isOverlayEnabled() && containerService.isRunning()) {
    try {
      await containerService.exec([
        'rsync', '-a',
        '/data-host/.academia/', '/data/.academia/',
      ]);
    } catch (err) {
      log.warn(`[startAgentInfrastructure] Failed to sync host files into overlay: ${(err as Error).message}`);
    }
  }

  // 0b. Backfill manifest.json for any apps that pre-date the manifest format.
  // Fire-and-forget so AI calls don't gate the rest of startup.
  void migrateMissingManifests(activeWorkspace);

  // 1. Copy agent server bundle and claude binary to workspace
  await containerService.ensureAgentFilesInWorkspace(workspacePath);

  // 2. Register host MCP server handlers for the SSE relay
  registerHostMcpServers(activeWorkspace, handleNotificationNavigation);

  // 3. Write agent config and start the agent server inside the container
  const { apiKey: agentApiKey, baseURL: agentBaseURL } = getCredentials();
  const agentConfig = {
    port: 8080,
    claudeBinaryPath: '/data/.academia/claude',
    mcpServers: {},  // MCP tools are relayed via SSE, not direct HTTP
    anthropicApiKey: agentApiKey ?? '',
    ...(agentBaseURL ? { anthropicBaseURL: agentBaseURL } : {}),
    model: 'claude-opus-4-7',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent',
      'NotebookEdit', 'WebSearch', 'Skill', 'TodoWrite',
      'EnterPlanMode', 'ExitPlanMode',
      'mcp__activity__query_activity',
      'mcp__mini-apps__open_mini_application',
      'mcp__mini-apps__build_and_open_mini_application',
      'mcp__notification__show_notification',
      'mcp__reaction__create_reaction_thread',
      'mcp__ms-word__get_file_path', 'mcp__ms-word__get_text',
      'mcp__ms-word__get_selection', 'mcp__ms-word__save_document',
      'mcp__ms-word__open_document', 'mcp__ms-word__find_and_replace',
      'mcp__citeright__find_references', 'mcp__citeright__create_citation_report',
      'mcp__citeright__get_citation_report', 'mcp__citeright__add_claim_to_report',
      'mcp__citeright__search_citations_for_claim', 'mcp__citeright__format_citations',
      'mcp__citeright__list_citation_reports',
      'mcp__zotero__status', 'mcp__zotero__search_library',
      'mcp__zotero__get_item', 'mcp__zotero__add_doi',
      'mcp__google-docs__get_active_doc', 'mcp__google-docs__get_text',
      'mcp__google-docs__find_and_replace',
      'mcp__apple-notes__get_active_note', 'mcp__apple-notes__get_text',
      'mcp__apple-notes__list_notes', 'mcp__apple-notes__search_notes',
      'mcp__apple-notes__save_note', 'mcp__apple-notes__open_note',
      'mcp__apple-notes__find_and_replace',
      'mcp__obsidian__get_active_note', 'mcp__obsidian__get_text',
      'mcp__obsidian__list_notes', 'mcp__obsidian__open_note',
      'mcp__obsidian__find_and_replace',
      'mcp__grants__save_user_context', 'mcp__grants__create_project',
      'mcp__grants__get_project', 'mcp__grants__list_projects',
      'mcp__grants__favorite_opportunity', 'mcp__grants__hide_opportunity',
      'mcp__grants__set_hidden_reason', 'mcp__grants__visit_opportunity',
      'mcp__grants__update_project',
      'mcp__workspace__get_scanned_files',
      'mcp__workspace__get_research_profile',
    ],
    settingSources: ['project'],
  };

  await containerService.startAgentServer(JSON.stringify(agentConfig, null, 2), workspacePath);
}

async function stopAgentInfrastructure(): Promise<void> {
  await containerService.stopAgentServer();
  (globalThis as any).__hostMcpServers = null;
}

// Container IPC handlers
ipcMain.handle('container:start', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }
  // Foreground stays silent — SetupBanner is owned by ensureSetup. Background
  // build fans out to both `container:progress` (Base Image spinner) and
  // `container:backgroundBuild` (Environment section), with terminal stages
  // renamed for the latter so its existing handler recognizes them.
  const agentDir = workspaceController.workspacePath;
  await containerService.start(
    workspaceController.mountMap,
    undefined,
    makeBackgroundProgress(),
  );
  await startAgentInfrastructure(agentDir);
  backgroundBuilder.startWatching(agentDir, (appName) => {
    ensuredApps.add(appName);
  });
});

ipcMain.handle('container:stop', async () => {
  backgroundBuilder.stopWatching();
  ensuredApps.clear();
  packageInstaller.reset();
  await stopAgentInfrastructure();
  containerService.stop();
});

ipcMain.handle('container:status', () => {
  return { running: containerService.isRunning() };
});

ipcMain.handle('container:exec', async (_event, command: string[]) => {
  return containerService.exec(command);
});

ipcMain.handle('container:syncOverlay', async () => {
  return containerService.syncOverlay();
});

ipcMain.handle('container:execLogged', async (_event, command: string[], meta?: { source?: string; appDirName?: string | null }) => {
  return containerService.execLogged(command, meta as any);
});

ipcMain.handle('container:getBinaryMode', () => {
  return containerService.getBinaryMode();
});

ipcMain.handle('container:setBinaryMode', (_event, mode: string) => {
  containerService.setBinaryMode(mode as 'system' | 'bundled');
});

ipcMain.handle('container:getImageSource', () => {
  return containerService.getImageSource();
});

ipcMain.handle('container:setImageSource', (_event, source: string) => {
  containerService.setImageSource(source as 'registry' | 'local');
});

ipcMain.handle('container:getSkipImageBuild', () => {
  return containerService.getSkipImageBuild();
});

ipcMain.handle('container:setSkipImageBuild', (_event, skip: boolean) => {
  containerService.setSkipImageBuild(skip);
});

ipcMain.handle('settings:getMaxAttachmentSizeMB', () => {
  return getMaxAttachmentSizeMB();
});

ipcMain.handle('settings:setMaxAttachmentSizeMB', (_event, sizeMB: number) => {
  setMaxAttachmentSizeMB(sizeMB);
});

ipcMain.handle('container:getBundledStatus', () => {
  return containerService.getBundledBinaryStatus();
});

ipcMain.handle('container:downloadBinaries', async () => {
  await containerService.downloadBundledBinaries(sendProgressTo('container:progress'));
});

ipcMain.handle('container:getName', () => {
  return containerService.getContainerName();
});

ipcMain.handle('container:isImageBuilt', async () => {
  return containerService.isImageBuilt();
});

ipcMain.handle('container:isBaseImageDownloaded', async () => {
  return containerService.isBaseImageDownloaded();
});

ipcMain.handle('container:deleteBinaries', () => {
  containerService.deleteBundledBinaries();
});

ipcMain.handle('container:deleteImage', async () => {
  await containerService.deleteImage();
});

ipcMain.handle('container:downloadImage', async () => {
  await containerService.updateBaseImage(sendProgressTo('container:progress'));
});

ipcMain.handle('container:ensureSetup', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  const setupAgentDir = workspaceController.workspacePath;
  await containerService.ensureSetup(makeSetupProgress(), setupAgentDir);
  if (activeWorkspace) {
    await containerService.start(
      workspaceController.mountMap,
      undefined,
      makeBackgroundProgress(),
    );
    await startAgentInfrastructure(setupAgentDir);
    backgroundBuilder.startWatching(setupAgentDir, (appName) => {
      ensuredApps.add(appName);
    });
  }
});

// ─── Environment IPC ──────────────────────────────────────────────

ipcMain.handle('container:getEnvironmentInfo', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return null;
  const info = getEnvironmentInfo(workspaceController.workspacePath!);
  const imageHash = await containerService.getImageEnvironmentHash();

  return {
    imageType: info.hasAnyDeps ? 'user' : 'base',
    imageHash,
    environmentHash: info.environmentHash,
    inSync: info.environmentHash != null && imageHash === info.environmentHash,
    backgroundBuildState: backgroundBuilder.getState(),
    packageStates: packageInstaller.getPackageStates(),
    packageLines: packageInstaller.getPackageLines(),
    totalPip: info.merged.pipRequirements,
    totalNpm: info.merged.npmPackages,
    totalR: info.merged.rPackages,
    totalApt: info.merged.aptPackages,
    totalSetup: info.merged.setupScripts.map((s) => s.destName),
    apps: info.apps.map((a) => ({
      name: a.appName,
      pip: a.pipPackages,
      npm: a.npmDependencies,
      r: a.rPackages,
      apt: a.aptPackages,
      setup: a.setupScripts,
    })),
  };
});

// Track which apps have had their deps ensured this session.
// Cleared on container stop/restart so deps are re-checked against the new image.
const ensuredApps = new Set<string>();

ipcMain.handle('container:appDepsReady', (_event, dirName: string) => {
  return ensuredApps.has(dirName);
});

ipcMain.handle('container:ensureAppDeps', async (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) throw new Error('No active workspace');
  if (!containerService.isRunning()) throw new Error('Container is not running');
  if (ensuredApps.has(dirName)) {
    return { installed: [] };
  }

  // PackageInstaller dedups against any package currently installing (started
  // by BackgroundBuilder at workspace open, or the agent's install wrapper).
  // Concurrent ensureDeps calls for the same packages share state — no
  // duplicate downloads, no races on /opt/venv.
  const ensureDepsAppsDir = path.join(workspaceController.workspacePath!, '.applications');
  const steps = getInstallSteps(ensureDepsAppsDir, dirName);
  if (steps.length === 0) {
    ensuredApps.add(dirName);
    return { installed: [] };
  }

  await packageInstaller.ensureDeps(installStepsToRequests(steps, dirName));
  ensuredApps.add(dirName);
  return { installed: steps.map((s) => `${s.registry}: ${s.packages.length} packages`) };
});

// Renderer queries this on mount to know which packages to track in its
// "Installing software..." view. Each package's state and streamed lines
// arrive on installer:packageState and installer:packageLine.
ipcMain.handle('container:getAppInstallRequests', (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  const getAppAppsDir = path.join(workspaceController.workspacePath!, '.applications');
  const steps = getInstallSteps(getAppAppsDir, dirName);
  return installStepsToRequests(steps, dirName);
});

packageInstaller.on('package:state', (e: { registry: Registry; package: string; state: PackageState }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:packageState', e);
  }
});
packageInstaller.on('package:line', (e: { registry: Registry; package: string; line: string }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:packageLine', e);
  }
});

ipcMain.handle('container:rebuildEnvironment', async () => {
  if (skipImageBuild()) {
    log.info('[container:rebuildEnvironment] Skip-image-build mode, skipping');
    return;
  }
  const rebuildAgentDir = workspaceController.workspacePath;
  if (!rebuildAgentDir) throw new Error('No active workspace');
  const envDir = path.join(rebuildAgentDir, '.applications', '_environment');
  fs.rmSync(envDir, { recursive: true, force: true });
  await containerService.rebuildImage(
    rebuildAgentDir,
    sendProgressTo('container:backgroundBuild'),
  );
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.handle('app:relaunch', () => {
  if (app.isPackaged) app.relaunch();
  app.quit();
});

// Jupyter kernel gateway IPC handlers
ipcMain.handle('jupyter:startGateway', async () => {
  try {
    const activeWorkspace = workspaceController.activeWorkspace;
    if (!activeWorkspace) {
      log.warn('[KernelGateway] startGateway called with no active workspace');
      return { error: 'No active workspace' };
    }
    log.info(`[KernelGateway] startGateway requested for workspace: ${activeWorkspace.id}`);
    return await kernelGatewayService.start(workspaceController.workspacePath ?? undefined);
  } catch (err) {
    log.error('[KernelGateway] startGateway failed:', (err as Error).message);
    return { error: (err as Error).message };
  }
});

ipcMain.handle('jupyter:stopGateway', async () => {
  await kernelGatewayService.stop();
});

ipcMain.handle('jupyter:restartGateway', async () => {
  try {
    log.info('[KernelGateway] restartGateway requested');
    return await kernelGatewayService.restart();
  } catch (err) {
    log.error('[KernelGateway] restartGateway failed:', (err as Error).message);
    return { error: (err as Error).message };
  }
});

ipcMain.handle('jupyter:gatewayStatus', () => {
  return kernelGatewayService.getStatus();
});

ipcMain.handle('jupyter:listKernels', () => {
  return kernelGatewayService.listKernels();
});

ipcMain.handle('jupyter:shutdownKernel', (_event, kernelId: string) => {
  return kernelGatewayService.shutdownKernel(kernelId);
});

// Command log IPC handlers
import { commandLogger } from './commandLogger';

ipcMain.handle('commandLog:getAll', () => commandLogger.getAll());
ipcMain.handle('commandLog:getByApp', (_event, appDirName: string) => commandLogger.getByApp(appDirName));
ipcMain.handle('commandLog:getAppNames', () => commandLogger.getAppNames());

const backgroundBuilder = new BackgroundBuilder(
  () => workspaceController.workspacePath,
  () => mainWindow,
);

commandLogger.onEntry((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('commandLog:entry', entry);
  }
  // When the install wrapper succeeds, mark the app's deps as ensured
  if (entry.exitCode === 0 && entry.command.join(' ').includes('.applications/install') && entry.appDirName) {
    ensuredApps.add(entry.appDirName);
  }
  backgroundBuilder.onCommandEntry(entry);
});

// System log IPC handlers
ipcMain.handle('systemLog:getAll', () => systemLogger.getAll());

systemLogger.onEntry((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('systemLog:entry', entry);
  }
});

// Office Add-in IPC handlers
registerOfficeAddinIpcHandlers();

// File Monitor IPC handlers
ipcMain.handle('fileMonitor:status', () => ({ running: isFileMonitorRunning() }));
ipcMain.handle('fileMonitor:start', () => { startFileMonitor(); });
ipcMain.handle('fileMonitor:stop', () => { stopFileMonitor(); });
ipcMain.handle('fileMonitor:getTodaySessions', () => getTodayFileSessions());
ipcMain.handle('fileMonitor:openFile', (_event, fileUrl: string, bundleId?: string) => {
  try {
    const filePath = decodeURIComponent(new URL(fileUrl).pathname);
    if (bundleId) {
      return require('child_process').execFileSync('open', ['-b', bundleId, filePath]).toString();
    }
    return shell.openPath(filePath);
  } catch {
    return shell.openPath(fileUrl);
  }
});

ipcMain.handle('windowMonitor:setDockRightForDocument', (_event, documentPath: string, docked: boolean) => {
  windowMonitorService.setDockRightForDocument(documentPath, docked);
});

ipcMain.handle('windowMonitor:setOverlayKickoffForDocument', (_event, documentPath: string, prompt: string) => {
  windowMonitorService.setPendingKickoffForDocument(documentPath, prompt);
});

ipcMain.handle('windowMonitor:navigateOverlayToSession', (_event, sessionId: string) => {
  windowMonitorService.setPendingNavigateSession(sessionId);
});

ipcMain.handle('windowMonitor:requestNewOverlayChatForDocument', (_event, documentPath: string) => {
  windowMonitorService.requestNewOverlayChatForDocument(documentPath);
});


// Observations IPC handlers
ipcMain.handle('observations:getBrowserSessions', () => getAllSessions());
ipcMain.handle('observations:getFileSessions', () => getAllFileSessions());
ipcMain.handle('observations:getSessionFiles', () => getAllSessionFiles());

function notifySessionsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sessions:changed');
  }
}

// Session IPC handlers
ipcMain.handle('sessions:list', (_event, source?: string) => {
  return listSessions(undefined, source);
});
ipcMain.handle('sessions:runningIds', () => {
  const ids: string[] = [];
  // sessionRegistry only exposes per-id lookups; iterate known DB sessions
  // and check which have a running agent session.
  const allSessions = listSessions();
  for (const s of allSessions) {
    const reg = getRegisteredSession(s.id);
    if (reg?.isRunning) ids.push(s.id);
  }
  return ids;
});
ipcMain.handle('sessions:countForDocument', (_event, documentPath: string): number => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return 0;
  return listSessions(activeWorkspace.id, undefined, documentPath).length;
});
ipcMain.handle('sessions:get', (_event, id: string) => getSession(id));
ipcMain.handle('sessions:setDocumentPath', (_event, id: string, documentPath: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return;
  setSessionDocumentPath(id, activeWorkspace.id, documentPath);
  notifySessionsChanged();
});
ipcMain.handle('sessions:rename', (_event, id: string, title: string) => {
  updateSessionTitle(id, title);
  notifySessionsChanged();
});
ipcMain.handle('sessions:delete', (_event, id: string) => {
  deleteSession(id);
  if (getRegisteredSession(id)) {
    unregisterSession(id);
  }
  notifySessionsChanged();
});
ipcMain.handle('messages:list', (_event, sessionId: string) => getMessages(sessionId));

// Find or create a session associated with a mini app
ipcMain.handle('sessions:findForApp', async (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return null;
  if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
    return null;
  }

  const manifestPath = path.join(workspaceController.workspacePath!, '.applications', dirName, 'manifest.json');

  let manifest: Record<string, unknown> | null = null;
  try {
    const raw = await fsPromises.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') manifest = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable manifest — fall through to legacy search/create.
  }

  // Prefer the chatSessionId stored in the manifest when it points to a real session.
  const manifestSessionId = typeof manifest?.chatSessionId === 'string' ? manifest.chatSessionId : null;
  if (manifestSessionId && getSession(manifestSessionId)) {
    return manifestSessionId;
  }

  // Fall back to the legacy search (assistant tool call or synthetic user message).
  const existingId = findSessionForApp(activeWorkspace.id, dirName);
  if (existingId) return existingId;

  // No existing session — create one and link it via the manifest.
  const sessionId = randomUUID();
  const manifestName = typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name.trim() : null;
  const title = manifestName ?? dirName.replace(/[-_]/g, ' ');
  createSession(sessionId, activeWorkspace.id);
  updateSessionTitle(sessionId, title);

  if (manifest) {
    manifest.chatSessionId = sessionId;
    try {
      await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    } catch (err) {
      log.warn('[sessions:findForApp] Failed to write chatSessionId to manifest:', err);
    }
  }

  notifySessionsChanged();
  return sessionId;
});

async function generateSessionTitle(sessionId: string, firstMessage: string): Promise<void> {
  try {
    const { apiKey, baseURL } = getCredentials();
    log.info(`[TitleGen] sessionId=${sessionId} hasApiKey=${!!apiKey} baseURL=${baseURL ?? '(default)'}`);
    if (!apiKey) return;
    const client = new Anthropic({ apiKey, baseURL });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [
        {
          role: 'user',
          content: `Give a short title (5 words or less) that summarizes this message. Reply with ONLY the title, no quotes or punctuation.\n\nMessage: ${firstMessage}`,
        },
      ],
    });
    const title = (response.content[0].type === 'text' ? response.content[0].text : '').trim();
    log.info(`[TitleGen] sessionId=${sessionId} title="${title}"`);
    if (title) {
      updateSessionTitle(sessionId, title);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sessions:titleUpdated', sessionId, title);
      notifySessionsChanged();
      const { wordPollEventBus } = require('../../server/events/wordPollEventBus');
      wordPollEventBus.emit('change', 'session-title-updated');
    }
  } catch (err: any) {
    const { apiKey, baseURL } = getCredentials();
    log.warn(`[TitleGen] Failed sessionId=${sessionId} apiKey=${apiKey} baseURL=${baseURL ?? '(default)'}`);
    log.warn(`[TitleGen] error:`, err);
    if (err?.cause) log.warn(`[TitleGen] cause:`, err.cause);
  }
}

ipcMain.handle('chat:send', (event, { threadId, text, attachments, model, documentPath, messageId }: { threadId: string; text: string; attachments?: IPCAttachment[]; model?: string; documentPath?: string; messageId?: string }) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }

  log.info(`[chat:send] messageId=${messageId ?? '(none)'} threadId=${threadId} textLen=${text.length}`);

  // Dedup: if this messageId has already been persisted for this session, the
  // renderer is re-firing a send that already landed (typical cause: reload
  // with a queued draft). Re-attach forwarding for the new webContents but
  // don't re-run the turn.
  if (messageId) {
    const existingMessage = findMessageByMessageId(threadId, messageId);
    if (existingMessage) {
      log.info(`[chat:send] dedup hit messageId=${messageId} sessionId=${threadId} — re-attaching forwarding only`);
      ensureForwarding(threadId, event.sender);
      return { messageId, deduped: true };
    }
  }

  const existingRunning = getRegisteredSession(threadId);
  if (existingRunning?.isRunning) {
    // Session is already running (e.g. scheduled task or previous user chat).
    // Ensure IPC forwarding is set up (idempotent — won't duplicate).
    ensureForwarding(threadId, event.sender);
    existingRunning.sendMessage(text, attachments, messageId);
    return { messageId };
  }

  const isCalendarSession = threadId === 'calendar-assistant';
  let isFirstMessage = false;

  if (!hasSession(threadId)) {
    const existingDbSession = getSession(threadId);
    isFirstMessage = !existingDbSession;

    if (isCalendarSession) {
      const { apiKey: calApiKey, baseURL: calBaseURL } = getCredentials();
      const session = createCalendarAgentSession(
        threadId,
        activeWorkspace.id,
        calApiKey ?? '',
        workspaceController.workspacePath!,
        {
          onEvent: () => { },
          onDone: () => { },
          onError: () => { unregisterSession(threadId); },
        },
        (mutation: CalendarMutationEvent) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('calendar:mutation', mutation);
          }
        },
        calBaseURL,
        refreshCredentialsForSession,
      );
      // Headless agent embedded in the desktop chat — opt out of
      // subscriber-based eviction; lifecycle bound to the renderer.
      registerSession(threadId, session, 'background');
      event.sender.on('destroyed', () => {
        unregisterSession(threadId);
      });
    } else {
      const session = createAgentSession(
        threadId,
        {
          onEvent: () => { },
          onDone: () => { },
          onError: () => { unregisterSession(threadId); },
        },
        activeWorkspace!,
        existingDbSession?.sdk_session_id ?? undefined,
        undefined,
        handleNotificationNavigation,
        model,
        undefined,
        documentPath,
      );

      // Default 'ui': subscriber tracking via ensureForwarding handles
      // destroy when every surface detaches.
      registerSession(threadId, session);
    }
  }

  ensureForwarding(threadId, event.sender);
  // Also fan events out to overlays watching this session — they live on
  // the WKWebView side of an HTTP boundary so the IPC path can't reach them.
  ensureSseFanout(threadId);
  getRegisteredSession(threadId)!.sendMessage(text, attachments, messageId);

  if (isFirstMessage && !isCalendarSession) {
    generateSessionTitle(threadId, text);
  }

  return { messageId };
});

ipcMain.on('chat:subscribe', (event, threadId: string) => {
  ensureForwarding(threadId, event.sender);
});

// Authoritative server-side "is the agent mid-turn on this thread" signal.
// Survives renderer detach/reattach, unlike assistant-ui's `thread.isRunning`
// which is tied to the local run generator's lifetime.
ipcMain.handle('chat:isTurnInProgress', (_event, threadId: string): boolean => {
  return getRegisteredSession(threadId)?.isTurnInProgress ?? false;
});

// Renderer signals it's no longer viewing this thread. Whether the
// session itself is torn down is the registry's decision.
ipcMain.on('chat:unsubscribe', (event, threadId: string) => {
  removeForwarding(threadId, event.sender.id);
});

// Explicit user-initiated stop (Stop button). Tears the session down
// regardless of other subscribers — "stop" means stop.
ipcMain.on('chat:stop', (event, threadId: string) => {
  removeForwarding(threadId, event.sender.id);
  if (getRegisteredSession(threadId)) {
    unregisterSession(threadId);
  }
});

// =============================================================================
// Edit state sync (desktop ↔ overlay)
// =============================================================================

ipcMain.handle('edit-state:apply', async (_event, { toolCallId, document_path, search_text, replacement_text, replace_scope, match_case }: any) => {
  try {
    const { findHostAppForDocument } = await import('./hostApps');
    const { wordHostApp } = await import('./hostApps/wordHostApp');
    const host = findHostAppForDocument(document_path) ?? wordHostApp;
    host.onApplyEditWillRun?.();
    let result;
    try {
      result = await host.applyEdit({
        toolCallId,
        document_path,
        search_text,
        replacement_text,
        replace_scope: (replace_scope as 'first' | 'all') || 'first',
        match_case: match_case ?? true,
      });
    } finally {
      host.onApplyEditDidRun?.();
    }
    if (result.success) editStates.set(toolCallId, 'applied');
    else editStates.delete(toolCallId);
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('edit-state:set', (_event, { toolCallId, state }: { toolCallId: string; state: string }) => {
  editStates.set(toolCallId, state);
});

ipcMain.handle('edit-state:get-all', () => {
  return Object.fromEntries(editStates);
});

// =============================================================================
// Anthropic API proxy for mini-app iframes
//
// Mini-apps (agent-generated React apps running in sandboxed iframes) need to
// call Claude for inline AI features. They cannot hold the API key directly —
// it would be visible in the app source the agent writes and in the iframe's
// JS context. Instead, calls flow through this proxy:
//
//   iframe → postMessage → MiniAppViewer.tsx → IPC → here → Anthropic API
//
// The key never leaves this process. The iframe receives only the model's text
// response. All parameters are validated here before the SDK is invoked.
// =============================================================================

// Only these models may be requested. Unrecognised values silently fall back
// to haiku rather than erroring, so agent-written code that omits the field
// always gets a sensible default without breaking.
const ANTHROPIC_ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
]);

// Hard limits applied regardless of what the caller sends. The token cap
// prevents a runaway mini-app from exhausting the user's quota in one call.
// The character limits prevent IPC message bloat and are well above anything
// a legitimate mini-app would need.
const ANTHROPIC_MAX_TOKENS_LIMIT = 4096;
const ANTHROPIC_MAX_TEXT_CHARS = 100_000; // ~25k tokens
const ANTHROPIC_MAX_MESSAGES = 50;
const ANTHROPIC_MAX_SYSTEM_CHARS = 10_000;
const ANTHROPIC_MAX_CONTENT_BLOCKS = 20;
const ANTHROPIC_MAX_FILE_SIZE = 10_000_000; // 10 MB per file
const ANTHROPIC_MAX_BASE64_CHARS = 20_000_000; // ~15 MB decoded
const ANTHROPIC_ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Media type lookup for file-path based content blocks. The main process
// determines the type from the extension — the iframe cannot spoof it.
const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

type ValidatedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };

// Resolves a single content block. For file-path sources, reads the file from
// the workspace and base64-encodes it. For base64 sources, validates the data
// in place. Returns a clean, reconstructed block safe to pass to the SDK.
async function resolveContentBlock(
  raw: unknown,
  allowedDirs: string[],
): Promise<ValidatedContentBlock> {
  if (!raw || typeof raw !== 'object') throw new Error('Content block must be an object');
  const block = raw as Record<string, unknown>;
  if (typeof block.type !== 'string') throw new Error('Content block must have a type');

  if (block.type === 'text') {
    if (typeof block.text !== 'string') throw new Error('Text block must have a text field');
    if (block.text.length > ANTHROPIC_MAX_TEXT_CHARS) throw new Error(`Text block exceeds ${ANTHROPIC_MAX_TEXT_CHARS} characters`);
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image') {
    const source = block.source as Record<string, unknown> | undefined;
    if (!source || typeof source !== 'object') throw new Error('Image block must have a source');

    if (source.type === 'file') {
      if (typeof source.path !== 'string') throw new Error('Image file source must have a path');
      const resolved = assertWithinAllowedDirs(source.path, allowedDirs);
      const ext = path.extname(resolved).slice(1).toLowerCase();
      const mediaType = EXT_TO_MEDIA_TYPE[ext];
      if (!mediaType || !ANTHROPIC_ALLOWED_IMAGE_TYPES.has(mediaType)) {
        throw new Error(`Unsupported image type: .${ext}`);
      }
      const stats = await fsPromises.stat(resolved);
      if (stats.size > ANTHROPIC_MAX_FILE_SIZE) throw new Error(`Image file exceeds ${ANTHROPIC_MAX_FILE_SIZE} bytes`);
      const buffer = await fsPromises.readFile(resolved);
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: buffer.toString('base64') },
      };
    }

    if (source.type === 'base64') {
      if (typeof source.media_type !== 'string' || !ANTHROPIC_ALLOWED_IMAGE_TYPES.has(source.media_type)) {
        throw new Error('Image base64 source must have a valid media_type (image/jpeg, image/png, image/gif, image/webp)');
      }
      if (typeof source.data !== 'string') throw new Error('Image base64 source must have a data field');
      if (source.data.length > ANTHROPIC_MAX_BASE64_CHARS) throw new Error(`Image base64 data exceeds ${ANTHROPIC_MAX_BASE64_CHARS} characters`);
      return {
        type: 'image',
        source: { type: 'base64', media_type: source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: source.data },
      };
    }

    throw new Error('Image source type must be "file" or "base64"');
  }

  if (block.type === 'document') {
    const source = block.source as Record<string, unknown> | undefined;
    if (!source || typeof source !== 'object') throw new Error('Document block must have a source');

    const title = typeof block.title === 'string' ? block.title.slice(0, 1000) : undefined;

    if (source.type === 'file') {
      if (typeof source.path !== 'string') throw new Error('Document file source must have a path');
      const resolved = assertWithinAllowedDirs(source.path, allowedDirs);
      const ext = path.extname(resolved).slice(1).toLowerCase();
      if (ext !== 'pdf') throw new Error('Only PDF documents are supported');
      const stats = await fsPromises.stat(resolved);
      if (stats.size > ANTHROPIC_MAX_FILE_SIZE) throw new Error(`Document file exceeds ${ANTHROPIC_MAX_FILE_SIZE} bytes`);
      const buffer = await fsPromises.readFile(resolved);
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
        ...(title ? { title } : {}),
      };
    }

    if (source.type === 'base64') {
      if (source.media_type !== 'application/pdf') throw new Error('Document base64 source must have media_type "application/pdf"');
      if (typeof source.data !== 'string') throw new Error('Document base64 source must have a data field');
      if (source.data.length > ANTHROPIC_MAX_BASE64_CHARS) throw new Error(`Document base64 data exceeds ${ANTHROPIC_MAX_BASE64_CHARS} characters`);
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: source.data },
        ...(title ? { title } : {}),
      };
    }

    throw new Error('Document source type must be "file" or "base64"');
  }

  throw new Error(`Unsupported content block type: ${block.type}`);
}

type ValidatedMessage = { role: 'user' | 'assistant'; content: string | ValidatedContentBlock[] };

async function validateAnthropicParams(params: unknown, allowedDirs: string[]): Promise<{
  messages: ValidatedMessage[];
  model: string;
  max_tokens: number;
  system?: string;
}> {
  if (!params || typeof params !== 'object') throw new Error('Invalid params');
  const p = params as Record<string, unknown>;

  if (!Array.isArray(p.messages) || p.messages.length === 0) throw new Error('messages must be a non-empty array');
  if (p.messages.length > ANTHROPIC_MAX_MESSAGES) throw new Error(`messages exceeds maximum of ${ANTHROPIC_MAX_MESSAGES}`);

  const messages: ValidatedMessage[] = [];
  for (const m of p.messages) {
    if (!m || typeof m !== 'object') throw new Error('Each message must be an object');
    const msg = m as Record<string, unknown>;
    if (msg.role !== 'user' && msg.role !== 'assistant') throw new Error('message role must be user or assistant');

    if (typeof msg.content === 'string') {
      if (msg.content.length > ANTHROPIC_MAX_TEXT_CHARS) throw new Error(`message content exceeds ${ANTHROPIC_MAX_TEXT_CHARS} characters`);
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      if (msg.content.length === 0) throw new Error('content array must not be empty');
      if (msg.content.length > ANTHROPIC_MAX_CONTENT_BLOCKS) throw new Error(`content array exceeds ${ANTHROPIC_MAX_CONTENT_BLOCKS} blocks`);
      const blocks = await Promise.all(msg.content.map((b: unknown) => resolveContentBlock(b, allowedDirs)));
      messages.push({ role: msg.role, content: blocks });
    } else {
      throw new Error('message content must be a string or array of content blocks');
    }
  }

  // Silently clamp model to the allowlist so agent code that specifies a model
  // always works, even if the model name is slightly wrong or has been removed.
  const model = typeof p.model === 'string' && ANTHROPIC_ALLOWED_MODELS.has(p.model)
    ? p.model
    : 'claude-haiku-4-5-20251001';

  // Clamp rather than reject so the call still succeeds with a safe value.
  const max_tokens = typeof p.max_tokens === 'number' && p.max_tokens > 0
    ? Math.min(Math.floor(p.max_tokens), ANTHROPIC_MAX_TOKENS_LIMIT)
    : 1024;

  if (p.system !== undefined && typeof p.system !== 'string') throw new Error('system must be a string');
  if (typeof p.system === 'string' && p.system.length > ANTHROPIC_MAX_SYSTEM_CHARS) throw new Error(`system prompt exceeds ${ANTHROPIC_MAX_SYSTEM_CHARS} characters`);
  const system = typeof p.system === 'string' ? p.system : undefined;

  return { messages, model, max_tokens, system };
}

// Non-streaming completion. Uses ipcMain.handle so the result is automatically
// returned as a promise reply — no manual event sending required.
ipcMain.handle('anthropic:complete', async (_event, params: unknown) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  const { apiKey: completeApiKey, baseURL: completeBaseURL } = getCredentials();
  if (!completeApiKey) throw new Error('No API credentials available');
  if (!activeWorkspace) throw new Error('No active workspace');
  const validated = await validateAnthropicParams(params, workspaceController.allAllowedPaths);
  log.info('[anthropic:complete] workspace=%s model=%s max_tokens=%d messages=%d',
    activeWorkspace.id, validated.model, validated.max_tokens, validated.messages.length);
  const client = new Anthropic({ apiKey: completeApiKey, baseURL: completeBaseURL });
  return client.messages.create({
    model: validated.model,
    max_tokens: validated.max_tokens,
    messages: validated.messages,
    ...(validated.system ? { system: validated.system } : {}),
  });
});

// The streamKey is a UUID generated by MiniAppViewer (the trusted renderer),
// never by the iframe itself. This ensures no iframe-controlled string reaches
// IPC channel names or is used as a routing key in the main process.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Streaming completion. Uses ipcMain.on because multiple events need to be
// pushed back to the renderer (chunk, done, error) rather than a single reply.
// All events share one IPC channel name ('anthropic:stream:event') and are
// demultiplexed by streamKey on the renderer side.
ipcMain.on('anthropic:stream', async (event, { streamKey, params }: { streamKey: string; params: unknown }) => {
  if (typeof streamKey !== 'string' || !UUID_RE.test(streamKey)) {
    log.warn('[anthropic:stream] Invalid streamKey');
    return;
  }
  const { apiKey: streamApiKey, baseURL: streamBaseURL } = getCredentials();
  if (!streamApiKey) {
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: 'No API credentials available' });
    return;
  }
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) {
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: 'No active workspace' });
    return;
  }
  const streamAllowedDirs = workspaceController.allAllowedPaths;
  let validated: Awaited<ReturnType<typeof validateAnthropicParams>>;
  try {
    validated = await validateAnthropicParams(params, streamAllowedDirs);
  } catch (err) {
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: err instanceof Error ? err.message : String(err) });
    return;
  }
  log.info('[anthropic:stream] workspace=%s model=%s max_tokens=%d messages=%d',
    activeWorkspace.id, validated.model, validated.max_tokens, validated.messages.length);
  const client = new Anthropic({ apiKey: streamApiKey, baseURL: streamBaseURL });
  const stream = client.messages.stream({
    model: validated.model,
    max_tokens: validated.max_tokens,
    messages: validated.messages,
    ...(validated.system ? { system: validated.system } : {}),
  });

  // Abort the SDK stream immediately if the renderer is destroyed (e.g. the
  // mini-app is closed mid-stream). Without this, the HTTP connection would
  // stay open and keep consuming tokens until the response finished naturally.
  const abort = () => stream.abort();
  event.sender.once('destroyed', abort);

  try {
    stream.on('text', (text) => {
      if (!event.sender.isDestroyed()) event.sender.send('anthropic:stream:event', { streamKey, type: 'chunk', payload: text });
    });
    const finalMsg = await stream.finalMessage();
    if (!event.sender.isDestroyed()) event.sender.send('anthropic:stream:event', { streamKey, type: 'done', payload: finalMsg });
  } catch (err) {
    // Includes AbortError when the renderer is destroyed — isDestroyed() guard
    // ensures we don't attempt to send to a dead WebContents.
    if (!event.sender.isDestroyed())
      event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: err instanceof Error ? err.message : String(err) });
  } finally {
    event.sender.removeListener('destroyed', abort);
  }
});

ipcMain.handle('nativeTools:getUrl', async (_event, toolId: string) => {
  if (toolId === 'grantFinder' && cobuildingHttpBaseUrl) {
    return `${cobuildingHttpBaseUrl}/ui/popup/grantFinder/index.html`;
  }
  return null;
});

ipcMain.handle('academia:fetch', async (_event, args: { method: string; endpoint: string; data?: unknown }) => {
  const { callBackendApi } = require('../../apiCall');
  return callBackendApi({ method: args.method as any, endpoint: args.endpoint, data: args.data });
});

// Auth IPC handlers
ipcMain.handle('auth:checkLogin', async () => {
  try {
    const loggedIn = await checkLogin();
    if (loggedIn && getApiProvider() !== 'custom') {
      await fetchGatewayCredentials(getApiProvider() === 'cloudflare')
        .catch((err) => log.warn('[Auth] fetchGatewayCredentials error:', err));
    } else if (loggedIn && getApiProvider() === 'custom') {
      const customKey = getCustomAnthropicKey();
      if (customKey) {
        setCredentials(customKey, getCustomAnthropicBaseURL());
      }
    }
    const appInfo = {
      deviceId: getDeviceId(),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
    };
    if (!loggedIn) return { loggedIn: false, appInfo };
    const user = await getCurrentUser().catch(() => null);
    return { loggedIn: true, user, appInfo };
  } catch (error) {
    log.error('[Auth] checkLogin error:', error);
    return { loggedIn: false };
  }
});

ipcMain.handle('auth:startQRAuth', async () => {
  try {
    const session = await createCobuildingAuthSession(activeApiBaseUrl);
    return {
      success: true,
      deviceId: session.deviceId,
      qrCodeDataURL: session.qrCodeDataURL,
      authorizationURL: session.authorizationURL,
    };
  } catch (error: any) {
    log.error('[Auth] startQRAuth error:', error);
    return { success: false, error: error.message || 'Failed to create QR auth session' };
  }
});

ipcMain.handle('auth:verifyQRCode', async (_event, deviceId: string, code: string) => {
  try {
    if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
      return { success: false, error: 'Invalid code format. Please enter a 6-digit code.' };
    }
    const result = await verifyCobuildingAuthCode(deviceId, code);
    if (result.error) {
      return { success: false, error: result.error };
    }
    if (result.authorized) {
      await fetchGatewayCredentials(getApiProvider() === 'cloudflare')
        .catch((err) => log.warn('[Auth] fetchGatewayCredentials after verify error:', err));
    }
    return { success: true, authorized: result.authorized, userId: result.user_id };
  } catch (error: any) {
    log.error('[Auth] verifyQRCode error:', error);
    return { success: false, error: error.message || 'Verification failed' };
  }
});

ipcMain.handle('auth:getApiKey', () => {
  const { apiKey, baseURL } = getCredentials();
  return { apiKey, baseURL, provider: getApiProvider() };
});

ipcMain.handle('auth:getApiProvider', () => {
  return { provider: getApiProvider() };
});

ipcMain.handle('auth:setApiProvider', async (_event, provider: string, customKey?: string, customBaseURL?: string) => {
  if (provider !== 'cloudflare' && provider !== 'anthropic' && provider !== 'custom') {
    return { success: false, error: 'Invalid provider' };
  }
  setApiProvider(provider as ApiProvider);
  log.info(`[Auth] API provider set to: ${provider}`);

  if (provider === 'custom') {
    if (!customKey) return { success: false, error: 'API key is required for custom mode' };
    const baseURL = customBaseURL?.trim() || undefined;
    setCustomAnthropicKey(customKey, baseURL);
    destroyTokenManager();
    setCredentials(customKey, baseURL);
    log.info('[Auth] Using custom Anthropic API key');
    return { success: true };
  }

  try {
    await fetchGatewayCredentials(provider === 'cloudflare');
    return { success: true };
  } catch (error: any) {
    log.error('[Auth] Failed to fetch credentials after provider switch:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:refetchApiKey', async () => {
  try {
    const result = await fetchGatewayCredentials(getApiProvider() === 'cloudflare');
    log.debug('[Auth] Refetched API key successfully');
    return { success: true, keyIdentifier: result.keyIdentifier };
  } catch (error: any) {
    log.error('[Auth] refetchApiKey error:', error);
    return { success: false, error: error.message || 'Failed to refetch API key' };
  }
});

ipcMain.handle('auth:logout', async () => {
  try {
    backgroundBuilder.dispose();
    ensuredApps.clear();
    packageInstaller.reset();
    await stopAgentInfrastructure();
    containerService.stop();
    getTaskScheduler()?.stop();
    workspaceController.deactivateAll();
    destroyTokenManager();
    const result = await logout();
    return result;
  } catch (error: any) {
    log.error('[Auth] logout error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:hasSessionCookie', () => hasSessionCookie());

ipcMain.handle('auth:setEndpoint', (_event, endpoint: string) => {
  if (app.isPackaged) {
    return { success: false, error: 'Endpoint switching is not available in packaged builds' };
  }
  const url = endpoint === 'production' ? 'https://api.academia.edu/' : 'https://api.devdemia.com/';
  activeApiBaseUrl = url;
  setBaseUrl(url);

  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.apiEndpoint = endpoint;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');

  log.info(`[Auth] Switched API endpoint to ${endpoint} (${url})`);
  return { success: true, endpoint };
});

// Scheduled Tasks IPC handlers
ipcMain.handle('scheduledTasks:list', () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  return listTasks(activeWorkspace.id);
});

ipcMain.handle('scheduledTasks:get', (_event, id: string) => {
  return getTask(id) ?? null;
});

ipcMain.handle('scheduledTasks:create', (_event, data: CreateTaskData) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) throw new Error('No active workspace');
  const task = createTask(activeWorkspace.id, data.name, data.description, data.prompt, data.cron_expression, data.session_source ?? null);
  getTaskScheduler()?.scheduleTask(task.id);
  return task;
});

ipcMain.handle('scheduledTasks:update', (_event, id: string, data: UpdateTaskData) => {
  const existing = getTask(id);
  if (existing?.session_source === 'reactions-system') {
    data = { cron_expression: data.cron_expression, enabled: data.enabled };
  }
  const task = updateTask(id, data);
  if (task) {
    if (task.enabled) {
      getTaskScheduler()?.scheduleTask(id);
    } else {
      getTaskScheduler()?.unscheduleTask(id);
    }
  }
  return task ?? null;
});

ipcMain.handle('scheduledTasks:delete', (_event, id: string) => {
  const task = getTask(id);
  if (task?.session_source === 'reactions-system') {
    throw new Error('System tasks cannot be deleted');
  }
  getTaskScheduler()?.unscheduleTask(id);
  deleteTask(id);
});

ipcMain.handle('scheduledTasks:setEnabled', (_event, id: string, enabled: boolean) => {
  setTaskEnabled(id, enabled);
  if (enabled) {
    getTaskScheduler()?.scheduleTask(id);
  } else {
    getTaskScheduler()?.unscheduleTask(id);
  }
});

ipcMain.handle('scheduledTasks:runNow', async (_event, id: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) throw new Error('No active workspace');
  const task = getTask(id);
  if (!task) throw new Error('Task not found');
  await runScheduledTask(task, activeWorkspace, handleNotificationNavigation);
});

ipcMain.handle('scheduledTasks:listRuns', (_event, taskId: string) => {
  return listTaskRuns(taskId);
});

// .academia/ file IPC handlers
ipcMain.handle('academiaFile:read', async (_event, relativePath: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return { content: '' };
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return { content: '' };
  }
  if (containerService.isOverlayEnabled() && containerService.isRunning()) {
    try {
      const { stdout } = await containerService.exec(['cat', `/data/${ACADEMIA_DIR}/${normalized}`]);
      return { content: stdout };
    } catch {
      return { content: '' };
    }
  }
  const filePath = path.join(workspaceController.workspacePath!, ACADEMIA_DIR, normalized);
  try {
    return { content: await fsPromises.readFile(filePath, 'utf-8') };
  } catch {
    return { content: '' };
  }
});

ipcMain.handle('academiaFile:write', async (_event, relativePath: string, content: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) throw new Error('No active workspace');
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('Invalid path');
  }
  if (containerService.isOverlayEnabled() && containerService.isRunning()) {
    await containerService.writeContentToContainer(content, `/data/${ACADEMIA_DIR}/${normalized}`);
  } else {
    const filePath = path.join(workspaceController.workspacePath!, ACADEMIA_DIR, normalized);
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, content, 'utf-8');
  }
});

// Shell IPC handlers
ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    throw new Error('Invalid URL');
  }
  await shell.openExternal(url);
});

ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (_event, url: string) => {
  try {
    const validation = validateExternalUrl(url);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }
    await shell.openExternal(url);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.ZOTERO_LOCAL_GET_STATUS, async () => {
  const { getZoteroLocalStatus } = await import('../../zoteroLocalClient');
  try {
    const status = await getZoteroLocalStatus();
    return { success: true, status };
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error), status: 'not-running' };
  }
});

ipcMain.handle(IPC_CHANNELS.ZOTERO_LOCAL_ADD_DOI, async (_event, doi: string) => {
  if (typeof doi !== 'string' || doi.length === 0) {
    return { success: false, error: 'DOI must be a non-empty string', status: 'not-running' };
  }
  const { addDoiToZotero } = await import('../../zoteroLocalClient');
  return await addDoiToZotero(doi);
});

ipcMain.handle(IPC_CHANNELS.ZOTERO_LOCAL_GET_DOI_METADATA, async (_event, doi: string) => {
  if (typeof doi !== 'string' || doi.length === 0) return null;
  const { getDoiMetadata } = await import('../../zoteroLocalClient');
  return getDoiMetadata(doi);
});

ipcMain.handle(IPC_CHANNELS.ZOTERO_LOCAL_LIST_ADDED_DOIS, async () => {
  const { listAddedDois } = await import('../../zoteroLocalClient');
  return listAddedDois();
});

ipcMain.handle(IPC_CHANNELS.ZOTERO_LOCAL_CHECK_DOI, async (_event, doi: string) => {
  if (typeof doi !== 'string' || doi.length === 0) return null;
  const { checkDoiInZotero } = await import('../../zoteroLocalClient');
  return await checkDoiInZotero(doi);
});

// Open a Zotero item by DOI — uses the key when known so Zotero jumps
// straight to the item instead of opening the search panel.
ipcMain.handle(IPC_CHANNELS.ZOTERO_OPEN_DOI, async (_event, doi: string) => {
  if (typeof doi !== 'string' || doi.length === 0) {
    return { success: false, error: 'doi is required' };
  }
  const { openZoteroForDoi } = await import('../../zoteroLocalClient');
  await openZoteroForDoi(doi);
  return { success: true };
});

// Integration toggles (Word, Obsidian, ...). Backed by electron-store, drive
// `getRegisteredHostApps()` at startup.
import { store as appStore } from '../../appStore';
import { setHostAppRegistrationOverrides, type IntegrationId } from './hostApps';

const INTEGRATION_DEFAULTS: Record<IntegrationId, boolean> = {
  word: FEATURES.MS_WORD_INTEGRATION_ENABLED,
  obsidian: FEATURES.OBSIDIAN_INTEGRATION_ENABLED,
  'apple-notes': FEATURES.APPLE_NOTES_INTEGRATION_ENABLED,
  'google-docs': FEATURES.GOOGLE_DOCS_INTEGRATION_ENABLED,
};

function integrationStoreKey(id: IntegrationId): string {
  return `integration.${id}.enabled`;
}

function readIntegrationEnabled(id: IntegrationId): boolean {
  return appStore.get(integrationStoreKey(id), INTEGRATION_DEFAULTS[id]) as boolean;
}

// Apply persisted toggles to the host-app registry as soon as the module loads
// — must happen before windowMonitorService.start() consults the registry.
setHostAppRegistrationOverrides({
  word: readIntegrationEnabled('word'),
  obsidian: readIntegrationEnabled('obsidian'),
  'apple-notes': readIntegrationEnabled('apple-notes'),
  'google-docs': readIntegrationEnabled('google-docs'),
});

const KNOWN_INTEGRATION_IDS: ReadonlySet<IntegrationId> = new Set(['word', 'obsidian', 'apple-notes', 'google-docs']);

ipcMain.handle(IPC_CHANNELS.INTEGRATION_GET_ENABLED, async (_event, id: IntegrationId) => {
  if (!KNOWN_INTEGRATION_IDS.has(id)) return false;
  return readIntegrationEnabled(id);
});

ipcMain.handle(IPC_CHANNELS.INTEGRATION_SET_ENABLED, async (_event, id: IntegrationId, enabled: boolean) => {
  if (!KNOWN_INTEGRATION_IDS.has(id)) {
    return { success: false, error: 'unknown_integration' };
  }
  // Per-integration permission gate. The macOS Accessibility permission is
  // global to the Academia app, but we surface the request here (with copy
  // scoped to whichever toggle the user is enabling) rather than at app start.
  if (enabled && process.platform === 'darwin') {
    const granted = wordAccessibility.checkPermission();
    if (!granted) {
      // Open System Settings — user has to approve there, then come back and toggle again.
      wordAccessibility.openAccessibilitySettings();
      return {
        success: false,
        error: 'permission_required',
        integrationId: id,
      };
    }
  }
  appStore.set(integrationStoreKey(id), enabled);
  // Restart so the host-app registry, window-monitor processes, and overlay
  // configs all rehydrate cleanly. This matches how SET_ALL_APPS_MONITOR_ENABLED
  // already handles its toggle.
  if (app.isPackaged) app.relaunch();
  app.quit();
  return { success: true };
});

// Permission IPC handlers (macOS only)
ipcMain.handle(IPC_CHANNELS.CHECK_ACCESSIBILITY_PERMISSION, async () => {
  if (process.platform !== 'darwin') {
    return { success: true, hasPermission: true };
  }
  try {
    const hasPermission = wordAccessibility.checkPermission();
    return { success: true, hasPermission };
  } catch (error: any) {
    return { success: false, hasPermission: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.REQUEST_ACCESSIBILITY_PERMISSION, async () => {
  if (process.platform !== 'darwin') {
    return { success: true, hasPermission: true };
  }
  try {
    wordAccessibility.openAccessibilitySettings();
    const hasPermission = wordAccessibility.checkPermission();
    return { success: true, hasPermission };
  } catch (error: any) {
    return { success: false, hasPermission: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.RESET_ACCESSIBILITY_PERMISSION, async () => {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Only supported on macOS' };
  }
  try {
    const result = wordAccessibility.resetAndRequestPermission();
    return { success: true, ...result };
  } catch (error: any) {
    return { success: false, resetSuccess: false, error: error.message };
  }
});

// Ensure accessibility permission is granted and the window monitor is running.
// Called on-demand from the renderer right before opening the Word overlay.
let accessibilityPollTimer: ReturnType<typeof setInterval> | null = null;

ipcMain.handle(IPC_CHANNELS.OVERLAY_ENSURE_READY, async () => {
  if (process.platform !== 'darwin') {
    return { hasPermission: true, started: true };
  }
  const hasPermission = wordAccessibility.checkPermission();
  if (!hasPermission) {
    wordAccessibility.openAccessibilitySettings();
    // Poll until the user grants permission, then restart so the
    // window monitor picks up the new AX trust state cleanly.
    if (!accessibilityPollTimer) {
      accessibilityPollTimer = setInterval(() => {
        if (wordAccessibility.checkPermission()) {
          clearInterval(accessibilityPollTimer!);
          accessibilityPollTimer = null;
          log.info('[overlay:ensureReady] Accessibility permission granted — restarting app');
          if (app.isPackaged) app.relaunch();
          app.quit();
        }
      }, 2000);
    }
    return { hasPermission: false, started: false };
  }
  if (cobuildingHttpBaseUrl && cobuildingHttpAuthToken && !windowMonitorService.isRunning()) {
    windowMonitorService.start(cobuildingHttpBaseUrl, cobuildingHttpAuthToken, false);
    const activeWorkspace = workspaceController.activeWorkspace;
    if (activeWorkspace) {
      windowMonitorService.setActiveWorkspaceDirectory(activeWorkspace.directory_path);
      windowMonitorService.setSessionsProvider(({ documentPath, documentPathLike }) => {
        if (!activeWorkspace) return [];
        const rows = documentPathLike !== undefined
          ? listSessionsByDocPathLike(activeWorkspace.id, undefined, documentPathLike)
          : listSessions(activeWorkspace.id, undefined, documentPath);
        return rows.map(s => ({
          id: s.id,
          title: s.title,
          created_at: s.created_at,
          is_running: getRegisteredSession(s.id)?.isRunning ?? false,
        }));
      });
    }
    log.info('[overlay:ensureReady] Window monitor started on demand');
  }
  return { hasPermission: true, started: true };
});

// ---- Google Docs IPC handlers ----

ipcMain.handle('googleDocs:status', () => {
  return {
    connected: isGoogleDocsConnected(),
    hasCredentials: googleDocsHasCredentials(),
  };
});

ipcMain.handle('googleDocs:connect', async () => {
  try {
    await startGoogleDocsOAuth();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('googleDocs:disconnect', () => {
  disconnectGoogleDocs();
  return { success: true };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  const steps: [string, () => void][] = [
    ['globalShortcut.unregisterAll', () => globalShortcut.unregisterAll()],
    ['stopHttpsServer', stopHttpsServer],
    ['stopFileMonitor', stopFileMonitor],
    ['stopBrowserMonitor', stopBrowserMonitor],
    ['stopScheduledTasks', stopScheduledTasks],
    ['backgroundBuilder.dispose', () => backgroundBuilder.dispose()],
    ['destroyTokenManager', destroyTokenManager],
    ['destroyAllSessions', destroyAllSessions],
    ['containerService.stop', () => containerService.stop()],
    ['windowMonitorService.stop', () => windowMonitorService.stop()],
    ['closeSchedulingDatabase', closeSchedulingDatabase],
    ['closeObservationsDatabase', closeObservationsDatabase],
    ['closeDatabase', closeDatabase],
  ];
  for (const [name, fn] of steps) {
    try {
      fn();
    } catch (err) {
      log.error(`[APP] Cleanup step "${name}" failed:`, err);
    }
  }
});
