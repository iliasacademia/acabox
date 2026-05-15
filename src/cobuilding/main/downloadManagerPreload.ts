import { contextBridge, ipcRenderer } from 'electron';

export type StepName = 'podman-download' | 'podman-setup' | 'machine' | 'image-download' | 'image-setup';
export type StepStatus = 'pending' | 'active' | 'done' | 'error';

export interface StepProgress {
  step: StepName;
  status: StepStatus;
  message: string;
  percent?: number;
}

export interface SetupStatus {
  podmanDownload: 'done' | 'needed' | 'partial';
  podmanSetup: 'done' | 'needed';
  machine: 'done' | 'needed';
  imageDownload: 'done' | 'needed' | 'partial';
  imageSetup: 'done' | 'needed';
  currentTier: 'core' | 'full' | null;
}

contextBridge.exposeInMainWorld('downloadManagerAPI', {
  getStatus: (): Promise<SetupStatus> => ipcRenderer.invoke('dm:getStatus'),
  startDownloads: (tier: 'core' | 'full'): Promise<void> => ipcRenderer.invoke('dm:startDownloads', tier),
  retryStep: (step: StepName): Promise<void> => ipcRenderer.invoke('dm:retryStep', step),
  clearAndRetryAll: (): Promise<void> => ipcRenderer.invoke('dm:clearAndRetryAll'),
  continue: (): Promise<void> => ipcRenderer.invoke('dm:continue'),

  onProgress: (callback: (progress: StepProgress) => void) => {
    const handler = (_event: unknown, progress: StepProgress) => callback(progress);
    ipcRenderer.on('dm:progress', handler);
    return () => { ipcRenderer.removeListener('dm:progress', handler); };
  },

  onError: (callback: (error: { step: StepName; message: string }) => void) => {
    const handler = (_event: unknown, error: { step: StepName; message: string }) => callback(error);
    ipcRenderer.on('dm:error', handler);
    return () => { ipcRenderer.removeListener('dm:error', handler); };
  },
});
