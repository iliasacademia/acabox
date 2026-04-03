import { contextBridge, ipcRenderer, webUtils } from 'electron';

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
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onCopyProgress: (callback: (progress: { copied: number; total: number; currentName: string | null }) => void) => {
    const handler = (_event: unknown, progress: { copied: number; total: number; currentName: string | null }) => callback(progress);
    ipcRenderer.on('files:copyProgress', handler);
    return () => { ipcRenderer.removeListener('files:copyProgress', handler); };
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
