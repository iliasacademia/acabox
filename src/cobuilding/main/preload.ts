import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  on: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.on(channel, callback);
  },
  removeListener: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
  },
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
});

contextBridge.exposeInMainWorld('authAPI', {
  checkLogin: () => ipcRenderer.invoke('auth:checkLogin'),
  startQRAuth: () => ipcRenderer.invoke('auth:startQRAuth'),
  verifyQRCode: (deviceId: string, code: string) =>
    ipcRenderer.invoke('auth:verifyQRCode', deviceId, code),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getApiKey: () => ipcRenderer.invoke('auth:getApiKey'),
  refetchApiKey: () => ipcRenderer.invoke('auth:refetchApiKey'),
  getApiProvider: () => ipcRenderer.invoke('auth:getApiProvider'),
  setApiProvider: (provider: string, customKey?: string, customBaseURL?: string) => ipcRenderer.invoke('auth:setApiProvider', provider, customKey, customBaseURL),
  isDev: process.env.NODE_ENV === 'development',
  setEndpoint: (endpoint: string) => ipcRenderer.invoke('auth:setEndpoint', endpoint),
  hasSessionCookie: () => ipcRenderer.invoke('auth:hasSessionCookie'),
  onDeepLinkCallback: (
    callback: (data: { verificationCode: string; deviceId: string }) => void
  ) => {
    const handler = (
      _event: unknown,
      data: { verificationCode: string; deviceId: string }
    ) => callback(data);
    ipcRenderer.on('auth:deepLinkCallback', handler);
    return () => ipcRenderer.removeListener('auth:deepLinkCallback', handler);
  },
});

contextBridge.exposeInMainWorld('workspacesAPI', {
  getActive: () => ipcRenderer.invoke('workspaces:getActive'),
  list: () => ipcRenderer.invoke('workspaces:list'),
  getDefaultDirectory: (name: string) => ipcRenderer.invoke('workspaces:getDefaultDirectory', name),
  create: (data: { name: string; directoryPath: string }) =>
    ipcRenderer.invoke('workspaces:create', data),
  switch: (id: string) => ipcRenderer.invoke('workspaces:switch', id),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  update: (data: { name: string; directoryPath: string }) =>
    ipcRenderer.invoke('workspaces:update', data),
  deleteAll: () => ipcRenderer.invoke('workspaces:deleteAll'),
});

contextBridge.exposeInMainWorld('filesAPI', {
  readDirectory: (dirPath: string) => ipcRenderer.invoke('files:readDirectory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('files:readFile', filePath),
  fileExists: (filePath: string) => ipcRenderer.invoke('files:exists', filePath),
  findByName: (filename: string, hintDirs: string[]) => ipcRenderer.invoke('files:findByName', filename, hintDirs),
  findByExtension: (extensions: string[]) => ipcRenderer.invoke('files:findByExtension', extensions),
  copyToWorkspace: (sourcePaths: string[], destinationDir: string) =>
    ipcRenderer.invoke('files:copyToWorkspace', sourcePaths, destinationDir),
  moveFile: (sourcePath: string, destinationDir: string) =>
    ipcRenderer.invoke('files:moveFile', sourcePath, destinationDir),
  deleteFile: (filePath: string) => ipcRenderer.invoke('files:deleteFile', filePath),
  createFile: (filePath: string) => ipcRenderer.invoke('files:createFile', filePath),
  createDirectory: (dirPath: string) => ipcRenderer.invoke('files:createDirectory', dirPath),
  renameFile: (filePath: string, newName: string) =>
    ipcRenderer.invoke('files:renameFile', filePath, newName),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('files:writeFile', filePath, content),
  downloadFile: (filename: string, content: string) => ipcRenderer.invoke('files:downloadFile', filename, content),
  showInFinder: (filePath: string) => ipcRenderer.invoke('files:showInFinder', filePath),
  revealInFinder: (filePath: string) => ipcRenderer.invoke('files:revealInFinder', filePath),
  selectFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('files:selectFile', filters),
  selectDirectory: () => ipcRenderer.invoke('files:selectDirectory'),
  convertImageToPng: (base64Data: string) => ipcRenderer.invoke('image:convertToPng', base64Data),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onCopyProgress: (callback: (progress: { copied: number; total: number; currentName: string | null }) => void) => {
    const handler = (_event: unknown, progress: { copied: number; total: number; currentName: string | null }) => callback(progress);
    ipcRenderer.on('files:copyProgress', handler);
    return () => { ipcRenderer.removeListener('files:copyProgress', handler); };
  },
  onWorkspaceChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('files:workspaceChanged', handler);
    return () => { ipcRenderer.removeListener('files:workspaceChanged', handler); };
  },
});

contextBridge.exposeInMainWorld('miniAppsAPI', {
  exportApp: (dirName: string) => ipcRenderer.invoke('miniApps:export', dirName),
  importApp: () => ipcRenderer.invoke('miniApps:import'),
  list: () => ipcRenderer.invoke('miniApps:list'),
  touch: (dirName: string) => ipcRenderer.invoke('miniApps:touch', dirName),
});

contextBridge.exposeInMainWorld('settingsAPI', {
  getMaxAttachmentSizeMB: () => ipcRenderer.invoke('settings:getMaxAttachmentSizeMB'),
  setMaxAttachmentSizeMB: (sizeMB: number) => ipcRenderer.invoke('settings:setMaxAttachmentSizeMB', sizeMB),
  getReactionsEnabled: () => ipcRenderer.invoke('settings:getReactionsEnabled'),
  setReactionsEnabled: (enabled: boolean) => ipcRenderer.invoke('settings:setReactionsEnabled', enabled),
});

contextBridge.exposeInMainWorld('containerAPI', {
  start: () => ipcRenderer.invoke('container:start'),
  stop: () => ipcRenderer.invoke('container:stop'),
  status: () => ipcRenderer.invoke('container:status'),
  exec: (command: string[]) => ipcRenderer.invoke('container:exec', command),
  syncOverlay: () => ipcRenderer.invoke('container:syncOverlay'),
  execLogged: (command: string[], meta?: { source?: string; appDirName?: string | null }) =>
    ipcRenderer.invoke('container:execLogged', command, meta),
  getBinaryMode: () => ipcRenderer.invoke('container:getBinaryMode'),
  setBinaryMode: (mode: string) => ipcRenderer.invoke('container:setBinaryMode', mode),
  getImageSource: () => ipcRenderer.invoke('container:getImageSource'),
  setImageSource: (source: string) => ipcRenderer.invoke('container:setImageSource', source),
  getSkipImageBuild: () => ipcRenderer.invoke('container:getSkipImageBuild'),
  setSkipImageBuild: (skip: boolean) => ipcRenderer.invoke('container:setSkipImageBuild', skip),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  getBundledStatus: () => ipcRenderer.invoke('container:getBundledStatus'),
  downloadBinaries: () => ipcRenderer.invoke('container:downloadBinaries'),
  deleteBinaries: () => ipcRenderer.invoke('container:deleteBinaries'),
  deleteImage: () => ipcRenderer.invoke('container:deleteImage'),
  downloadImage: () => ipcRenderer.invoke('container:downloadImage'),
  getName: () => ipcRenderer.invoke('container:getName'),
  isImageBuilt: () => ipcRenderer.invoke('container:isImageBuilt'),
  isBaseImageDownloaded: () => ipcRenderer.invoke('container:isBaseImageDownloaded'),
  ensureSetup: () => ipcRenderer.invoke('container:ensureSetup'),
  getEnvironmentInfo: () => ipcRenderer.invoke('container:getEnvironmentInfo'),
  appDepsReady: (dirName: string) => ipcRenderer.invoke('container:appDepsReady', dirName),
  ensureAppDeps: (dirName: string) => ipcRenderer.invoke('container:ensureAppDeps', dirName),
  getAppInstallRequests: (dirName: string) => ipcRenderer.invoke('container:getAppInstallRequests', dirName),
  rebuildEnvironment: () => ipcRenderer.invoke('container:rebuildEnvironment'),
  onSetupProgress: (callback: (progress: { stage: string; message: string; percent?: number }) => void) => {
    const handler = (_event: unknown, progress: { stage: string; message: string }) => callback(progress);
    ipcRenderer.on('setup:progress', handler);
    return () => { ipcRenderer.removeListener('setup:progress', handler); };
  },
  onProgress: (callback: (progress: { stage: string; message: string; percent?: number }) => void) => {
    const handler = (_event: unknown, progress: { stage: string; message: string }) => callback(progress);
    ipcRenderer.on('container:progress', handler);
    return () => { ipcRenderer.removeListener('container:progress', handler); };
  },
  onPackageState: (callback: (e: { registry: string; package: string; state: string }) => void) => {
    const handler = (_event: unknown, e: { registry: string; package: string; state: string }) => callback(e);
    ipcRenderer.on('installer:packageState', handler);
    return () => { ipcRenderer.removeListener('installer:packageState', handler); };
  },
  onPackageLine: (callback: (e: { registry: string; package: string; line: string }) => void) => {
    const handler = (_event: unknown, e: { registry: string; package: string; line: string }) => callback(e);
    ipcRenderer.on('installer:packageLine', handler);
    return () => { ipcRenderer.removeListener('installer:packageLine', handler); };
  },
  onBackgroundBuild: (callback: (progress: { stage: string; message: string; percent?: number }) => void) => {
    const handler = (_event: unknown, progress: { stage: string; message: string; percent?: number }) => callback(progress);
    ipcRenderer.on('container:backgroundBuild', handler);
    return () => { ipcRenderer.removeListener('container:backgroundBuild', handler); };
  },
});

contextBridge.exposeInMainWorld('jupyterAPI', {
  startGateway: () => ipcRenderer.invoke('jupyter:startGateway'),
  stopGateway: () => ipcRenderer.invoke('jupyter:stopGateway'),
  restartGateway: () => ipcRenderer.invoke('jupyter:restartGateway'),
  gatewayStatus: () => ipcRenderer.invoke('jupyter:gatewayStatus'),
  listKernels: () => ipcRenderer.invoke('jupyter:listKernels'),
  shutdownKernel: (kernelId: string) => ipcRenderer.invoke('jupyter:shutdownKernel', kernelId),
});

contextBridge.exposeInMainWorld('commandLogAPI', {
  getAll: () => ipcRenderer.invoke('commandLog:getAll'),
  getByApp: (appDirName: string) => ipcRenderer.invoke('commandLog:getByApp', appDirName),
  getAppNames: () => ipcRenderer.invoke('commandLog:getAppNames'),
  onEntry: (callback: (entry: any) => void) => {
    const handler = (_event: unknown, entry: any) => callback(entry);
    ipcRenderer.on('commandLog:entry', handler);
    return () => { ipcRenderer.removeListener('commandLog:entry', handler); };
  },
});

contextBridge.exposeInMainWorld('systemLogAPI', {
  getAll: () => ipcRenderer.invoke('systemLog:getAll'),
  onEntry: (callback: (entry: any) => void) => {
    const handler = (_event: unknown, entry: any) => callback(entry);
    ipcRenderer.on('systemLog:entry', handler);
    return () => { ipcRenderer.removeListener('systemLog:entry', handler); };
  },
});


contextBridge.exposeInMainWorld('browserMonitorAPI', {
  status: () => ipcRenderer.invoke('browserMonitor:status'),
  start: () => ipcRenderer.invoke('browserMonitor:start'),
  stop: () => ipcRenderer.invoke('browserMonitor:stop'),
  downloadExtension: () => ipcRenderer.invoke('browserMonitor:downloadExtension'),
});

contextBridge.exposeInMainWorld('fileMonitorAPI', {
  status: () => ipcRenderer.invoke('fileMonitor:status'),
  start: () => ipcRenderer.invoke('fileMonitor:start'),
  stop: () => ipcRenderer.invoke('fileMonitor:stop'),
  getTodaySessions: () => ipcRenderer.invoke('fileMonitor:getTodaySessions'),
  openFile: (fileUrl: string, bundleId?: string) => ipcRenderer.invoke('fileMonitor:openFile', fileUrl, bundleId),
  setDockRightForDocument: (documentPath: string, docked: boolean) =>
    ipcRenderer.invoke('windowMonitor:setDockRightForDocument', documentPath, docked),
  setOverlayKickoffForDocument: (documentPath: string, prompt: string) =>
    ipcRenderer.invoke('windowMonitor:setOverlayKickoffForDocument', documentPath, prompt),
  requestNewOverlayChatForDocument: (documentPath: string) =>
    ipcRenderer.invoke('windowMonitor:requestNewOverlayChatForDocument', documentPath),
  navigateOverlayToSession: (sessionId: string) =>
    ipcRenderer.invoke('windowMonitor:navigateOverlayToSession', sessionId),
});

contextBridge.exposeInMainWorld('observationsAPI', {
  getBrowserSessions: () => ipcRenderer.invoke('observations:getBrowserSessions'),
  getFileSessions: () => ipcRenderer.invoke('observations:getFileSessions'),
  getSessionFiles: () => ipcRenderer.invoke('observations:getSessionFiles'),
});

contextBridge.exposeInMainWorld('debugAPI', {
  getStorageInfo: () => ipcRenderer.invoke('debug:getStorageInfo'),
  clearSelected: (ids: string[]) => ipcRenderer.invoke('debug:clearSelected', ids),
  exportWorkspace: () => ipcRenderer.invoke('debug:exportWorkspace'),
  importWorkspace: () => ipcRenderer.invoke('debug:importWorkspace'),
  hardResetWorkspace: () => ipcRenderer.invoke('debug:hardResetWorkspace'),
  exportLogs: () => ipcRenderer.invoke('debug:exportLogs'),
  syncOverlay: () => ipcRenderer.invoke('debug:syncOverlay'),
  isOverlayEnabled: () => ipcRenderer.invoke('debug:isOverlayEnabled'),
  log: (msg: string) => ipcRenderer.invoke('debug:log', msg),
});

contextBridge.exposeInMainWorld('calendarAPI', {
  listGroups: () => ipcRenderer.invoke('calendar:listGroups'),
  createGroup: (data: unknown) => ipcRenderer.invoke('calendar:createGroup', data),
  updateGroup: (id: string, data: unknown) => ipcRenderer.invoke('calendar:updateGroup', id, data),
  deleteGroup: (id: string) => ipcRenderer.invoke('calendar:deleteGroup', id),
  getGroupTimeRange: (id: string) => ipcRenderer.invoke('calendar:getGroupTimeRange', id),

  listEvents: (opts?: unknown) => ipcRenderer.invoke('calendar:listEvents', opts),
  createEvent: (data: unknown) => ipcRenderer.invoke('calendar:createEvent', data),
  updateEvent: (id: string, data: unknown) => ipcRenderer.invoke('calendar:updateEvent', id, data),
  deleteEvent: (id: string) => ipcRenderer.invoke('calendar:deleteEvent', id),

  addEventFile: (eventId: string, filePath: string) => ipcRenderer.invoke('calendar:addEventFile', eventId, filePath),
  listEventFiles: (eventId: string) => ipcRenderer.invoke('calendar:listEventFiles', eventId),
  removeEventFile: (id: number) => ipcRenderer.invoke('calendar:removeEventFile', id),
  addGroupFile: (groupId: string, filePath: string) => ipcRenderer.invoke('calendar:addGroupFile', groupId, filePath),
  listGroupFiles: (groupId: string, includeFromEvents?: boolean) => ipcRenderer.invoke('calendar:listGroupFiles', groupId, includeFromEvents),
  removeGroupFile: (id: number) => ipcRenderer.invoke('calendar:removeGroupFile', id),

  listResources: (opts?: unknown) => ipcRenderer.invoke('calendar:listResources', opts),
  createResource: (data: unknown) => ipcRenderer.invoke('calendar:createResource', data),
  updateResource: (id: string, data: unknown) => ipcRenderer.invoke('calendar:updateResource', id, data),
  deleteResource: (id: string) => ipcRenderer.invoke('calendar:deleteResource', id),
  openResourceFile: (filePath: string) => ipcRenderer.invoke('calendar:openResourceFile', filePath),
  openResourceUrl: (url: string) => ipcRenderer.invoke('calendar:openResourceUrl', url),
  revealResourceFile: (filePath: string) => ipcRenderer.invoke('calendar:revealResourceFile', filePath),
  pickResourceFile: () => ipcRenderer.invoke('calendar:pickResourceFile'),
  moveResource: (id: string, data: unknown) => ipcRenderer.invoke('calendar:moveResource', id, data),
  listWorkspaceFiles: () => ipcRenderer.invoke('calendar:listWorkspaceFiles'),

  listDependencies: () => ipcRenderer.invoke('calendar:listDependencies'),
  createDependency: (data: unknown) => ipcRenderer.invoke('calendar:createDependency', data),
  updateDependency: (id: string, data: unknown) => ipcRenderer.invoke('calendar:updateDependency', id, data),
  deleteDependency: (id: string) => ipcRenderer.invoke('calendar:deleteDependency', id),
  moveEventWithCascade: (id: string, newStartAt: string, newEndAt: string) => ipcRenderer.invoke('calendar:moveEventWithCascade', id, newStartAt, newEndAt),
  adjustBuffer: (depId: string, newLagCurrentMs: number) => ipcRenderer.invoke('calendar:adjustBuffer', depId, newLagCurrentMs),
  onCalendarMutation: (callback: (mutation: unknown) => void): (() => void) => {
    const handler = (_event: unknown, mutation: unknown) => callback(mutation);
    ipcRenderer.on('calendar:mutation', handler);
    return () => { ipcRenderer.removeListener('calendar:mutation', handler); };
  },

});

contextBridge.exposeInMainWorld('googleDocsAPI', {
  status: () => ipcRenderer.invoke('googleDocs:status'),
  connect: () => ipcRenderer.invoke('googleDocs:connect'),
  disconnect: () => ipcRenderer.invoke('googleDocs:disconnect'),
});

contextBridge.exposeInMainWorld('scheduledTasksAPI', {
  list: () => ipcRenderer.invoke('scheduledTasks:list'),
  get: (id: string) => ipcRenderer.invoke('scheduledTasks:get', id),
  create: (data: { name: string; description: string; prompt: string; cron_expression: string }) =>
    ipcRenderer.invoke('scheduledTasks:create', data),
  update: (id: string, data: { name?: string; description?: string; prompt?: string; cron_expression?: string; enabled?: number }) =>
    ipcRenderer.invoke('scheduledTasks:update', id, data),
  delete: (id: string) => ipcRenderer.invoke('scheduledTasks:delete', id),
  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('scheduledTasks:setEnabled', id, enabled),
  runNow: (id: string) => ipcRenderer.invoke('scheduledTasks:runNow', id),
  listRuns: (taskId: string) => ipcRenderer.invoke('scheduledTasks:listRuns', taskId),
});

contextBridge.exposeInMainWorld('reactionPromptAPI', {
  get: () => ipcRenderer.invoke('reactionPrompt:get'),
  set: (instructions: string) => ipcRenderer.invoke('reactionPrompt:set', instructions),
  reset: () => ipcRenderer.invoke('reactionPrompt:reset'),
});

contextBridge.exposeInMainWorld('reactionSourcesAPI', {
  get: () => ipcRenderer.invoke('reactionSources:get'),
  set: (sources: string[]) => ipcRenderer.invoke('reactionSources:set', sources),
});

contextBridge.exposeInMainWorld('academiaFileAPI', {
  read: (relativePath: string) => ipcRenderer.invoke('academiaFile:read', relativePath),
  write: (relativePath: string, content: string) => ipcRenderer.invoke('academiaFile:write', relativePath, content),
});

contextBridge.exposeInMainWorld('reportsAPI', {
  getLatest: (reportType: string) => ipcRenderer.invoke('reports:getLatest', reportType),
  get: (reportId: string) => ipcRenderer.invoke('reports:get', reportId),
  update: (reportId: string, reportData: string) =>
    ipcRenderer.invoke('reports:update', reportId, reportData),
});

contextBridge.exposeInMainWorld('papersAPI', {
  fetch: (input: { topics: string[]; maxPerTopic?: number; maxTotal?: number }) =>
    ipcRenderer.invoke('papers:fetch', input),
});

contextBridge.exposeInMainWorld('briefingsAPI', {
  list: (filter?: { status?: string[]; limit?: number }) =>
    ipcRenderer.invoke('briefings:list', filter),
  setStatus: (id: string, status: string) =>
    ipcRenderer.invoke('briefings:setStatus', id, status),
  /** Fires whenever briefings are created, updated, or change status. */
  onChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('briefings:changed', handler);
    return () => { ipcRenderer.removeListener('briefings:changed', handler); };
  },
});

contextBridge.exposeInMainWorld('scannedFilesAPI', {
  getByType: (fileType: string) => ipcRenderer.invoke('scannedFiles:getByType', fileType),
  getAll: () => ipcRenderer.invoke('scannedFiles:getAll'),
});

contextBridge.exposeInMainWorld('scannerAPI', {
  start: () => ipcRenderer.invoke('scanner:start'),
  onEvent: (callback: (event: any) => void) => {
    const handler = (_event: unknown, data: any) => callback(data);
    ipcRenderer.on('scanner:event', handler);
    return () => {
      ipcRenderer.removeListener('scanner:event', handler);
    };
  },
});

contextBridge.exposeInMainWorld('sessionsAPI', {
  list: (source?: string) => ipcRenderer.invoke('sessions:list', source),
  getRunningIds: () => ipcRenderer.invoke('sessions:runningIds') as Promise<string[]>,
  get: (id: string) => ipcRenderer.invoke('sessions:get', id),
  setDocumentPath: (id: string, documentPath: string) =>
    ipcRenderer.invoke('sessions:setDocumentPath', id, documentPath),
  countForDocument: (documentPath: string) =>
    ipcRenderer.invoke('sessions:countForDocument', documentPath) as Promise<number>,
  rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
  delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  listMessages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
  findForApp: (dirName: string) => ipcRenderer.invoke('sessions:findForApp', dirName) as Promise<string | null>,
  onTitleUpdated: (callback: (sessionId: string, title: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, title: string) => callback(sessionId, title);
    ipcRenderer.on('sessions:titleUpdated', handler);
    return () => { ipcRenderer.removeListener('sessions:titleUpdated', handler); };
  },
  onSessionsChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('sessions:changed', handler);
    return () => { ipcRenderer.removeListener('sessions:changed', handler); };
  },
  /**
   * Fires after a turn completes for `sessionId` in any surface (desktop
   * or overlay). Emitted by the main process's SSE fanout (`ensureSseFanout`'s
   * onDone). The desktop chat panel uses this to refetch its history when
   * the active thread matches — closes the gap where an overlay-typed user
   * message stays missing on the desktop because chat:event only carries
   * assistant-side stream events, not the user message that prompted them.
   */
  onForeignTurnDone: (callback: (sessionId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on('chat:foreign-done', handler);
    return () => { ipcRenderer.removeListener('chat:foreign-done', handler); };
  },
});

// Track active stream iterators per threadId to clean up stale ones
const activeStreams = new Map<string, () => void>();

// Buffer events that arrive before a stream iterator is created for a threadId.
// This prevents lost events when the overlay sends a message and the main process
// sets up IPC forwarding before the renderer has subscribed.
//
// Capped at EVENT_BUFFER_CAP per thread (drop-oldest) so an abandoned threadId
// — one that gets events but never creates a stream iterator — can't leak
// memory indefinitely. 2000 is comfortably above any plausible single turn
// (a long tool-heavy turn is ~hundreds of events) while staying bounded.
const eventBuffers = new Map<string, { events: any[]; done: boolean; error?: string }>();
const EVENT_BUFFER_CAP = 2000;

ipcRenderer.on('chat:event', (_event: any, threadId: string, token: any) => {
  if (token?.type === 'turn-complete') {
    console.log(`[Preload:buffer] turn-complete arrived, activeStream=${activeStreams.has(threadId)}`);
  }
  if (activeStreams.has(threadId)) return; // Active stream handles these
  console.warn(`[Preload:buffer] Buffering event type=${token?.type} for ${threadId} (no active stream)`);
  const buf = eventBuffers.get(threadId) || { events: [], done: false };
  buf.events.push(token);
  if (buf.events.length > EVENT_BUFFER_CAP) {
    buf.events.shift();
  }
  eventBuffers.set(threadId, buf);
});
ipcRenderer.on('chat:done', (_event: any, threadId: string) => {
  console.log(`[Preload:buffer] chat:done arrived, activeStream=${activeStreams.has(threadId)}`);
  if (activeStreams.has(threadId)) return;
  console.warn(`[Preload:buffer] Buffering chat:done for ${threadId} (no active stream)`);
  const buf = eventBuffers.get(threadId) || { events: [], done: false };
  buf.done = true;
  eventBuffers.set(threadId, buf);
});
ipcRenderer.on('chat:error', (_event: any, threadId: string, err: string) => {
  if (activeStreams.has(threadId)) return;
  const buf = eventBuffers.get(threadId) || { events: [], done: false };
  buf.done = true;
  buf.error = err;
  eventBuffers.set(threadId, buf);
});

function createStreamIterator(threadId: string) {
  // Clean up any existing stream iterator for this threadId
  if (activeStreams.has(threadId)) {
    console.debug(`[StreamIterator] Replacing existing stream for ${threadId}`);
  }
  activeStreams.get(threadId)?.();

  // Drain any buffered events that arrived before this stream was created
  const buffered = eventBuffers.get(threadId);
  eventBuffers.delete(threadId);

  const pending: any[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  if (buffered) {
    const types = buffered.events.map((e: any) => e?.type).join(',');
    console.warn(`[StreamIterator] Draining ${buffered.events.length} buffered events for ${threadId}: [${types}] done=${buffered.done}`);
    for (const token of buffered.events) {
      pending.push({ value: token, done: false });
    }
    if (buffered.error) {
      pending.push({ value: null, done: true, error: buffered.error });
      done = true;
    } else if (buffered.done) {
      done = true;
    }
  }

  const notify = () => {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  };

  const eventHandler = (_event: any, eventThreadId: string, token: any) => {
    if (eventThreadId !== threadId) return;
    if (token?.type === 'turn-complete') {
      console.log(`[StreamIterator] turn-complete received, pending=${pending.length}, done=${done}`);
    }
    pending.push({ value: token, done: false });
    notify();
  };

  const doneHandler = (_event: any, eventThreadId: string) => {
    if (eventThreadId !== threadId) return;
    console.warn(`[StreamIterator] chat:done received for ${threadId}, pending=${pending.length}`);
    done = true;
    notify();
  };

  const errorHandler = (_event: any, eventThreadId: string, err: string) => {
    if (eventThreadId !== threadId) return;
    console.debug(`[StreamIterator] Stream error for ${threadId}: ${err}`);
    pending.push({ value: null, done: true, error: err });
    done = true;
    notify();
  };

  ipcRenderer.on('chat:event', eventHandler);
  ipcRenderer.on('chat:done', doneHandler);
  ipcRenderer.on('chat:error', errorHandler);

  // Declared with let so cleanup can reference markDone for an ownership check.
  // Without the check, a stale cleanup (e.g. from useSessionSubscription's
  // unsubscribe after sendMessage replaced the stream) would delete the newer
  // stream's activeStreams entry, causing the global buffer listeners to capture
  // events that the live stream should be handling.
  let markDone!: () => void;

  const cleanup = () => {
    ipcRenderer.removeListener('chat:event', eventHandler);
    ipcRenderer.removeListener('chat:done', doneHandler);
    ipcRenderer.removeListener('chat:error', errorHandler);
    if (activeStreams.get(threadId) === markDone) {
      activeStreams.delete(threadId);
    }
  };

  markDone = () => {
    done = true;
    cleanup();
    notify();
  };

  activeStreams.set(threadId, markDone);

  const stream = {
    next: () => {
      if (pending.length > 0) {
        const item = pending.shift();
        if (item.done) cleanup();
        if (item.error) return Promise.reject(new Error(item.error));
        return Promise.resolve(item);
      }

      if (done) {
        cleanup();
        return Promise.resolve({ value: null, done: true });
      }

      return new Promise<any>((r, reject) => {
        resolve = () => {
          if (pending.length > 0) {
            const item = pending.shift();
            if (item.done) cleanup();
            if (item.error) {
              reject(new Error(item.error));
            } else {
              r(item);
            }
          } else if (done) {
            cleanup();
            r({ value: null, done: true });
          }
        };
      });
    },
  };

  return { stream, markDone };
}

contextBridge.exposeInMainWorld('chatAPI', {
  onQuickChatInject: (callback: (data: { text: string; context: any }) => void) => {
    const handler = (_event: unknown, data: { text: string; context: any }) => callback(data);
    ipcRenderer.on('quick-chat:inject', handler);
    return () => { ipcRenderer.removeListener('quick-chat:inject', handler); };
  },
  sendMessage: async (threadId: string, text: string, attachments?: any[], model?: string, documentPath?: string, messageId?: string) => {
    // Acknowledged send: invoke either resolves (main accepted the send) or
    // rejects (main refused — e.g. no active workspace). Events that arrive
    // during the round-trip are captured by the global chat:event listener
    // into eventBuffers and drained when the stream iterator is created
    // below, so no events are lost between ack and subscription.
    await ipcRenderer.invoke('chat:send', { threadId, text, attachments, model, documentPath, messageId });
    return createStreamIterator(threadId).stream;
  },
  subscribe: (threadId: string) => {
    // Always ensure main-process forwarding is set up
    ipcRenderer.send('chat:subscribe', threadId);

    if (activeStreams.has(threadId)) {
      // sendMessage already owns a primary stream for this thread.
      // Return an immediately-done stream so the subscription defers to chatAdapter
      // instead of creating a competing consumer.
      console.debug(`[StreamIterator] subscribe: deferring to existing primary stream for ${threadId}`);
      const noop = () => { };
      return {
        stream: { next: () => Promise.resolve({ value: null, done: true as const }) } as any,
        unsubscribe: noop,
      };
    }

    const { stream, markDone } = createStreamIterator(threadId);
    return { stream, unsubscribe: () => { markDone(); } };
  },
  stopResponding: (threadId: string) => {
    activeStreams.get(threadId)?.();
    ipcRenderer.send('chat:stop', threadId);
  },
});

// Edit state API — used by suggestion cards in the desktop app
contextBridge.exposeInMainWorld('editStatesAPI', {
  applyEdit: (params: { toolCallId: string; document_path?: string; search_text: string; replacement_text: string; replace_scope?: string; match_case?: boolean }) =>
    ipcRenderer.invoke('edit-state:apply', params),
  setState: (toolCallId: string, state: string) =>
    ipcRenderer.invoke('edit-state:set', { toolCallId, state }),
  getAll: () =>
    ipcRenderer.invoke('edit-state:get-all'),
});

// All streaming Anthropic responses share a single IPC channel
// ('anthropic:stream:event') and are demultiplexed by streamKey here rather
// than using per-request dynamic channel names (e.g. 'chunk:req-123'). One
// persistent listener is cheaper than registering and cleaning up three
// listeners per request, and eliminates the risk of stale listener accumulation
// if a stream's cleanup path is missed.
const anthropicStreamHandlers = new Map<string, (ev: { type: string; payload: unknown }) => void>();
ipcRenderer.on('anthropic:stream:event', (_event, msg: { streamKey: string; type: string; payload: unknown }) => {
  anthropicStreamHandlers.get(msg.streamKey)?.(msg);
});

contextBridge.exposeInMainWorld('officeAddinAPI', {
  status: () => ipcRenderer.invoke('officeAddin:status'),
  startServer: () => ipcRenderer.invoke('officeAddin:startServer'),
  stopServer: () => ipcRenderer.invoke('officeAddin:stopServer'),
  sideload: () => ipcRenderer.invoke('officeAddin:sideload'),
  remove: () => ipcRenderer.invoke('officeAddin:remove'),
  trustCert: () => ipcRenderer.invoke('officeAddin:trustCert'),
  removeCert: () => ipcRenderer.invoke('officeAddin:removeCert'),
  deleteCert: () => ipcRenderer.invoke('officeAddin:deleteCert'),
});

contextBridge.exposeInMainWorld('academiaAPI', {
  fetch: (method: string, endpoint: string, data?: unknown) =>
    ipcRenderer.invoke('academia:fetch', { method, endpoint, data }),
});

contextBridge.exposeInMainWorld('nativeToolsAPI', {
  getUrl: (toolId: string) => ipcRenderer.invoke('nativeTools:getUrl', toolId),
});

contextBridge.exposeInMainWorld('anthropicAPI', {
  complete: (params: unknown) => ipcRenderer.invoke('anthropic:complete', params),

  stream: (
    streamKey: string,
    params: unknown,
    onChunk: (text: string) => void,
    onDone: (message: unknown) => void,
    onError: (err: string) => void,
  ) => {
    // cleanup removes the handler from the map once the stream reaches a
    // terminal state (done or error). It is also returned so the caller can
    // abort early if needed (e.g. component unmount before the stream finishes).
    const cleanup = () => anthropicStreamHandlers.delete(streamKey);
    anthropicStreamHandlers.set(streamKey, ({ type, payload }) => {
      if (type === 'chunk') onChunk(payload as string);
      else if (type === 'done') { cleanup(); onDone(payload); }
      else if (type === 'error') { cleanup(); onError(payload as string); }
    });
    ipcRenderer.send('anthropic:stream', { streamKey, params });
    return cleanup;
  },
});
