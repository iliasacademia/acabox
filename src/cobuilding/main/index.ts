import { app, BrowserWindow, dialog, globalShortcut, ipcMain, net, protocol, shell, systemPreferences } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { registerFileHandlers, assertWithinWorkspace } from './fileHandlers';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { createAgentSession } from './agentSession';
import { createCalendarAgentSession } from './calendarAgentSession';
import type { CalendarMutationEvent } from './calendarAgentSession';
import { registerSession, unregisterSession, getRegisteredSession, hasSession, destroyAllSessions } from './sessionRegistry';
import type { IPCAttachment } from '../shared/types';
import { provisionWorkspace } from './skills';
import { containerService } from './containerService';
import { getAllPodmanDataPaths } from './podmanBinaries';
import { ensureClaudeBinaryReady } from './sdkBinarySetup';
import { scanWorkspaceDirectory } from './directoryScanner';
import { getReport, getLatestReport, updateReportData } from './db/reportRepository';
import { kernelGatewayService } from './kernelGatewayService';
import { initDatabase, getDatabase, closeDatabase } from './db/database';
import { initObservationsDatabase, getObservationsDatabase, closeObservationsDatabase } from './db/observationsDatabase';
import {
  listSessions,
  listSessionsByDocPathLike,
  getSession,
  createSession,
  updateSessionTitle,
  insertMessage,
  deleteSession,
  getMessages,
  findSessionForApp,
} from './db/chatRepository';
import {
  createWorkspace,
  updateWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  touchWorkspace,
  type Workspace,
} from './db/workspaceRepository';
import { setupUpdater, setupUpdaterIpcHandlers } from './updater';
import { createTray, createDockIcon, rebuildTrayMenu, setShowWindowCallback } from './tray';
import { startBrowserMonitor, stopBrowserMonitor, isBrowserMonitorRunning } from './browserMonitor';
import { browserExtensionServer } from '../../server/browserExtensionServer';
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
import { discoverApps, getEnvironmentInfo, getInstallSteps, installDepsInContainer, installDepsStreaming } from './environmentGenerator';
import { checkLogin, getCurrentUser, logout, setBaseUrl, BASE_URL } from '../../apiClient';
import { getDeviceId } from '../../utils/deviceId';
import { createCobuildingAuthSession, verifyCobuildingAuthCode } from './cobuildingAuthService';
import { fetchGatewayCredentials, getAnthropicConfig, setRefreshCallback, destroyTokenManager, type AnthropicConfig } from './cobuildingTokenManager';
import { updateApiKey } from './db/workspaceRepository';
import { createQuickChatWindow, showQuickChat, updateMainWindowRef } from './quickChat';
import { registerCalendarHandlers } from './ipc/calendar';
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
const isSmokeTest = process.argv.includes('--smoke-test');

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const DEFAULT_ACTIVITY_SUMMARY_PROMPT =
  'Complete ALL of the following steps in order:\n' +
  '\n' +
  '1. Use the activity-summary skill to add an update to today\'s daily summary with activity since the last update.\n' +
  '2. Use the reaction skill to react to the latest update only with suggestions and relevant resources. ' +
  'The reaction skill will handle creating the user-visible reaction thread and sending the notification.';

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

function ensureReactionsTask(workspaceId: string): void {
  const existing = getTaskBySessionSource(workspaceId, 'reactions-system');
  if (existing) return;
  createTask(workspaceId, 'Reactions', 'Summarizes your recent activity every 15 minutes',
    DEFAULT_ACTIVITY_SUMMARY_PROMPT, '*/15 * * * *', 'reactions-system');
  log.info('[ScheduledTasks] Reactions task created for workspace:', workspaceId);
}

function getReactionUserInstructions(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.reactionUserInstructions ?? null;
  } catch {
    return null;
  }
}

function setReactionUserInstructions(instructions: string): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.reactionUserInstructions = instructions;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function clearReactionUserInstructions(): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  delete data.reactionUserInstructions;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

type ReactionSource = 'browser' | 'file';
const DEFAULT_REACTION_SOURCES: ReactionSource[] = ['browser', 'file'];

function getReactionSources(): ReactionSource[] {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.reactionSources ?? DEFAULT_REACTION_SOURCES;
  } catch {
    return DEFAULT_REACTION_SOURCES;
  }
}

function setReactionSources(sources: ReactionSource[]): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.reactionSources = sources;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function buildReactionsPrompt(sources: ReactionSource[]): string {
  const sourceFilter = sources.length === 2 ? 'all' : sources.join(',');
  return 'Complete ALL of the following steps in order:\n' +
    '\n' +
    '1. Use the activity-summary skill to add an update to today\'s daily summary with activity since the last update. ' +
    `When querying activity, set source to "${sourceFilter}".\n` +
    '2. Use the reaction skill to react to the latest update only with suggestions and relevant resources. ' +
    'The reaction skill will handle creating the user-visible reaction thread and sending the notification.';
}

function updateReactionsTaskPrompt(workspaceId: string, sources: ReactionSource[]): void {
  const task = getTaskBySessionSource(workspaceId, 'reactions-system');
  if (!task) return;
  updateTask(task.id, { prompt: buildReactionsPrompt(sources) });
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
    return 'anthropic';
  } catch {
    return 'anthropic';
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

const MAX_WORKSPACE_NAME_LENGTH = 100;

function validateWorkspaceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Workspace name cannot be empty.');
  }
  if (trimmed.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new Error(`Workspace name cannot exceed ${MAX_WORKSPACE_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.config', '.password-store'];

function validateDirectoryPath(directoryPath: string): string {
  const resolved = path.resolve(directoryPath);
  const homeDir = app.getPath('home');

  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    throw new Error('Workspace directory must be within your home directory.');
  }

  const relative = path.relative(homeDir, resolved);
  const firstSegment = relative.split(path.sep)[0];
  if (SENSITIVE_HOME_DIRS.includes(firstSegment)) {
    throw new Error('Cannot create a workspace in a sensitive directory.');
  }

  return resolved;
}

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
let activeWorkspace: Workspace | null = null;

let cachedApiKey: string | null = null;
let cachedBaseURL: string | undefined = undefined;
let activeApiBaseUrl: string = BASE_URL;

async function refreshCredentialsForSession(): Promise<{ apiKey: string; baseURL?: string }> {
  const result = await fetchGatewayCredentials(getApiProvider() === 'cloudflare');
  cachedApiKey = result.apiKey;
  cachedBaseURL = result.baseURL;
  if (activeWorkspace) {
    updateApiKey(activeWorkspace.id, result.apiKey);
    activeWorkspace = { ...activeWorkspace, api_key: result.apiKey };
  }
  return { apiKey: result.apiKey, baseURL: result.baseURL };
}

setRefreshCallback((config: AnthropicConfig) => {
  cachedApiKey = config.apiKey;
  cachedBaseURL = config.baseURL;
  if (activeWorkspace) {
    updateApiKey(activeWorkspace.id, config.apiKey);
    activeWorkspace = { ...activeWorkspace, api_key: config.apiKey };
  }
});

// Shared edit state store — keyed by toolCallId, synced between overlay and desktop
const editStates = new Map<string, string>();

// Tracks IPC forwarding listeners per (threadId, webContentsId) to avoid duplicates.
// Both chat:subscribe and chat:send use this to ensure exactly one forwarding listener
// per session per renderer.
const forwardingListeners = new Map<string, () => void>();

function ensureForwarding(threadId: string, sender: Electron.WebContents): void {
  const key = `${threadId}:${sender.id}`;
  if (forwardingListeners.has(key)) return;

  const session = getRegisteredSession(threadId);
  if (!session) {
    log.debug(`[Forwarding] No session found for ${threadId}, skipping`);
    return;
  }

  log.debug(`[Forwarding] Setting up IPC forwarding for ${threadId}`);

  const unsubscribe = session.addListener({
    onEvent: (msg) => {
      if (sender.isDestroyed()) {
        log.debug(`[Forwarding] Dropping event for ${threadId}: sender destroyed`);
        cleanup();
        return;
      }
      sender.send('chat:event', threadId, msg);
    },
    onDone: () => {
      log.debug(`[Forwarding] Turn done for ${threadId}`);
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
  };

  forwardingListeners.set(key, cleanup);
  sender.on('destroyed', cleanup);
}

function createMainWindow(): void {
  log.info('[APP] Creating main window...');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Academia Coscientist',
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

    // Check accessibility permission on startup (macOS only)
    if (process.platform === 'darwin') {
      try {
        const hasPermission = wordAccessibility.checkPermission();
        const appInfo = wordAccessibility.getAppInfo();
        log.info('[Permissions] Accessibility permission status:', {
          granted: hasPermission,
          bundleId: appInfo.bundleId,
          teamId: appInfo.teamId,
        });
        mainWindow?.webContents.send(IPC_CHANNELS.ACCESSIBILITY_PERMISSION_STATUS, { hasPermission });
      } catch (error) {
        log.error('[Permissions] Error checking permission on startup:', error);
      }
    }
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    systemPreferences.setUserDefault('NSNavPanelExpandedStateForSaveMode2', 'boolean', true as any);
  }

  await ensureClaudeBinaryReady();

  protocol.handle('local-file', async (request) => {
    const filePath = decodeURIComponent(request.url.slice('local-file://'.length));
    const resolved = path.resolve(filePath);
    if (
      !activeWorkspace ||
      (!resolved.startsWith(activeWorkspace.directory_path + path.sep) &&
        resolved !== activeWorkspace.directory_path)
    ) {
      log.warn(`[local-file] Forbidden: "${resolved}" outside workspace`);
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
    activeWorkspace = getActiveWorkspace() ?? null;
    log.info('[APP] Active workspace:', activeWorkspace ? activeWorkspace.name : 'none');

    if (activeWorkspace) {
      migrateWorkspaceFiles(activeWorkspace.directory_path);
      provisionWorkspace(activeWorkspace.directory_path);
      containerService.writeStartContainerScript(activeWorkspace.directory_path);
    }

    createMainWindow();

    registerFileHandlers(() => activeWorkspace?.directory_path ?? null, () => mainWindow);
    initFileMonitor(() => activeWorkspace?.directory_path ?? null);
    initActivityQuery(() => activeWorkspace?.directory_path ?? null);
    initSessionFiles(() => activeWorkspace?.directory_path ?? null);
    registerCalendarHandlers(() => mainWindow);
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

    startFileMonitor();
    startBrowserMonitor().then(() => rebuildTrayMenu());
    initSchedulingDatabase(app.getPath('userData'));
    if (activeWorkspace) {
      ensureReactionsTask(activeWorkspace.id);
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
            fastify.post<{ Params: { sessionId: string }; Body: { text: string; documentPath?: string; selectedText?: string } }>(
              '/api/cobuilding/sessions/:sessionId/send',
              async (request, reply) => {
                const { sessionId } = request.params;
                const { text, documentPath: ctxDocPath, selectedText: ctxSelectedText } = request.body;
                if (!text || typeof text !== 'string') {
                  reply.code(400).send({ error: 'text is required' });
                  return;
                }
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
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    ensureForwarding(sessionId, mainWindow.webContents);
                    mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_PAGE, {
                      page: 'session',
                      sessionId,
                    } as NavigateToPagePayload);
                  }
                  const unsubscribe = existingRunning.addListener({
                    onEvent: (msg) => sendSSE('event', msg),
                    onDone: () => { sendSSE('done', {}); reply.raw.end(); unsubscribe(); notifySessionsChanged(); },
                    onError: (err) => { sendSSE('error', { error: err }); reply.raw.end(); unsubscribe(); },
                  });
                  existingRunning.sendMessage(displayMessage);
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

                const session = getRegisteredSession(sessionId)!;

                // Ensure IPC forwarding to the desktop app BEFORE sending the message,
                // so the desktop receives streaming events immediately.
                if (mainWindow && !mainWindow.isDestroyed()) {
                  ensureForwarding(sessionId, mainWindow.webContents);
                  mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_PAGE, {
                    page: 'session',
                    sessionId,
                  } as NavigateToPagePayload);
                }

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

                session.sendMessage(displayMessage);
              },
            );
          });

          const port = await httpServer.start();
          const baseUrl = httpServer.getBaseUrl();
          const authToken = httpServer.getAuthToken();
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
                }));
              });
            }
            windowMonitorService.start(baseUrl, authToken, false);
            log.info('[WindowMonitor] Started for Word overlay');
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

// Workspace IPC handlers
ipcMain.handle('workspaces:getActive', () => {
  return activeWorkspace ?? null;
});

ipcMain.handle('workspaces:getDefaultDirectory', (_event, name: string) => {
  const safeName = name.slice(0, MAX_WORKSPACE_NAME_LENGTH)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'my-workspace';
  return path.join(app.getPath('desktop'), safeName);
});

ipcMain.handle(
  'workspaces:create',
  async (_event, data: { name: string; directoryPath: string }) => {
    const name = validateWorkspaceName(data.name);
    const directoryPath = validateDirectoryPath(data.directoryPath);

    let apiKey = cachedApiKey ?? '';
    if (!apiKey) {
      try {
        const result = await fetchGatewayCredentials(getApiProvider() === 'cloudflare');
        cachedApiKey = result.apiKey;
        cachedBaseURL = result.baseURL;
        apiKey = result.apiKey;
      } catch (err) {
        log.warn('[workspaces:create] Could not fetch API key:', err);
      }
    }

    fs.mkdirSync(directoryPath, { recursive: true });
    provisionWorkspace(directoryPath);
    containerService.writeStartContainerScript(directoryPath);

    const id = randomUUID();
    createWorkspace(id, name, directoryPath, apiKey);
    touchWorkspace(id);
    activeWorkspace = getActiveWorkspace() ?? null;
    if (activeWorkspace) {
      ensureReactionsTask(activeWorkspace.id);
      const scheduler = getTaskScheduler();
      scheduler.stop();
      scheduler.start();
      // Directory scan is triggered separately via scanner:start IPC
    }
    return activeWorkspace ?? null;
  },
);

ipcMain.handle('dialog:selectDirectory', async () => {
  if (!mainWindow) return undefined;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return undefined;
  return result.filePaths[0];
});

ipcMain.handle(
  'workspaces:update',
  (_event, data: { name: string; directoryPath: string }) => {
    if (!activeWorkspace) {
      throw new Error('No active workspace to update.');
    }

    const name = validateWorkspaceName(data.name);
    const directoryPath = validateDirectoryPath(data.directoryPath);

    if (directoryPath !== activeWorkspace.directory_path) {
      // Stop containers so they restart with the new volume mount
      kernelGatewayService.stop();
      containerService.stop();

      if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { recursive: true });
      }
      provisionWorkspace(directoryPath);
      containerService.writeStartContainerScript(directoryPath);
    }

    updateWorkspace(activeWorkspace.id, name, directoryPath, cachedApiKey ?? activeWorkspace.api_key);
    activeWorkspace = getActiveWorkspace() ?? null;
    return activeWorkspace ?? null;
  },
);

ipcMain.handle('workspaces:list', () => {
  return listWorkspaces();
});

ipcMain.handle('workspaces:switch', (_event, id: string) => {
  const workspaces = listWorkspaces();
  const target = workspaces.find((w) => w.id === id);
  if (!target) throw new Error('Workspace not found.');

  backgroundBuilder.dispose();
  kernelGatewayService.stop();
  containerService.stop();

  touchWorkspace(id);
  activeWorkspace = getActiveWorkspace() ?? null;

  if (activeWorkspace) {
    ensureReactionsTask(activeWorkspace.id);
    // Update workspace directory for the Word overlay
    windowMonitorService.setActiveWorkspaceDirectory(activeWorkspace.directory_path);
  }

  // Restart scheduler so it picks up the new workspace's tasks
  const scheduler = getTaskScheduler();
  scheduler.stop();
  scheduler.start();

  provisionWorkspace(target.directory_path);
  containerService.writeStartContainerScript(target.directory_path);

  return activeWorkspace ?? null;
});

// ─── Reports IPC ──────────────────────────────────────────────────

ipcMain.handle('reports:getLatest', (_event, reportType: string) => {
  if (!activeWorkspace) return null;
  return getLatestReport(activeWorkspace.id, reportType);
});

ipcMain.handle('reports:get', (_event, reportId: string) => {
  return getReport(reportId);
});

ipcMain.handle('reports:update', (_event, reportId: string, reportData: string) => {
  updateReportData(reportId, reportData);
});

// ─── Directory Scanner IPC ──────────────────────────────────────

let scannerRunning = false;

ipcMain.handle('scanner:start', () => {
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }
  const apiKey = activeWorkspace.api_key;
  if (!apiKey) {
    throw new Error('No API key available');
  }
  if (scannerRunning) {
    log.warn('[scanner:start] Scan already in progress — ignoring duplicate request');
    return;
  }
  scannerRunning = true;

  scanWorkspaceDirectory({
    workspaceId: activeWorkspace.id,
    directoryPath: activeWorkspace.directory_path,
    apiKey,
    onMessage: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scanner:event', event);
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

function registerHostMcpServers(workspace: { id: string; directory_path: string }, onNotificationClick?: (action: any) => void) {
  // Handler maps for MCP tool calls relayed from the in-container agent.
  // Each handler matches the tool's original implementation on the host side.
  const { queryActivity } = require('./activityQuery');
  const { getWordFilePath, getWordText, getWordSelection, saveWordDocument, openWordDocument, getTrackChangesStatus, setTrackChanges } = require('../../server/wordActions');
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
          const { Notification } = require('electron');
          const notification = new Notification({ title: args.title, body: args.body });
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
      track_changes_status: async () => { try { return ok(JSON.stringify(await getTrackChangesStatus())); } catch (e: any) { return fail(String(e)); } },
      set_track_changes: async (args: any) => { try { return ok(JSON.stringify(await setTrackChanges(args.enabled))); } catch (e: any) { return fail(String(e)); } },
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

async function startAgentInfrastructure(workspacePath: string): Promise<void> {
  if (!activeWorkspace) return;

  // 0. One-time migration of session files from bundled podman HOME
  migrateHostSessionsToContainer(workspacePath);

  // 1. Copy agent server bundle and claude binary to workspace
  await containerService.ensureAgentFilesInWorkspace(workspacePath);

  // 2. Register host MCP server handlers for the SSE relay
  registerHostMcpServers(activeWorkspace);

  // 3. Write agent config and start the agent server inside the container
  const agentConfig = {
    port: 8080,
    claudeBinaryPath: '/data/.academia/claude',
    mcpServers: {},  // MCP tools are relayed via SSE, not direct HTTP
    anthropicApiKey: activeWorkspace.api_key,
    ...(cachedBaseURL ? { anthropicBaseURL: cachedBaseURL } : {}),
    model: 'claude-opus-4-7',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent',
      'NotebookEdit', 'WebSearch', 'Skill', 'TodoWrite',
      'EnterPlanMode', 'ExitPlanMode',
      'mcp__activity__query_activity',
      'mcp__mini-apps__open_mini_application',
      'mcp__notification__show_notification',
      'mcp__reaction__create_reaction_thread',
      'mcp__ms-word__get_file_path', 'mcp__ms-word__get_text',
      'mcp__ms-word__get_selection', 'mcp__ms-word__save_document',
      'mcp__ms-word__open_document', 'mcp__ms-word__find_and_replace',
      'mcp__ms-word__track_changes_status', 'mcp__ms-word__set_track_changes',
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
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }
  // Don't pass progress callback to start() — the SetupBanner is driven by
  // ensureSetup's setup:progress events only. start() may do a background
  // image rebuild which shouldn't re-show the banner.
  await containerService.start(activeWorkspace.directory_path);
  await startAgentInfrastructure(activeWorkspace.directory_path);
  // Start watching and ensure deps for all existing apps in the background.
  // Apps are marked ready as their deps are verified/installed.
  backgroundBuilder.startWatching(activeWorkspace.directory_path, (appName) => {
    ensuredApps.add(appName);
  });
});

ipcMain.handle('container:stop', async () => {
  backgroundBuilder.stopWatching();
  ensuredApps.clear();
  await stopAgentInfrastructure();
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
  await containerService.downloadBundledBinaries((stage, message, percent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('container:progress', { stage, message, percent });
  });
});

ipcMain.handle('container:getName', () => {
  return containerService.getContainerName();
});

ipcMain.handle('container:isImageBuilt', async () => {
  return containerService.isImageBuilt();
});

ipcMain.handle('container:deleteBinaries', () => {
  containerService.deleteBundledBinaries();
});

ipcMain.handle('container:deleteImage', async () => {
  await containerService.deleteImage();
});

ipcMain.handle('container:ensureSetup', async () => {
  const progressCallback = (stage: string, message: string, percent?: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('setup:progress', { stage, message, percent });
  };
  await containerService.ensureSetup(progressCallback, activeWorkspace?.directory_path);
  if (activeWorkspace) {
    await containerService.start(activeWorkspace.directory_path);
    await startAgentInfrastructure(activeWorkspace.directory_path);
    backgroundBuilder.startWatching(activeWorkspace.directory_path, (appName) => {
      ensuredApps.add(appName);
    });
  }
});

// ─── Environment IPC ──────────────────────────────────────────────

ipcMain.handle('container:getEnvironmentInfo', async () => {
  if (!activeWorkspace) return null;
  const info = getEnvironmentInfo(activeWorkspace.directory_path);
  const imageHash = await containerService.getImageEnvironmentHash();

  return {
    imageType: info.hasAnyDeps ? 'user' : 'base',
    imageHash,
    environmentHash: info.environmentHash,
    inSync: info.environmentHash != null && imageHash === info.environmentHash,
    backgroundBuildState: backgroundBuilder.getState(),
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
  if (!activeWorkspace) throw new Error('No active workspace');
  if (!containerService.isRunning()) throw new Error('Container is not running');
  if (ensuredApps.has(dirName)) {
    return { installed: [] };
  }

  // If a background install is already in progress for this app, wait for it
  // instead of starting a conflicting parallel install (avoids dpkg lock issues).
  const pending = backgroundBuilder.getPendingInstall(dirName);
  if (pending) {
    log.debug(`[ensureAppDeps] Waiting for background install of ${dirName} to finish`);
    await pending;
    ensuredApps.add(dirName);
    return { installed: ['(completed by background installer)'] };
  }

  const appsDir = path.join(activeWorkspace.directory_path, '.applications');

  const sendProgress = (payload: Record<string, unknown>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('container:installProgress', { dirName, ...payload });
    }
  };

  const results = await installDepsStreaming(
    appsDir,
    dirName,
    (cmd, onLine) => containerService.execStreaming(cmd, onLine),
    (registry, packages) => sendProgress({ type: 'step', registry, packages }),
    (line) => sendProgress({ type: 'line', line }),
  );

  // Mirror installs to Jupyter container if it's running
  const steps = getInstallSteps(appsDir, dirName);
  if (steps.length > 0) {
    const jupyterStatus = await kernelGatewayService.getStatus();
    if (jupyterStatus.running) {
      sendProgress({ type: 'step', registry: 'jupyter', packages: ['syncing to kernel...'] });
      for (const step of steps) {
        await kernelGatewayService.exec(step.command);
      }
    }
  }

  sendProgress({ type: 'done' });
  ensuredApps.add(dirName);
  return { installed: results };
});

ipcMain.handle('container:rebuildEnvironment', async () => {
  if (!activeWorkspace) throw new Error('No active workspace');
  const envDir = path.join(activeWorkspace.directory_path, '.applications', '_environment');
  fs.rmSync(envDir, { recursive: true, force: true });

  const progressCallback = (stage: string, message: string, percent?: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('container:backgroundBuild', { stage, message, percent });
    }
  };
  await containerService.rebuildImage(activeWorkspace.directory_path, progressCallback);

});

// ─── Debug: Data Management ─────────────────────────────────────

ipcMain.handle('debug:getStorageInfo', () => {
  const userData = app.getPath('userData');
  const podmanPaths = getAllPodmanDataPaths();
  return {
    environment: app.isPackaged ? 'production' : 'development',
    userData,
    podmanPaths,
  };
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

function removePath(p: string): { path: string; ok: boolean; error?: string } {
  try {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      return { path: p, ok: true };
    }
    return { path: p, ok: true };
  } catch (err) {
    return { path: p, ok: false, error: (err as Error).message };
  }
}

ipcMain.handle('debug:clearSelected', async (_event: unknown, ids: string[]) => {
  const set = new Set(ids);
  const results: string[] = [];
  const errors: string[] = [];
  const userData = app.getPath('userData');

  const ok = (label: string) => results.push(label);
  const fail = (label: string, err: string) => errors.push(`${label}: ${err}`);

  // ── Chat Sessions & Messages ──
  if (set.has('chat-sessions')) {
    try {
      const db = getDatabase();
      db.exec('DELETE FROM messages');
      db.exec('DELETE FROM sessions');
      ok('Chat sessions');
    } catch (e) { fail('Chat sessions', (e as Error).message); }
  }

  // ── Workspace Records ──
  if (set.has('workspace-records')) {
    try {
      const db = getDatabase();
      const workspaces = db.prepare('SELECT directory_path FROM workspaces').all() as { directory_path: string }[];
      // Remove .academia and .claude dirs inside each workspace
      for (const w of workspaces) {
        for (const sub of ['.academia', '.claude']) {
          const p = path.join(w.directory_path, sub);
          if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }
      }
      db.exec('DELETE FROM messages');
      db.exec('DELETE FROM sessions');
      db.exec('DELETE FROM workspaces');
      ok('Workspaces');
    } catch (e) { fail('Workspaces', (e as Error).message); }
  }

  // ── Browser Activity ──
  if (set.has('browser-activity')) {
    try {
      const db = getObservationsDatabase();
      db.exec("DELETE FROM session_files WHERE session_type = 'browser'");
      db.exec('DELETE FROM browser_sessions');
      ok('Browser activity');
    } catch (e) { fail('Browser activity', (e as Error).message); }
  }

  // ── File Activity ──
  if (set.has('file-activity')) {
    try {
      const db = getObservationsDatabase();
      db.exec("DELETE FROM session_files WHERE session_type = 'file'");
      db.exec('DELETE FROM file_sessions');
      ok('File activity');
    } catch (e) { fail('File activity', (e as Error).message); }
  }

  // ── Scheduled Tasks ──
  if (set.has('scheduled-tasks')) {
    try {
      const db = getSchedulingDatabase();
      db.exec('DELETE FROM scheduled_task_runs');
      db.exec('DELETE FROM scheduled_tasks');
      ok('Scheduled tasks');
    } catch (e) { fail('Scheduled tasks', (e as Error).message); }
  }

  // ── Task Run History ──
  if (set.has('task-runs')) {
    try {
      const db = getSchedulingDatabase();
      db.exec('DELETE FROM scheduled_task_runs');
      ok('Task run history');
    } catch (e) { fail('Task run history', (e as Error).message); }
  }

  // ── System Log ──
  if (set.has('system-log')) {
    try { systemLogger.clear(); ok('System log'); }
    catch (e) { fail('System log', (e as Error).message); }
  }

  // ── Command Log ──
  if (set.has('command-log')) {
    try { commandLogger.clear(); ok('Command log'); }
    catch (e) { fail('Command log', (e as Error).message); }
  }

  // ── App Log ──
  if (set.has('app-log')) {
    const logPath = path.join(userData, 'cobuilding.log');
    const r = removePath(logPath);
    r.ok ? ok('App log') : fail('App log', r.error!);
  }

  // ── Settings ──
  if (set.has('settings')) {
    const r = removePath(path.join(userData, 'cobuilding-settings.json'));
    r.ok ? ok('Settings') : fail('Settings', r.error!);
  }

  // ── Podman Binaries ──
  if (set.has('podman-binaries')) {
    try {
      containerService.deleteBundledBinaries();
      ok('Podman binaries');
    } catch (e) { fail('Podman binaries', (e as Error).message); }
  }

  // ── Podman Config & VM Images ──
  if (set.has('podman-config-data')) {
    const r = removePath(path.join(userData, 'cobuilding-podman-data'));
    r.ok ? ok('Podman config & data') : fail('Podman config & data', r.error!);
  }

  // ── Container Image ──
  if (set.has('container-image')) {
    try {
      await containerService.deleteImage();
      ok('Container image');
    } catch (e) { fail('Container image', (e as Error).message); }
  }

  // ── Podman VM State ──
  if (set.has('podman-vm')) {
    try { containerService.stop(); } catch { /* ok */ }
    const podmanPaths = getAllPodmanDataPaths();
    for (const p of podmanPaths) {
      if (p.label.includes('HOME') || p.label.includes('runtime')) {
        const r = removePath(p.path);
        if (!r.ok) fail(p.label, r.error!);
      }
    }
    ok('Podman VM state');
  }

  // ── Electron Cache ──
  if (set.has('electron-cache')) {
    for (const dir of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      'Local Storage', 'Session Storage', 'blob_storage', 'SharedStorage']) {
      removePath(path.join(userData, dir));
    }
    ok('Electron cache');
  }

  log.warn('[Debug] clearSelected:', { cleared: results, errors });
  return { cleared: results, errors };
});

// Jupyter kernel gateway IPC handlers
ipcMain.handle('jupyter:startGateway', async () => {
  try {
    if (!activeWorkspace) return { error: 'No active workspace' };
    return await kernelGatewayService.start(activeWorkspace.directory_path);
  } catch (err) {
    return { error: (err as Error).message };
  }
});

ipcMain.handle('jupyter:stopGateway', () => {
  kernelGatewayService.stop();
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
  () => activeWorkspace?.directory_path ?? null,
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
ipcMain.handle('sessions:get', (_event, id: string) => getSession(id));
ipcMain.handle('sessions:rename', (_event, id: string, title: string) => {
  updateSessionTitle(id, title);
  notifySessionsChanged();
});
ipcMain.handle('sessions:delete', (_event, id: string) => {
  deleteSession(id);
  const session = getRegisteredSession(id);
  if (session) {
    session.destroy();
    unregisterSession(id);
  }
  notifySessionsChanged();
});
ipcMain.handle('messages:list', (_event, sessionId: string) => getMessages(sessionId));

// Find or create a session associated with a mini app
ipcMain.handle('sessions:findForApp', (_event, dirName: string) => {
  if (!activeWorkspace) return null;

  // Search for an existing session that created or is bound to this app
  const existingId = findSessionForApp(activeWorkspace.id, dirName);
  if (existingId) return existingId;

  // No session found — create a new one with a synthetic context message
  const sessionId = randomUUID();
  const displayName = dirName.replace(/[-_]/g, ' ');
  createSession(sessionId, activeWorkspace.id);
  insertMessage(
    sessionId,
    'user',
    JSON.stringify({ text: `This chat is connected to the application "${dirName}".` }),
  );
  updateSessionTitle(sessionId, displayName);
  notifySessionsChanged();
  return sessionId;
});

async function generateSessionTitle(sessionId: string, firstMessage: string, apiKey: string, baseURL?: string): Promise<void> {
  try {
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
    if (title) {
      updateSessionTitle(sessionId, title);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sessions:titleUpdated', sessionId, title);
    }
  } catch (err) {
    log.warn('[TitleGen] Failed to generate session title:', err);
  }
}

ipcMain.on('chat:send', (event, { threadId, text, attachments, model }: { threadId: string; text: string; attachments?: IPCAttachment[]; model?: string }) => {
  if (!activeWorkspace) {
    event.sender.send('chat:error', threadId, 'No active workspace');
    return;
  }

  const existingRunning = getRegisteredSession(threadId);
  if (existingRunning?.isRunning) {
    // Session is already running (e.g. scheduled task or previous user chat).
    // Ensure IPC forwarding is set up (idempotent — won't duplicate).
    ensureForwarding(threadId, event.sender);
    existingRunning.sendMessage(text, attachments);
    return;
  }

  const isCalendarSession = threadId === 'calendar-assistant';
  let isFirstMessage = false;

  if (!hasSession(threadId)) {
    const existingDbSession = getSession(threadId);
    isFirstMessage = !existingDbSession;

    if (isCalendarSession) {
      const session = createCalendarAgentSession(
        threadId,
        activeWorkspace.id,
        activeWorkspace.api_key,
        activeWorkspace.directory_path,
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
        cachedBaseURL,
        refreshCredentialsForSession,
      );
      registerSession(threadId, session);
      event.sender.on('destroyed', () => {
        session.destroy();
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
        activeWorkspace,
        existingDbSession?.sdk_session_id ?? undefined,
        undefined,
        handleNotificationNavigation,
        model,
      );

      registerSession(threadId, session);

      event.sender.on('destroyed', () => {
        session.destroy();
        unregisterSession(threadId);
      });
    }
  }

  ensureForwarding(threadId, event.sender);
  getRegisteredSession(threadId)!.sendMessage(text, attachments);

  if (isFirstMessage && !isCalendarSession && activeWorkspace.api_key) {
    generateSessionTitle(threadId, text, activeWorkspace.api_key, cachedBaseURL);
  }
});

ipcMain.on('chat:subscribe', (event, threadId: string) => {
  ensureForwarding(threadId, event.sender);
});


ipcMain.on('chat:stop', (event, threadId: string) => {
  // Clean up the forwarding listener synchronously before destroying the session,
  // so that a subsequent chat:send can set up fresh forwarding for a new session.
  const key = `${threadId}:${event.sender.id}`;
  forwardingListeners.get(key)?.();

  const session = getRegisteredSession(threadId);
  if (session) {
    session.destroy();
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
  workspaceDir: string,
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
      const resolved = assertWithinWorkspace(source.path, workspaceDir);
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
      const resolved = assertWithinWorkspace(source.path, workspaceDir);
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

async function validateAnthropicParams(params: unknown, workspaceDir: string): Promise<{
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
      const blocks = await Promise.all(msg.content.map((b: unknown) => resolveContentBlock(b, workspaceDir)));
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
  if (!activeWorkspace?.api_key) throw new Error('No active workspace API key');
  if (!activeWorkspace.directory_path) throw new Error('No active workspace directory');
  const validated = await validateAnthropicParams(params, activeWorkspace.directory_path);
  // Log call metadata for audit purposes. Message content is intentionally
  // omitted to avoid writing user data to the log file.
  log.info('[anthropic:complete] workspace=%s model=%s max_tokens=%d messages=%d',
    activeWorkspace.id, validated.model, validated.max_tokens, validated.messages.length);
  const client = new Anthropic({ apiKey: activeWorkspace.api_key, baseURL: cachedBaseURL });
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
  if (!activeWorkspace?.api_key) {
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: 'No active workspace API key' });
    return;
  }
  if (!activeWorkspace.directory_path) {
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: 'No active workspace directory' });
    return;
  }
  let validated: Awaited<ReturnType<typeof validateAnthropicParams>>;
  try {
    validated = await validateAnthropicParams(params, activeWorkspace.directory_path);
  } catch (err) {
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: err instanceof Error ? err.message : String(err) });
    return;
  }
  log.info('[anthropic:stream] workspace=%s model=%s max_tokens=%d messages=%d',
    activeWorkspace.id, validated.model, validated.max_tokens, validated.messages.length);
  const client = new Anthropic({ apiKey: activeWorkspace.api_key, baseURL: cachedBaseURL });
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

// Auth IPC handlers
ipcMain.handle('auth:checkLogin', async () => {
  try {
    const loggedIn = await checkLogin();
    if (loggedIn && getApiProvider() !== 'custom') {
      fetchGatewayCredentials(getApiProvider() === 'cloudflare').then(({ apiKey, baseURL }) => {
        cachedApiKey = apiKey;
        cachedBaseURL = baseURL;
        if (activeWorkspace) {
          updateApiKey(activeWorkspace.id, apiKey);
          activeWorkspace = { ...activeWorkspace, api_key: apiKey };
        }
      }).catch((err) => log.warn('[Auth] fetchGatewayCredentials error:', err));
    } else if (loggedIn && getApiProvider() === 'custom') {
      const customKey = getCustomAnthropicKey();
      if (customKey) {
        cachedApiKey = customKey;
        cachedBaseURL = getCustomAnthropicBaseURL();
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
      fetchGatewayCredentials(getApiProvider() === 'cloudflare').then(({ apiKey, baseURL }) => {
        cachedApiKey = apiKey;
        cachedBaseURL = baseURL;
        if (activeWorkspace) {
          updateApiKey(activeWorkspace.id, apiKey);
          activeWorkspace = { ...activeWorkspace, api_key: apiKey };
        }
      }).catch((err) => log.warn('[Auth] fetchGatewayCredentials after verify error:', err));
    }
    return { success: true, authorized: result.authorized, userId: result.user_id };
  } catch (error: any) {
    log.error('[Auth] verifyQRCode error:', error);
    return { success: false, error: error.message || 'Verification failed' };
  }
});

ipcMain.handle('auth:getApiKey', () => {
  return { apiKey: cachedApiKey, baseURL: cachedBaseURL, provider: getApiProvider() };
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
    cachedApiKey = customKey;
    cachedBaseURL = baseURL;
    destroyTokenManager();
    if (activeWorkspace) {
      updateApiKey(activeWorkspace.id, customKey);
      activeWorkspace = { ...activeWorkspace, api_key: customKey };
    }
    log.info('[Auth] Using custom Anthropic API key');
    return { success: true };
  }

  try {
    const result = await fetchGatewayCredentials(provider === 'cloudflare');
    cachedApiKey = result.apiKey;
    cachedBaseURL = result.baseURL;
    if (activeWorkspace) {
      updateApiKey(activeWorkspace.id, result.apiKey);
      activeWorkspace = { ...activeWorkspace, api_key: result.apiKey };
    }
    return { success: true };
  } catch (error: any) {
    log.error('[Auth] Failed to fetch credentials after provider switch:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:refetchApiKey', async () => {
  try {
    const result = await fetchGatewayCredentials(getApiProvider() === 'cloudflare');
    cachedApiKey = result.apiKey;
    cachedBaseURL = result.baseURL;
    if (activeWorkspace) {
      updateApiKey(activeWorkspace.id, result.apiKey);
      activeWorkspace = getActiveWorkspace() ?? null;
    }
    log.debug('[Auth] Refetched API key successfully');
    return { success: true, keyIdentifier: result.keyIdentifier };
  } catch (error: any) {
    log.error('[Auth] refetchApiKey error:', error);
    return { success: false, error: error.message || 'Failed to refetch API key' };
  }
});

ipcMain.handle('auth:logout', async () => {
  try {
    activeWorkspace = null;
    cachedApiKey = null;
    const result = await logout();
    return result;
  } catch (error: any) {
    log.error('[Auth] logout error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:setEndpoint', (_event, endpoint: string) => {
  if (app.isPackaged) {
    return { success: false, error: 'Endpoint switching is not available in packaged builds' };
  }
  const url = endpoint === 'production' ? 'https://api.academia.edu/' : 'https://api.devdemia.com/';
  activeApiBaseUrl = url;
  setBaseUrl(url);
  log.info(`[Auth] Switched API endpoint to ${endpoint} (${url})`);
  return { success: true, endpoint };
});

// Scheduled Tasks IPC handlers
ipcMain.handle('scheduledTasks:list', () => {
  if (!activeWorkspace) return [];
  return listTasks(activeWorkspace.id);
});

ipcMain.handle('scheduledTasks:get', (_event, id: string) => {
  return getTask(id) ?? null;
});

ipcMain.handle('scheduledTasks:create', (_event, data: CreateTaskData) => {
  if (!activeWorkspace) throw new Error('No active workspace');
  const task = createTask(activeWorkspace.id, data.name, data.description, data.prompt, data.cron_expression, data.session_source ?? null);
  getTaskScheduler().scheduleTask(task.id);
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
      getTaskScheduler().scheduleTask(id);
    } else {
      getTaskScheduler().unscheduleTask(id);
    }
  }
  return task ?? null;
});

ipcMain.handle('scheduledTasks:delete', (_event, id: string) => {
  const task = getTask(id);
  if (task?.session_source === 'reactions-system') {
    throw new Error('System tasks cannot be deleted');
  }
  getTaskScheduler().unscheduleTask(id);
  deleteTask(id);
});

ipcMain.handle('scheduledTasks:setEnabled', (_event, id: string, enabled: boolean) => {
  setTaskEnabled(id, enabled);
  if (enabled) {
    getTaskScheduler().scheduleTask(id);
  } else {
    getTaskScheduler().unscheduleTask(id);
  }
});

ipcMain.handle('scheduledTasks:runNow', async (_event, id: string) => {
  if (!activeWorkspace) throw new Error('No active workspace');
  const task = getTask(id);
  if (!task) throw new Error('Task not found');
  await runScheduledTask(task, activeWorkspace, handleNotificationNavigation);
});

ipcMain.handle('scheduledTasks:listRuns', (_event, taskId: string) => {
  return listTaskRuns(taskId);
});

// Reaction prompt IPC handlers
ipcMain.handle('reactionPrompt:get', () => {
  return { instructions: getReactionUserInstructions() };
});

ipcMain.handle('reactionPrompt:set', (_event, instructions: string) => {
  setReactionUserInstructions(instructions);
});

ipcMain.handle('reactionPrompt:reset', () => {
  clearReactionUserInstructions();
});

// Reaction sources IPC handlers
ipcMain.handle('reactionSources:get', () => {
  return getReactionSources();
});

ipcMain.handle('reactionSources:set', (_event, sources: ReactionSource[]) => {
  setReactionSources(sources);
  if (activeWorkspace) {
    updateReactionsTaskPrompt(activeWorkspace.id, sources);
    // Reschedule the task so the next run uses the updated prompt
    const task = getTaskBySessionSource(activeWorkspace.id, 'reactions-system');
    if (task) {
      getTaskScheduler().scheduleTask(task.id);
    }
  }
});

// FOCUS.md IPC handlers
ipcMain.handle('focusPrompt:get', () => {
  if (!activeWorkspace) return { content: '' };
  const focusPath = path.join(activeWorkspace.directory_path, '.academia', 'FOCUS.md');
  try {
    return { content: fs.readFileSync(focusPath, 'utf-8') };
  } catch {
    return { content: '' };
  }
});

ipcMain.handle('focusPrompt:set', (_event, content: string) => {
  if (!activeWorkspace) throw new Error('No active workspace');
  const academiaDir = path.join(activeWorkspace.directory_path, '.academia');
  fs.mkdirSync(academiaDir, { recursive: true });
  fs.writeFileSync(path.join(academiaDir, 'FOCUS.md'), content, 'utf-8');
});

// SOUL.md IPC handlers
ipcMain.handle('soulPrompt:get', () => {
  if (!activeWorkspace) return { content: '' };
  const soulPath = path.join(activeWorkspace.directory_path, '.academia', 'SOUL.md');
  try {
    return { content: fs.readFileSync(soulPath, 'utf-8') };
  } catch {
    return { content: '' };
  }
});

ipcMain.handle('soulPrompt:set', (_event, content: string) => {
  if (!activeWorkspace) throw new Error('No active workspace');
  const academiaDir = path.join(activeWorkspace.directory_path, '.academia');
  fs.mkdirSync(academiaDir, { recursive: true });
  fs.writeFileSync(path.join(academiaDir, 'SOUL.md'), content, 'utf-8');
});

// Browser Monitor IPC handlers
ipcMain.handle('browserMonitor:status', () => {
  return {
    serverRunning: isBrowserMonitorRunning(),
    extensionConnected: browserExtensionServer.isConnected(),
  };
});

ipcMain.handle('browserMonitor:start', async () => {
  await startBrowserMonitor();
  rebuildTrayMenu();
});

ipcMain.handle('browserMonitor:stop', async () => {
  await stopBrowserMonitor();
  rebuildTrayMenu();
});

ipcMain.handle('browserMonitor:downloadExtension', async () => {
  const zipPath = app.isPackaged
    ? path.join(process.resourcesPath, 'extension.zip')
    : path.join(app.getAppPath(), 'browser-extension', 'extension.zip');

  if (!fs.existsSync(zipPath)) {
    return { success: false, error: 'Browser extension zip not found' };
  }

  const destDir = app.getPath('downloads');
  const destPath = path.join(destDir, 'academia-browser-extension.zip');
  fs.copyFileSync(zipPath, destPath);
  shell.showItemInFolder(destPath);
  return { success: true, path: destPath };
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
    ['kernelGatewayService.stop', () => kernelGatewayService.stop()],
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
