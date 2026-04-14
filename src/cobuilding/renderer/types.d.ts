import type { ChatAPI, Workspace, ScheduledTask, ScheduledTaskRun, CreateTaskData, UpdateTaskData } from '../shared/types';

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

type FileContent =
  | { type: 'text'; content: string }
  | { type: 'image'; fileUrl: string }
  | { error: 'too-large'; size: number };

interface CopyProgress {
  copied: number;
  total: number;
  currentName: string | null;
}

interface FilesAPI {
  readDirectory(dirPath: string): Promise<DirEntry[]>;
  readFile(filePath: string): Promise<FileContent>;
  downloadFile(filename: string, content: string): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }>;
  showInFinder(filePath: string): Promise<void>;
  revealInFinder(filePath: string): Promise<void>;
  copyToWorkspace(sourcePaths: string[], destinationDir: string): Promise<{ copied: number }>;
  moveFile(sourcePath: string, destinationDir: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  createFile(filePath: string): Promise<void>;
  createDirectory(dirPath: string): Promise<void>;
  renameFile(filePath: string, newName: string): Promise<void>;
  convertImageToPng(base64Data: string): Promise<string>;
  getPathForFile(file: File): string;
  onCopyProgress(callback: (progress: CopyProgress) => void): () => void;
}

interface WorkspacesAPI {
  getActive(): Promise<Workspace | null>;
  list(): Promise<Workspace[]>;
  getDefaultDirectory(name: string): Promise<string>;
  create(data: { name: string; directoryPath: string }): Promise<Workspace>;
  switch(id: string): Promise<Workspace>;
  update(data: { name: string; directoryPath: string }): Promise<Workspace>;
  selectDirectory(): Promise<string | undefined>;
}

interface SessionData {
  id: string;
  title: string;
  source: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageData {
  id: number;
  session_id: string;
  type: string;
  content: string;
  created_at: string;
}

interface SessionsAPI {
  list(source?: string): Promise<SessionData[]>;
  get(id: string): Promise<SessionData | undefined>;
  rename(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
  listMessages(sessionId: string): Promise<MessageData[]>;
  onTitleUpdated(callback: (sessionId: string, title: string) => void): () => void;
}

interface ContainerAPI {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ running: boolean }>;
  exec(command: string[]): Promise<{ stdout: string; stderr: string }>;
  getBinaryMode(): Promise<'system' | 'bundled'>;
  setBinaryMode(mode: 'system' | 'bundled'): Promise<void>;
  getImageSource(): Promise<'registry' | 'local'>;
  setImageSource(source: 'registry' | 'local'): Promise<void>;
  getBundledStatus(): Promise<{ downloaded: boolean; binDir: string }>;
  downloadBinaries(): Promise<void>;
  deleteBinaries(): Promise<void>;
  deleteImage(): Promise<void>;
  getName(): Promise<string>;
  isImageBuilt(): Promise<boolean>;
  ensureSetup(): Promise<void>;
  onSetupProgress(callback: (progress: { stage: string; message: string }) => void): () => void;
  onProgress(callback: (progress: { stage: string; message: string }) => void): () => void;
}

interface AuthAPI {
  checkLogin(): Promise<{ loggedIn: boolean }>;
  startQRAuth(): Promise<{
    success: boolean;
    deviceId?: string;
    qrCodeDataURL?: string;
    authorizationURL?: string;
    error?: string;
  }>;
  verifyQRCode(
    deviceId: string,
    code: string
  ): Promise<{ success: boolean; authorized?: boolean; userId?: number; error?: string }>;
  logout(): Promise<{ success: boolean; error?: string }>;
  getApiKey(): Promise<{ apiKey: string | null }>;
  refetchApiKey(): Promise<{ success: boolean; keyIdentifier?: string; error?: string }>;
  onDeepLinkCallback(
    callback: (data: { verificationCode: string; deviceId: string }) => void
  ): () => void;
}

interface ElectronAPI {
  on(channel: string, callback: (...args: any[]) => void): void;
  removeListener(channel: string, callback: (...args: any[]) => void): void;
  invoke(channel: string, ...args: any[]): Promise<any>;
}

declare global {
  interface DirEntry {
    name: string;
    path: string;
    isDirectory: boolean;
  }

  type FileContent =
    | { type: 'text'; content: string }
    | { type: 'image'; fileUrl: string }
    | { error: 'too-large'; size: number };

  interface CopyProgress {
    copied: number;
    total: number;
    currentName: string | null;
  }

  interface FilesAPI {
    readDirectory(dirPath: string): Promise<DirEntry[]>;
    readFile(filePath: string): Promise<FileContent>;
    writeFile(filePath: string, content: string): Promise<void>;
    downloadFile(filename: string, content: string): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }>;
    showInFinder(filePath: string): Promise<void>;
    revealInFinder(filePath: string): Promise<void>;
    selectFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
    selectDirectory(): Promise<string | null>;
    copyToWorkspace(sourcePaths: string[], destinationDir: string): Promise<{ copied: number }>;
    moveFile(sourcePath: string, destinationDir: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    createFile(filePath: string): Promise<void>;
    createDirectory(dirPath: string): Promise<void>;
    renameFile(filePath: string, newName: string): Promise<void>;
    convertImageToPng(base64Data: string): Promise<string>;
    getPathForFile(file: File): string;
    onCopyProgress(callback: (progress: CopyProgress) => void): () => void;
  }

  interface WorkspacesAPI {
    getActive(): Promise<Workspace | null>;
    list(): Promise<Workspace[]>;
    getDefaultDirectory(name: string): Promise<string>;
    create(data: { name: string; directoryPath: string }): Promise<Workspace>;
    switch(id: string): Promise<Workspace>;
    update(data: { name: string; directoryPath: string }): Promise<Workspace>;
    selectDirectory(): Promise<string | undefined>;
  }

  interface SessionData {
    id: string;
    title: string;
    source: string | null;
    created_at: string;
    updated_at: string;
  }

  interface MessageData {
    id: number;
    session_id: string;
    type: string;
    content: string;
    created_at: string;
  }

  interface SessionsAPI {
    list(source?: string): Promise<SessionData[]>;
    get(id: string): Promise<SessionData | undefined>;
    rename(id: string, title: string): Promise<void>;
    delete(id: string): Promise<void>;
    listMessages(sessionId: string): Promise<MessageData[]>;
    onTitleUpdated(callback: (sessionId: string, title: string) => void): () => void;
  }

  interface ContainerAPI {
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): Promise<{ running: boolean }>;
    exec(command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    execLogged(command: string[], meta?: { source?: string; appDirName?: string | null }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    getBinaryMode(): Promise<'system' | 'bundled'>;
    setBinaryMode(mode: 'system' | 'bundled'): Promise<void>;
    getImageSource(): Promise<'registry' | 'local'>;
    setImageSource(source: 'registry' | 'local'): Promise<void>;
    getBundledStatus(): Promise<{ downloaded: boolean; binDir: string }>;
    downloadBinaries(): Promise<void>;
    deleteBinaries(): Promise<void>;
    deleteImage(): Promise<void>;
    getName(): Promise<string>;
    isImageBuilt(): Promise<boolean>;
    ensureSetup(): Promise<void>;
    onSetupProgress(callback: (progress: { stage: string; message: string; percent?: number }) => void): () => void;
    onProgress(callback: (progress: { stage: string; message: string; percent?: number }) => void): () => void;
  }

  interface CommandLogEntry {
    id: number;
    timestamp: string;
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number;
    appDirName: string | null;
    source: 'agent' | 'iframe';
  }

  interface CommandLogAPI {
    getAll(): Promise<CommandLogEntry[]>;
    getByApp(appDirName: string): Promise<CommandLogEntry[]>;
    getAppNames(): Promise<string[]>;
    onEntry(callback: (entry: CommandLogEntry) => void): () => void;
  }

  interface SystemLogEntry {
    id: number;
    timestamp: string;
    level: string;
    text: string;
  }

  interface SystemLogAPI {
    getAll(): Promise<SystemLogEntry[]>;
    onEntry(callback: (entry: SystemLogEntry) => void): () => void;
  }

  interface JupyterKernelInfo {
    id: string;
    name: string;
    execution_state: string;
    last_activity: string;
    connections: number;
  }

  interface JupyterAPI {
    startGateway(): Promise<{ url: string } | { error: string }>;
    stopGateway(): Promise<void>;
    gatewayStatus(): Promise<{ running: boolean; url: string | null }>;
    listKernels(): Promise<JupyterKernelInfo[]>;
    shutdownKernel(kernelId: string): Promise<boolean>;
  }

  interface ReactionPromptAPI {
    get(): Promise<{ instructions: string | null }>;
    set(instructions: string): Promise<void>;
    reset(): Promise<void>;
  }

  interface SoulPromptAPI {
    get(): Promise<{ content: string }>;
    set(content: string): Promise<void>;
  }

  interface FocusPromptAPI {
    get(): Promise<{ content: string }>;
    set(content: string): Promise<void>;
  }

  interface ScheduledTasksAPI {
    list(): Promise<ScheduledTask[]>;
    get(id: string): Promise<ScheduledTask | null>;
    create(data: CreateTaskData): Promise<ScheduledTask>;
    update(id: string, data: UpdateTaskData): Promise<ScheduledTask | null>;
    delete(id: string): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    runNow(id: string): Promise<void>;
    listRuns(taskId: string): Promise<ScheduledTaskRun[]>;
  }

  interface TodayFileSession {
    id: number;
    document_url: string;
    app_name: string;
    app_bundle_id: string;
    window_title: string | null;
    session_date: string;
    first_seen: string;
    last_seen: string;
    poll_count: number;
    total_dwell: number;
    app_version: string;
    snapshot_ulid: string | null;
    last_modified: string | null;
    diff_ulid: string | null;
  }

  interface FileMonitorAPI {
    status(): Promise<{ running: boolean }>;
    start(): Promise<void>;
    stop(): Promise<void>;
    getTodaySessions(): Promise<TodayFileSession[]>;
    openFile(fileUrl: string, bundleId?: string): Promise<string>;
  }

  interface BrowserMonitorAPI {
    status(): Promise<{ serverRunning: boolean; extensionConnected: boolean }>;
    start(): Promise<void>;
    stop(): Promise<void>;
    downloadExtension(): Promise<{ success: boolean; error?: string; path?: string }>;
  }

  interface DataPathInfo {
    label: string;
    path: string;
  }

  interface DebugAPI {
    getStorageInfo(): Promise<{
      environment: string;
      userData: string;
      podmanPaths: DataPathInfo[];
    }>;
    clearSelected(ids: string[]): Promise<{ cleared: string[]; errors: string[] }>;
  }

  interface SettingsAPI {
    getMaxAttachmentSizeMB(): Promise<number>;
    setMaxAttachmentSizeMB(sizeMB: number): Promise<void>;
  }

  interface Window {
    chatAPI: ChatAPI;
    filesAPI: FilesAPI;
    workspacesAPI: WorkspacesAPI;
    sessionsAPI: SessionsAPI;
    containerAPI: ContainerAPI;
    settingsAPI: SettingsAPI;
    commandLogAPI: CommandLogAPI;
    systemLogAPI: SystemLogAPI;
    jupyterAPI: JupyterAPI;
    authAPI: AuthAPI;
    electronAPI: ElectronAPI;
    reactionPromptAPI: ReactionPromptAPI;
    soulPromptAPI: SoulPromptAPI;
    focusPromptAPI: FocusPromptAPI;
    scheduledTasksAPI: ScheduledTasksAPI;
    fileMonitorAPI: FileMonitorAPI;
    browserMonitorAPI: BrowserMonitorAPI;
    debugAPI: DebugAPI;
  }
}
