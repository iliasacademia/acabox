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
});

contextBridge.exposeInMainWorld('filesAPI', {
  readDirectory: (dirPath: string) => ipcRenderer.invoke('files:readDirectory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('files:readFile', filePath),
  fileExists: (filePath: string) => ipcRenderer.invoke('files:exists', filePath),
  findByName: (filename: string, hintDirs: string[]) => ipcRenderer.invoke('files:findByName', filename, hintDirs),
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
});

contextBridge.exposeInMainWorld('settingsAPI', {
  getMaxAttachmentSizeMB: () => ipcRenderer.invoke('settings:getMaxAttachmentSizeMB'),
  setMaxAttachmentSizeMB: (sizeMB: number) => ipcRenderer.invoke('settings:setMaxAttachmentSizeMB', sizeMB),
  getOpenAIKey: () => ipcRenderer.invoke('settings:getOpenAIKey'),
  setOpenAIKey: (key: string) => ipcRenderer.invoke('settings:setOpenAIKey', key),
});

contextBridge.exposeInMainWorld('containerAPI', {
  start: () => ipcRenderer.invoke('container:start'),
  stop: () => ipcRenderer.invoke('container:stop'),
  status: () => ipcRenderer.invoke('container:status'),
  exec: (command: string[]) => ipcRenderer.invoke('container:exec', command),
  execLogged: (command: string[], meta?: { source?: string; appDirName?: string | null }) =>
    ipcRenderer.invoke('container:execLogged', command, meta),
  getBinaryMode: () => ipcRenderer.invoke('container:getBinaryMode'),
  setBinaryMode: (mode: string) => ipcRenderer.invoke('container:setBinaryMode', mode),
  getImageSource: () => ipcRenderer.invoke('container:getImageSource'),
  setImageSource: (source: string) => ipcRenderer.invoke('container:setImageSource', source),
  getBundledStatus: () => ipcRenderer.invoke('container:getBundledStatus'),
  downloadBinaries: () => ipcRenderer.invoke('container:downloadBinaries'),
  deleteBinaries: () => ipcRenderer.invoke('container:deleteBinaries'),
  deleteImage: () => ipcRenderer.invoke('container:deleteImage'),
  getName: () => ipcRenderer.invoke('container:getName'),
  isImageBuilt: () => ipcRenderer.invoke('container:isImageBuilt'),
  ensureSetup: () => ipcRenderer.invoke('container:ensureSetup'),
  getEnvironmentInfo: () => ipcRenderer.invoke('container:getEnvironmentInfo'),
  appDepsReady: (dirName: string) => ipcRenderer.invoke('container:appDepsReady', dirName),
  ensureAppDeps: (dirName: string) => ipcRenderer.invoke('container:ensureAppDeps', dirName),
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
  onInstallProgress: (callback: (progress: { dirName: string; type: string; registry?: string; packages?: string[]; line?: string }) => void) => {
    const handler = (_event: unknown, progress: { dirName: string; type: string; registry?: string; packages?: string[]; line?: string }) => callback(progress);
    ipcRenderer.on('container:installProgress', handler);
    return () => { ipcRenderer.removeListener('container:installProgress', handler); };
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
});

contextBridge.exposeInMainWorld('observationsAPI', {
  getBrowserSessions: () => ipcRenderer.invoke('observations:getBrowserSessions'),
  getFileSessions: () => ipcRenderer.invoke('observations:getFileSessions'),
  getSessionFiles: () => ipcRenderer.invoke('observations:getSessionFiles'),
});

contextBridge.exposeInMainWorld('debugAPI', {
  getStorageInfo: () => ipcRenderer.invoke('debug:getStorageInfo'),
  clearSelected: (ids: string[]) => ipcRenderer.invoke('debug:clearSelected', ids),
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

contextBridge.exposeInMainWorld('soulPromptAPI', {
  get: () => ipcRenderer.invoke('soulPrompt:get'),
  set: (content: string) => ipcRenderer.invoke('soulPrompt:set', content),
});

contextBridge.exposeInMainWorld('focusPromptAPI', {
  get: () => ipcRenderer.invoke('focusPrompt:get'),
  set: (content: string) => ipcRenderer.invoke('focusPrompt:set', content),
});

contextBridge.exposeInMainWorld('notesAPI', {
  listDays: () => ipcRenderer.invoke('notes:listDays'),
  readDay: (day: string) => ipcRenderer.invoke('notes:readDay', day),
  sendAudioChunk: (chunkBase64: string, dayFile: string) => {
    ipcRenderer.send('notes:audioChunk', { chunkBase64, dayFile });
  },
  stopRecording: () => {
    ipcRenderer.send('notes:stopRecording');
  },
  onTranscription: (callback: (data: { text: string; dayFile: string }) => void) => {
    const handler = (_event: unknown, data: { text: string; dayFile: string }) => callback(data);
    ipcRenderer.on('notes:transcription', handler);
    return () => { ipcRenderer.removeListener('notes:transcription', handler); };
  },
  onTranscriptionError: (callback: (error: string) => void) => {
    const handler = (_event: unknown, error: string) => callback(error);
    ipcRenderer.on('notes:transcriptionError', handler);
    return () => { ipcRenderer.removeListener('notes:transcriptionError', handler); };
  },
  onSpeechDetected: (callback: (active: boolean) => void) => {
    const handler = (_event: unknown, active: boolean) => callback(active);
    ipcRenderer.on('notes:speechDetected', handler);
    return () => { ipcRenderer.removeListener('notes:speechDetected', handler); };
  },
  onTranscribingChange: (callback: (active: boolean) => void) => {
    const startHandler = () => callback(true);
    const endHandler = () => callback(false);
    ipcRenderer.on('notes:transcribingStart', startHandler);
    ipcRenderer.on('notes:transcribingEnd', endHandler);
    return () => {
      ipcRenderer.removeListener('notes:transcribingStart', startHandler);
      ipcRenderer.removeListener('notes:transcribingEnd', endHandler);
    };
  },
  getAssistantMessages: (dayFile: string) => ipcRenderer.invoke('notes:assistantMessages', dayFile),
  onAssistantMessage: (callback: (data: { dayFile: string; request: string; response: string }) => void) => {
    const handler = (_event: unknown, data: { dayFile: string; request: string; response: string }) => callback(data);
    ipcRenderer.on('notes:assistantMessage', handler);
    return () => { ipcRenderer.removeListener('notes:assistantMessage', handler); };
  },
  onAssistantAnalyzing: (callback: (data: { dayFile: string; analyzing: boolean }) => void) => {
    const handler = (_event: unknown, data: { dayFile: string; analyzing: boolean }) => callback(data);
    ipcRenderer.on('notes:assistantAnalyzing', handler);
    return () => { ipcRenderer.removeListener('notes:assistantAnalyzing', handler); };
  },
  onAssistantError: (callback: (data: { dayFile: string; error: string }) => void) => {
    const handler = (_event: unknown, data: { dayFile: string; error: string }) => callback(data);
    ipcRenderer.on('notes:assistantError', handler);
    return () => { ipcRenderer.removeListener('notes:assistantError', handler); };
  },
});

contextBridge.exposeInMainWorld('sessionsAPI', {
  list: (source?: string) => ipcRenderer.invoke('sessions:list', source),
  get: (id: string) => ipcRenderer.invoke('sessions:get', id),
  rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
  delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  listMessages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
  findForApp: (dirName: string) => ipcRenderer.invoke('sessions:findForApp', dirName) as Promise<string | null>,
  onTitleUpdated: (callback: (sessionId: string, title: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, title: string) => callback(sessionId, title);
    ipcRenderer.on('sessions:titleUpdated', handler);
    return () => { ipcRenderer.removeListener('sessions:titleUpdated', handler); };
  },
});

contextBridge.exposeInMainWorld('writingAgentAPI', {
  isLinked: () => ipcRenderer.invoke('writingAgent:isLinked'),
  link: () => ipcRenderer.invoke('writingAgent:link'),
  unlink: () => ipcRenderer.invoke('writingAgent:unlink'),
  refresh: () => ipcRenderer.invoke('writingAgent:refresh'),
  listProjects: () => ipcRenderer.invoke('writingAgent:listProjects'),
  getProjectFiles: (projectId: number) => ipcRenderer.invoke('writingAgent:getProjectFiles', projectId),
  listConversations: (projectId: number) => ipcRenderer.invoke('writingAgent:listConversations', projectId),
  getConversationDetail: (conversationId: number, projectId: number) =>
    ipcRenderer.invoke('writingAgent:getConversationDetail', conversationId, projectId),
  continueConversation: (conversationId: number, projectId: number) =>
    ipcRenderer.invoke('writingAgent:continueConversation', conversationId, projectId),
  listSupportingFiles: () => ipcRenderer.invoke('writingAgent:listSupportingFiles'),
});

// Track active stream iterators per threadId to clean up stale ones
const activeStreams = new Map<string, () => void>();

function createStreamIterator(threadId: string) {
  // Clean up any existing stream iterator for this threadId
  if (activeStreams.has(threadId)) {
    console.debug(`[StreamIterator] Replacing existing stream for ${threadId}`);
  }
  activeStreams.get(threadId)?.();

  const pending: any[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const notify = () => {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  };

  const eventHandler = (_event: any, eventThreadId: string, token: any) => {
    if (eventThreadId !== threadId) return;
    pending.push({ value: token, done: false });
    notify();
  };

  const doneHandler = (_event: any, eventThreadId: string) => {
    if (eventThreadId !== threadId) return;
    console.debug(`[StreamIterator] Stream done for ${threadId}`);
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

  const cleanup = () => {
    ipcRenderer.removeListener('chat:event', eventHandler);
    ipcRenderer.removeListener('chat:done', doneHandler);
    ipcRenderer.removeListener('chat:error', errorHandler);
    activeStreams.delete(threadId);
  };

  const markDone = () => {
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
  sendMessage: (threadId: string, text: string, attachments?: any[], model?: string) => {
    ipcRenderer.send('chat:send', { threadId, text, attachments, model });
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
      const noop = () => {};
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
