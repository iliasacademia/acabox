import { app, BrowserWindow, dialog, globalShortcut, ipcMain, net, protocol, shell, systemPreferences } from 'electron';
import { WorkspaceController } from './controllers/WorkspaceController';
import { AgentInfrastructureController } from './controllers/AgentInfrastructureController';
import { miniAppMcpRegistry } from './miniAppMcpRegistry';
import { registerWorkspaceHandlers } from './ipc/workspaceIpc';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { registerFileHandlers, assertWithinAllowedDirs } from './fileHandlers';
import { registerSystemStatsHandlers } from './systemStats';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { createAgentSession } from './agentSession';
import { createCalendarAgentSession } from './calendarAgentSession';
import type { CalendarMutationEvent } from './calendarAgentSession';
import { registerSession, unregisterSession, getRegisteredSession, hasSession, destroyAllSessions, addSubscriber, removeSubscriber } from './sessionRegistry';
import type { IPCAttachment } from '../shared/types';
import { provisionWorkspace } from './skills';
import { containerService } from './containerService';
import { processCpuMonitor } from '../../utils/processCpuMonitor';
import { convertReferenceFile } from './directoryScanner/agents/fileTagging';
import { getReport, getLatestReport, updateReportData } from './db/reportRepository';
import {
  listBriefings,
  setBriefingStatus,
  type BriefingStatus,
  type ListBriefingsFilter,
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
import { listWorkspaceDirectories } from './db/workspaceRepository';
import { setupUpdater, setupUpdaterIpcHandlers } from './updater';
import { createTray, createDockIcon, rebuildTrayMenu, setShowWindowCallback } from './tray';
import { BriefingsController } from './controllers/BriefingsController';
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
import { getEnvironmentInfo, getInstallSteps } from './environmentGenerator';
import { packageInstaller, installStepsToRequests, type Registry, type PackageState } from './packageInstaller';
import { setBaseUrl, BASE_URL } from '../../apiClient';
import { getDeviceId } from '../../utils/deviceId';
import { destroyTokenManager, getCredentials, setCredentials } from './cobuildingTokenManager';
import { createQuickChatWindow, showQuickChat, updateMainWindowRef } from './quickChat';
import { registerCalendarHandlers } from './ipc/calendar';
import { registerDebugHandlers } from './ipc/debug';
import { registerReactionsHandlers, getReactionsEnabled, ensureReactionsTask } from './ipc/reactions';
import { FEATURES, IPC_CHANNELS, NavigateToPagePayload } from '../../shared/types';
import { validateExternalUrl } from '../../utils/urlValidation';
import { ACADEMIA_DIR, AGENT_MEMORY_SUBDIR, REFERENCES_SUBDIR, REFERENCES_INDEX } from '../shared/paths';
import { initSentryMain } from './sentry';
import { captureError } from '../shared/telemetry';
import {
  initAnalytics,
  registerAnalyticsIpc,
  startHeartbeat as startAnalyticsHeartbeat,
  track as trackAnalyticsEvent,
} from './coscientistAnalytics';
const isSmokeTest = process.argv.includes('--smoke-test');

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

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

/**
 * Resolve the Anthropic API key the app should use. There is no login: the key
 * comes from the ANTHROPIC_API_KEY env var (useful for dev via .env.local) if
 * set, otherwise from the key the user saved in Settings (settings.json).
 */
function resolveApiKey(): { apiKey: string | null; baseURL: string | undefined } {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, baseURL: process.env.ANTHROPIC_BASE_URL?.trim() || undefined };
  }
  return { apiKey: getCustomAnthropicKey(), baseURL: getCustomAnthropicBaseURL() };
}

/**
 * Resolve the key (env → settings) and push it into the in-memory credential
 * store that getCredentials() serves. Called at boot before the agent starts,
 * and again whenever the user saves a new key so it takes effect live.
 */
function loadCredentialsIntoStore(): { apiKey: string | null; baseURL: string | undefined } {
  const c = resolveApiKey();
  setCredentials(c.apiKey, c.baseURL);
  return c;
}

// Configure electron-log for cobuilding — write to userData so dev/prod logs are separated
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'cobuilding.log');
log.transports.file.level = 'debug';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v' + app.getVersion() + '] [{level}] {text}';
log.transports.console.level = app.isPackaged ? false : 'debug';

import { systemLogger } from './systemLogger';

let _handlingFatalError = false;
process.on('uncaughtException', (error) => {
  if (_handlingFatalError) return;
  _handlingFatalError = true;
  try {
    captureError(error, { subsystem: 'main_uncaught' });
    log.error('[FATAL] Uncaught exception:', error);
  } finally {
    _handlingFatalError = false;
  }
});

process.on('unhandledRejection', (reason) => {
  if (_handlingFatalError) return;
  _handlingFatalError = true;
  try {
    captureError(reason, { subsystem: 'main_unhandled_rejection' });
    log.error('[FATAL] Unhandled rejection:', reason);
  } finally {
    _handlingFatalError = false;
  }
});

app.setName('Acabox');
app.setPath('userData', path.join(app.getPath('appData'), 'acabox', app.isPackaged ? 'production' : 'development'));

// Init the system logger only after userData is redirected above — it caches
// the log-file path at init time, so initializing earlier would pin it to the
// default (productName) dir instead of acabox/<channel>.
systemLogger.init();

// Initialize Sentry after userData path is set so native minidumps land in the right directory.
// Passing the installation_id puts a stable identity on Sentry's scope so "Users" counts
// are non-zero on every issue. No-op if SENTRY_DSN is empty (e.g. local dev without DSN).
initSentryMain(getDeviceId());

// Electron-level process-gone events. These cover renderer / utility / GPU processes —
// not Podman or the kernel gateway, which are tracked separately at their spawn sites.
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return;
  const err = new Error(
    `child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
  );
  captureError(err, {
    subsystem: 'child_process',
    extra: {
      process_type: details.type,
      reason: details.reason,
      exit_code: details.exitCode,
      service_name: details.serviceName,
      name: details.name,
    },
  });
  log.warn('[APP] child-process-gone:', details);
});

app.on('render-process-gone', (_event, _webContents, details) => {
  if (details.reason === 'clean-exit') return;
  const err = new Error(
    `render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`
  );
  captureError(err, {
    subsystem: 'render_process',
    extra: { reason: details.reason, exit_code: details.exitCode },
  });
  log.warn('[APP] render-process-gone:', details);
});

let mainWindow: BrowserWindow | null = null;

function sendProgressTo(channel: string) {
  return (stage: string, message: string, percent?: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, { stage, message, percent });
    }
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
  // Re-read the user's key (env → settings) so a key updated in Settings
  // mid-session is picked up. No academia gateway anymore.
  const { apiKey, baseURL } = loadCredentialsIntoStore();
  if (!apiKey) throw new Error('No Anthropic API key configured. Add one in Settings.');
  return { apiKey, baseURL };
}

let inflightCredentialRefresh: Promise<boolean> | null = null;
// The key most recently handed to the agent (seeded with the boot key, updated
// on each successful push). The agent's 401 retry calls refreshAndPushCredentials;
// if the re-resolved key is the SAME one already tried, there is nothing new to
// try, so we report failure and let the caller surface "key rejected" instead of
// restarting the turn forever on the same bad key.
let lastPushedApiKey: string | null = null;

async function refreshAndPushCredentials(): Promise<boolean> {
  if (inflightCredentialRefresh) return inflightCredentialRefresh;
  inflightCredentialRefresh = (async () => {
    try {
      const { apiKey, baseURL } = loadCredentialsIntoStore();
      if (!apiKey) return false;
      if (apiKey === lastPushedApiKey) return false; // unchanged → nothing to retry
      const ok = await containerService.updateAgentCredentials(apiKey, baseURL);
      if (ok) lastPushedApiKey = apiKey;
      return ok;
    } catch (err) {
      log.error('[CredentialRefresh] Refresh and push failed:', err);
      return false;
    } finally {
      inflightCredentialRefresh = null;
    }
  })();
  return inflightCredentialRefresh;
}

const briefingsController = new BriefingsController({
  workspaceController,
  getCredentials,
  ensureCredentials: () => { loadCredentialsIntoStore(); return Promise.resolve(); },
  onBriefingsChanged: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('briefings:changed');
    }
  },
  onScannerEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scanner:event', event);
    }
  },
});

const agentInfrastructure = new AgentInfrastructureController({
  workspaceController,
  containerService,
  refreshCredentials: refreshCredentialsForSession,
  onNotificationClick: handleNotificationNavigation,
});

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
    title: 'Acabox',
    show: false,
    // The renderer draws its own 40px window-chrome bar (Command Desk design);
    // native traffic lights sit inset inside it. The bar is the drag region.
    titleBarStyle: 'hiddenInset',
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

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error('[APP] Window failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log.info('[APP] Window did-finish-load.');
  });
}

app.whenReady().then(async () => {
  processCpuMonitor.start();

  // No login: load the user's Anthropic API key (env → settings) into the
  // credential store before anything spawns the agent, so getCredentials() is
  // populated without any auth flow. If none is set, the renderer routes the
  // user to the Settings key-entry screen.
  const bootCreds = loadCredentialsIntoStore();
  // The agent gets this key directly via its start config, so record it as the
  // last-pushed key — a 401 on this exact key then terminates cleanly instead
  // of looping (see refreshAndPushCredentials).
  lastPushedApiKey = bootCreds.apiKey;
  log.info(
    bootCreds.apiKey
      ? `[Auth] Loaded Anthropic API key from ${process.env.ANTHROPIC_API_KEY ? 'env' : 'settings'}`
      : '[Auth] No Anthropic API key configured — user must add one in Settings',
  );

  // Only in packaged builds: under `npm start` the process runs as the stock
  // Electron dev binary (bundle id com.github.Electron), so this write would
  // land in the shared com.github.Electron preferences domain that every
  // Electron project's dev runs — including the original app's — share.
  if (process.platform === 'darwin' && app.isPackaged) {
    systemPreferences.setUserDefault('NSNavPanelExpandedStateForSaveMode2', 'boolean', true as any);
  }

  // Analytics stays gated off: there is no login to flip the auth gate, so
  // track() is a no-op and nothing is posted to academia. Kept wired so it can
  // be re-enabled later against a fork-owned backend if desired.
  initAnalytics();
  registerAnalyticsIpc();
  startAnalyticsHeartbeat();

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
    }

    createMainWindow();

    registerFileHandlers(() => workspaceController.allAllowedPaths, () => mainWindow);
    registerSystemStatsHandlers();
    initFileMonitor(() => workspaceController.workspacePath);
    initActivityQuery(() => workspaceController.workspacePath);
    initSessionFiles(() => workspaceController.workspacePath);
    registerCalendarHandlers(() => mainWindow);
    registerDebugHandlers();

    // Mini-app MCP publishing
    ipcMain.handle('miniAppMcp:register', (event, payload: {
      serverName: string;
      dirName: string;
      tools: import('./miniAppMcpRegistry').MiniAppToolDef[];
      iframeRouteKey: string;
    }) => {
      miniAppMcpRegistry.register({
        serverName: payload.serverName,
        dirName: payload.dirName,
        tools: payload.tools,
        iframeRouteKey: payload.iframeRouteKey,
        hostWebContents: event.sender,
      });
    });
    ipcMain.handle('miniAppMcp:unregister', (_event, serverName: string) => {
      miniAppMcpRegistry.unregister(serverName);
    });
    ipcMain.handle('miniAppMcp:unregisterByRoute', (_event, iframeRouteKey: string) => {
      miniAppMcpRegistry.unregisterByRoute(iframeRouteKey);
    });
    ipcMain.handle('miniAppMcp:list', () => miniAppMcpRegistry.list());
    ipcMain.handle('miniAppMcp:callTool', async (_event, serverName: string, toolName: string, args: unknown) => {
      return miniAppMcpRegistry.invoke(serverName, toolName, args);
    });
    ipcMain.on('miniAppMcp:result', (_event, payload: { invocationId: string; result?: unknown; error?: string }) => {
      miniAppMcpRegistry.resolveInvocation(payload.invocationId, { result: payload.result, error: payload.error });
    });
    ipcMain.handle('miniApps:build', async (_event, dirName: string) => {
      const workspacePath = workspaceController.workspacePath;
      if (!workspacePath) {
        return { ok: false, error: 'No active workspace', exitCode: 1 };
      }
      const { buildMiniApp } = await import('./miniAppBuilder');
      return buildMiniApp(workspacePath, dirName);
    });
    registerWorkspaceHandlers(workspaceController, () => mainWindow, containerService);
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
    // Alt+Shift+A rather than the original app's Alt+Shift+Space, so the two
    // apps don't fight over one OS-wide exclusive hotkey when both are running.
    const shortcutRegistered = globalShortcut.register('Alt+Shift+A', () => {
      showQuickChat();
    });
    if (!shortcutRegistered) {
      log.warn('[APP] Failed to register global shortcut Alt+Shift+A — may be in use by another app');
    } else {
      log.info('[APP] Global shortcut Alt+Shift+A registered');
    }

    initSchedulingDatabase(app.getPath('userData'));
    if (getReactionsEnabled() && activeWorkspace) {
      ensureReactionsTask(activeWorkspace.id);
      const rTask = getTaskBySessionSource(activeWorkspace.id, 'reactions-system');
      if (rTask && !rTask.enabled) setTaskEnabled(rTask.id, true);
    }
    startScheduledTasks(handleNotificationNavigation);

    if (isSmokeTest) {
      log.info('[SMOKE TEST] All services started — shutting down');
      console.log('[SMOKE TEST] All services started — shutting down');
      app.quit();
      return;
    }
  } catch (error) {
    log.error('[APP] Fatal error during startup:', error);
    dialog.showErrorBox(
      'Acabox - Startup Error',
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
  async (_event, data: { name: string; directoryPaths: string[] }) => {
    let apiKey = getCredentials().apiKey ?? '';
    if (!apiKey) {
      apiKey = loadCredentialsIntoStore().apiKey ?? '';
    }
    const activeWorkspace = await workspaceController.create(data.directoryPaths, apiKey);
    if (activeWorkspace) {
      if (getReactionsEnabled()) {
        ensureReactionsTask(activeWorkspace.id);
      }
      const scheduler = getTaskScheduler();
      scheduler?.stop();
      scheduler?.start();
      // Directory scan is triggered separately via scanner:start IPC
    }
    if (!activeWorkspace) return null;
    return {
      ...activeWorkspace,
      directory_path: workspaceController.workspacePath,
      user_directory_paths: workspaceController.userDirectoryPaths,
    };
  },
);

ipcMain.handle('debug:restartOnboarding', async () => {
  backgroundBuilder.dispose();
  ensuredApps.clear();
  packageInstaller.reset();
  await agentInfrastructure.stop();
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

// ─── Briefings IPC ──────────────────────────────────────────────

ipcMain.handle(
  'briefings:list',
  (_event, filter?: ListBriefingsFilter) => {
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

ipcMain.handle('scannedFiles:getAll', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  const files = getScannedFiles(activeWorkspace.id);

  let refIndex: Record<string, string> = {};
  try {
    const indexPath = path.join(workspaceController.workspacePath, REFERENCES_SUBDIR, REFERENCES_INDEX);
    const raw = await fsPromises.readFile(indexPath, 'utf-8');
    refIndex = JSON.parse(raw);
  } catch { /* no index yet */ }

  return files.map((f) => ({
    ...f,
    ...(f.file_type === 'reference' && refIndex[f.file_path]
      ? { markdown_path: `${REFERENCES_SUBDIR}/${refIndex[f.file_path]}` }
      : {}),
  }));
});

ipcMain.handle(
  'scannedFiles:updateTag',
  async (_event, filePath: string, fileName: string, fileType: string) => {
    const activeWorkspace = workspaceController.activeWorkspace;
    if (!activeWorkspace) return;
    updateFileTag(activeWorkspace.id, filePath, fileName, fileType);

    if (fileType === 'reference') {
      const sourceDir = workspaceController.userDirectories[0]?.directory_path;
      if (!sourceDir) return;
      let { apiKey, baseURL } = getCredentials();
      if (!apiKey) {
        ({ apiKey, baseURL } = loadCredentialsIntoStore());
        if (!apiKey) return;
      }
      convertReferenceFile({
        filePath,
        sourceDir,
        workspacePath: path.join(workspaceController.workspacePath, ACADEMIA_DIR),
        apiKey: apiKey ?? '',
        baseURL,
      }).catch((err) => log.error('[scannedFiles:updateTag] Reference conversion failed:', err));
    }
  },
);

ipcMain.handle('scannedFiles:removeTag', (_event, filePath: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return;
  removeFileTag(activeWorkspace.id, filePath);
});

// ─── Directory Scanner IPC ──────────────────────────────────────

ipcMain.handle('scanner:start', () => briefingsController.runInitialWorkspaceScan());


// Container IPC handlers
ipcMain.handle('container:start', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }
  const agentDir = workspaceController.workspacePath;
  await containerService.start(workspaceController.mountMap);
  await agentInfrastructure.start(agentDir);
  backgroundBuilder.startWatching(agentDir, (appName) => {
    ensuredApps.add(appName);
  });
});

ipcMain.handle('container:stop', async () => {
  backgroundBuilder.stopWatching();
  ensuredApps.clear();
  packageInstaller.reset();
  await agentInfrastructure.stop();
  containerService.stop();
});

ipcMain.handle('container:status', () => {
  return { running: containerService.isRunning() };
});

ipcMain.handle('container:exec', async (_event, command: string[]) => {
  return containerService.exec(command);
});

ipcMain.handle('container:execLogged', async (_event, command: string[], meta?: { source?: string; appDirName?: string | null }) => {
  return containerService.execLogged(command, meta as any);
});

ipcMain.handle('settings:getMaxAttachmentSizeMB', () => {
  return getMaxAttachmentSizeMB();
});

ipcMain.handle('settings:setMaxAttachmentSizeMB', (_event, sizeMB: number) => {
  setMaxAttachmentSizeMB(sizeMB);
});

ipcMain.handle('container:ensureSetup', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  const setupAgentDir = workspaceController.workspacePath;
  await containerService.ensureSetup(makeSetupProgress(), setupAgentDir);
  if (activeWorkspace) {
    await containerService.start(workspaceController.mountMap);
    await agentInfrastructure.start(setupAgentDir);
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

  return {
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
  const ready = ensuredApps.has(dirName);
  log.debug(`[appDepsReady] ${dirName}: ${ready}`);
  return ready;
});

ipcMain.handle('container:ensureAppDeps', async (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) throw new Error('No active workspace');
  if (!containerService.isRunning()) throw new Error('Container is not running');
  if (ensuredApps.has(dirName)) {
    log.debug(`[ensureAppDeps] ${dirName}: already ensured, skipping`);
    return { installed: [] };
  }

  // PackageInstaller dedups against any package currently installing (started
  // by BackgroundBuilder at workspace open, or the agent's install wrapper).
  // Concurrent ensureDeps calls for the same packages share state — no
  // duplicate downloads, no races on /opt/venv.
  const ensureDepsAppsDir = path.join(workspaceController.workspacePath!, '.applications');
  const steps = getInstallSteps(ensureDepsAppsDir, dirName);
  if (steps.length === 0) {
    log.debug(`[ensureAppDeps] ${dirName}: no install steps, marking ready`);
    ensuredApps.add(dirName);
    return { installed: [] };
  }

  log.info(`[ensureAppDeps] ${dirName}: waiting for ${steps.length} install steps`);
  await packageInstaller.ensureDeps(installStepsToRequests(steps, dirName));
  log.info(`[ensureAppDeps] ${dirName}: all deps installed, marking ready`);
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

ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.handle('app:relaunch', () => {
  if (app.isPackaged) {
    app.relaunch();
  }
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

const backgroundBuilder = new BackgroundBuilder();

commandLogger.onEntry((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('commandLog:entry', entry);
  }
  // When the install wrapper succeeds, mark the app's deps as ensured
  if (entry.exitCode === 0 && entry.command.join(' ').includes('.applications/install') && entry.appDirName) {
    ensuredApps.add(entry.appDirName);
  }
});

// System log IPC handlers
ipcMain.handle('systemLog:getAll', () => systemLogger.getAll());

systemLogger.onEntry((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('systemLog:entry', entry);
  }
});

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


// Observations IPC handlers
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

// Per-thread creation_prompt slots. Indexed by chat thread_id (== sessionId
// in this codebase, see chat:send). Populated by the renderer via
// tool:setThreadCreationPrompt when chatAdapter detects manage_mini_app.mjs
// in the agent's tool-call args, with the user message that triggered it.
// Consumed by tool:opened when creation_pending=true: it resolves the tool's
// creating thread via manifest.chatSessionId (using findSessionForApp as a
// fallback if the manifest doesn't have it yet) and looks up the map by
// that id. Per-thread keying is what makes concurrent background builds work.
//
// 30-min freshness window covers the chat → agent → manifest →
// user-opens-tool path. Stale entries are dropped lazily on read.
const PENDING_TIMEOUT_MS = 30 * 60 * 1000;
interface ThreadPrompt {
  prompt: string;
  set_at: number;
}
const promptByThread = new Map<string, ThreadPrompt>();

function takeFresh<T extends { set_at: number }>(
  map: Map<string, T>,
  key: string,
): T | null {
  const entry = map.get(key);
  if (!entry) return null;
  map.delete(key);
  return Date.now() - entry.set_at <= PENDING_TIMEOUT_MS ? entry : null;
}

const MAX_PROMPT_BYTES = 16 * 1024;
ipcMain.handle('tool:setThreadCreationPrompt', (_event, threadId: string, prompt: string) => {
  if (typeof threadId !== 'string' || !threadId) return;
  if (typeof prompt !== 'string' || prompt.length === 0) return;
  // truncatePayload in analytics trims further if the envelope is still
  // over budget after wrapping. NOTE: slice() counts UTF-16 code units, not
  // bytes — multi-byte chars may yield a slightly larger byte length, but
  // the downstream truncator handles the final 5KB cap.
  const trimmed =
    Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES
      ? prompt.slice(0, MAX_PROMPT_BYTES)
      : prompt;
  promptByThread.set(threadId, { prompt: trimmed, set_at: Date.now() });
});

// Fires tool.created exactly once per tool (gated on the creation_pending
// flag that manage_mini_app.mjs writes at scaffold time) and tool.opened on
// every open. The flag — not "manifest lacks tool_id" — is the positive
// creation signal; the latter conflates fresh tools with tools predating
// instrumentation, which produced spurious tool.created events for old tools
// on their first post-upgrade open. Pre-existing tools now get a lazy-minted
// tool_id silently, no tool.created fired.
//
// The creation prompt is keyed by the creating chat thread_id: tool:opened
// resolves the tool's chatSessionId (== thread_id) by reading the manifest,
// falling back to findSessionForApp (which searches messages for the dirName)
// if the link hasn't been written yet. promptByThread is looked up by that
// id and consumed.
ipcMain.handle('tool:opened', async (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace || !dirName) return null;
  if (dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) return null;
  if (!workspaceController.workspacePath) return null;

  const manifestPath = path.join(workspaceController.workspacePath, '.applications', dirName, 'manifest.json');

  let manifest: Record<string, unknown> = {};
  try {
    const raw = await fsPromises.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') manifest = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable — treat as a fresh tool and mint everything.
  }

  const existingToolId = typeof manifest.tool_id === 'string' ? manifest.tool_id : null;
  const tool_id = existingToolId ?? randomUUID();
  if (!existingToolId) manifest.tool_id = tool_id;

  // Strip creation_pending synchronously so a race-y second open can't double-fire.
  const creationPending = manifest.creation_pending === true;
  if (creationPending) delete manifest.creation_pending;

  const existingCreatedAt = typeof manifest.created_at === 'string' ? manifest.created_at : null;
  const createdAtMs = existingCreatedAt ? new Date(existingCreatedAt).getTime() : Date.now();
  if (!existingCreatedAt) manifest.created_at = new Date(createdAtMs).toISOString();

  const priorOpenCount = typeof manifest.open_count === 'number' ? manifest.open_count : 0;
  const openCountSoFar = priorOpenCount + 1;
  manifest.open_count = openCountSoFar;

  // Resolve chatSessionId for attribution lookup. Prefer manifest, fall back
  // to findSessionForApp (matches assistant open_mini_application messages or
  // synthetic user "connected to the application" markers). Persist the
  // resolved id back to the manifest so future opens skip the search.
  let chatSessionId = typeof manifest.chatSessionId === 'string' ? manifest.chatSessionId : null;
  if (!chatSessionId) {
    const found = findSessionForApp(activeWorkspace.id, dirName);
    if (found) {
      chatSessionId = found;
      manifest.chatSessionId = found;
    }
  }

  // If the write fails, mint/flag/counter mutations don't persist; emitting
  // analytics anyway would mean the next open re-fires tool.created with a
  // fresh UUID, duplicating the event.
  try {
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  } catch (err) {
    log.warn('[tool:opened] Failed to write manifest, suppressing analytics:', err);
    return null;
  }

  const daysSinceCreated = Math.max(
    0,
    Math.floor((Date.now() - createdAtMs) / (1000 * 60 * 60 * 24)),
  );

  if (creationPending) {
    const promptEntry = chatSessionId ? takeFresh(promptByThread, chatSessionId) : null;

    const toolType = manifest.preBuilt === true
      ? 'prebuilt'
      : (typeof manifest.tool_type === 'string' ? manifest.tool_type : 'user');

    const creationPrompt = promptEntry?.prompt ?? '';

    trackAnalyticsEvent({
      name: 'tool.created',
      metadata: {
        tool_id,
        creation_source: 'chat',
        name: typeof manifest.name === 'string' ? manifest.name : '',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        creation_prompt: creationPrompt,
        tool_type: toolType,
      },
    });
  }

  trackAnalyticsEvent({
    name: 'tool.opened',
    metadata: {
      tool_id,
      days_since_created: daysSinceCreated,
      open_count_so_far: openCountSoFar,
    },
  });

  return { tool_id, open_count_so_far: openCountSoFar, days_since_created: daysSinceCreated };
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
    }
  } catch (err: any) {
    const { apiKey, baseURL } = getCredentials();
    log.warn(`[TitleGen] Failed sessionId=${sessionId} hasApiKey=${!!apiKey} baseURL=${baseURL ?? '(default)'}`);
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
        refreshAndPushCredentials,
      );

      // Default 'ui': subscriber tracking via ensureForwarding handles
      // destroy when every surface detaches.
      registerSession(threadId, session);
    }
  }

  ensureForwarding(threadId, event.sender);
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

ipcMain.handle('edit-state:apply', async (_event, _params: any) => {
  return { success: false, error: 'No host apps are registered in this build.' };
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
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-fable-5',
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
  if (!completeApiKey) throw new Error('No Anthropic API key configured. Add one in Settings.');
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
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: 'No Anthropic API key configured. Add one in Settings.' });
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

ipcMain.handle('nativeTools:getUrl', async (_event, _toolId: string) => {
  return null;
});

ipcMain.handle('academia:fetch', async (_event, args: { method: string; endpoint: string; data?: unknown }) => {
  const { callBackendApi } = require('../../apiCall');
  return callBackendApi({ method: args.method as any, endpoint: args.endpoint, data: args.data });
});

// Auth IPC handlers
ipcMain.handle('auth:getApiKey', () => {
  const { apiKey, baseURL } = getCredentials();
  return { apiKey, baseURL };
});

// Boot gate for the renderer: does a usable Anthropic key exist (env or
// settings)? Never returns the key itself. `source` lets Settings show where
// the active key comes from (env keys are read-only from the UI's view).
ipcMain.handle('auth:getApiKeyStatus', () => {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  const { apiKey, baseURL } = resolveApiKey();
  return {
    hasKey: !!apiKey,
    source: envKey ? 'env' : (getCustomAnthropicKey() ? 'settings' : null),
    baseURL: baseURL ?? null,
  };
});

ipcMain.handle('auth:setApiKey', async (_event, key: string, baseURL?: string) => {
  const trimmed = (key || '').trim();
  if (!trimmed) return { success: false, error: 'API key is required' };
  // An ANTHROPIC_API_KEY env var overrides settings, so saving here would have
  // no visible effect — say so rather than silently no-op.
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      success: false,
      error: 'ANTHROPIC_API_KEY is set in the environment and takes precedence. Unset it to manage the key here.',
    };
  }
  const url = baseURL?.trim() || undefined;
  setCustomAnthropicKey(trimmed, url);
  setCredentials(trimmed, url);
  // Push to an already-running agent server so a pasted key takes effect
  // without an app restart.
  await refreshAndPushCredentials().catch((err) => log.warn('[Auth] push new key to agent failed:', err));
  log.info('[Auth] Anthropic API key updated from Settings');
  return { success: true };
});

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
  await runScheduledTask(task, activeWorkspace, handleNotificationNavigation, refreshAndPushCredentials);
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  const steps: [string, () => void][] = [
    ['globalShortcut.unregisterAll', () => globalShortcut.unregisterAll()],
    ['stopFileMonitor', stopFileMonitor],
    ['stopScheduledTasks', stopScheduledTasks],
    ['backgroundBuilder.dispose', () => backgroundBuilder.dispose()],
    ['destroyTokenManager', destroyTokenManager],
    ['destroyAllSessions', destroyAllSessions],
    ['containerService.stop', () => containerService.stop()],
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
