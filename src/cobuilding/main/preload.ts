import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, ...args: any[]) => {
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.on(channel, callback);
  },
  removeListener: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
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
  sendMessage: (threadId: string, text: string) => {
    ipcRenderer.send('chat:send', { threadId, text });

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
