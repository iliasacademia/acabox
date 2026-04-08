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

contextBridge.exposeInMainWorld('workspacesAPI', {
  getActive: () => ipcRenderer.invoke('workspaces:getActive'),
  getDefaultDirectory: (name: string) => ipcRenderer.invoke('workspaces:getDefaultDirectory', name),
  create: (data: { name: string; directoryPath: string; apiKey: string }) =>
    ipcRenderer.invoke('workspaces:create', data),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  update: (data: { name: string; directoryPath: string; apiKey: string }) =>
    ipcRenderer.invoke('workspaces:update', data),
});

contextBridge.exposeInMainWorld('filesAPI', {
  readDirectory: (dirPath: string) => ipcRenderer.invoke('files:readDirectory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('files:readFile', filePath),
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
  selectFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('files:selectFile', filters),
  selectDirectory: () => ipcRenderer.invoke('files:selectDirectory'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onCopyProgress: (callback: (progress: { copied: number; total: number; currentName: string | null }) => void) => {
    const handler = (_event: unknown, progress: { copied: number; total: number; currentName: string | null }) => callback(progress);
    ipcRenderer.on('files:copyProgress', handler);
    return () => { ipcRenderer.removeListener('files:copyProgress', handler); };
  },
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
});

contextBridge.exposeInMainWorld('jupyterAPI', {
  startGateway: () => ipcRenderer.invoke('jupyter:startGateway'),
  stopGateway: () => ipcRenderer.invoke('jupyter:stopGateway'),
  gatewayStatus: () => ipcRenderer.invoke('jupyter:gatewayStatus'),
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


contextBridge.exposeInMainWorld('sessionsAPI', {
  list: () => ipcRenderer.invoke('sessions:list'),
  get: (id: string) => ipcRenderer.invoke('sessions:get', id),
  rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
  delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  listMessages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
});

contextBridge.exposeInMainWorld('chatAPI', {
  sendMessage: (threadId: string, text: string, attachments?: any[]) => {
    ipcRenderer.send('chat:send', { threadId, text, attachments });

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
      done = true;
      notify();
    };

    const errorHandler = (_event: any, eventThreadId: string, err: string) => {
      if (eventThreadId !== threadId) return;
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
    };

    return {
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
  },
});
