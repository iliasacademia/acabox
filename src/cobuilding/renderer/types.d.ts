import type { ChatAPI, Workspace } from '../shared/types';

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
    selectFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
    selectDirectory(): Promise<string | null>;
    copyToWorkspace(sourcePaths: string[], destinationDir: string): Promise<{ copied: number }>;
    moveFile(sourcePath: string, destinationDir: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    createFile(filePath: string): Promise<void>;
    createDirectory(dirPath: string): Promise<void>;
    renameFile(filePath: string, newName: string): Promise<void>;
    getPathForFile(file: File): string;
    onCopyProgress(callback: (progress: CopyProgress) => void): () => void;
  }

  interface WorkspacesAPI {
    getActive(): Promise<Workspace | null>;
    getDefaultDirectory(name: string): Promise<string>;
    create(data: { name: string; directoryPath: string; apiKey: string }): Promise<Workspace>;
    update(data: { name: string; directoryPath: string; apiKey: string }): Promise<Workspace>;
    selectDirectory(): Promise<string | undefined>;
  }

  interface SessionData {
    id: string;
    title: string;
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
    list(): Promise<SessionData[]>;
    get(id: string): Promise<SessionData | undefined>;
    rename(id: string, title: string): Promise<void>;
    delete(id: string): Promise<void>;
    listMessages(sessionId: string): Promise<MessageData[]>;
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
    onSetupProgress(callback: (progress: { stage: string; message: string }) => void): () => void;
    onProgress(callback: (progress: { stage: string; message: string }) => void): () => void;
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

  interface JupyterAPI {
    startGateway(): Promise<{ url: string } | { error: string }>;
    stopGateway(): Promise<void>;
    gatewayStatus(): Promise<{ running: boolean; url: string | null }>;
  }

  interface Window {
    chatAPI: ChatAPI;
    filesAPI: FilesAPI;
    workspacesAPI: WorkspacesAPI;
    sessionsAPI: SessionsAPI;
    containerAPI: ContainerAPI;
    commandLogAPI: CommandLogAPI;
    systemLogAPI: SystemLogAPI;
    jupyterAPI: JupyterAPI;
  }
}
