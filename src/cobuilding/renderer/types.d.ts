import type { ChatAPI, Workspace } from '../shared/types';

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

declare global {
  interface Window {
    chatAPI: ChatAPI;
    filesAPI: FilesAPI;
    workspacesAPI: WorkspacesAPI;
    sessionsAPI: SessionsAPI;
  }
}
