import { getDatabase } from './database';

export interface WritingProject {
  id: number;
  workspace_id: string;
  name: string;
  description: string;
  file_count: number;
  primary_manuscript_id: number | null;
  server_created_at: string;
  server_updated_at: string;
  synced_at: string;
}

export interface WritingProjectFile {
  id: number;
  project_id: number;
  file_name: string;
  file_type: string;
  rel_path: string | null;
  is_primary_manuscript: number;
  size: number;
  tag: string | null;
  server_created_at: string;
  server_updated_at: string;
}

export interface WritingSupportingFile {
  id: number;
  workspace_id: string;
  file_name: string;
  file_type: string;
  rel_path: string | null;
  size: number;
  tag: string | null;
  summary: string | null;
  server_created_at: string;
  server_updated_at: string;
}

export interface WritingConversation {
  id: number;
  project_id: number;
  agent_name: string;
  title: string | null;
  summary: string | null;
  server_created_at: string;
  server_updated_at: string;
}

// --- Projects ---

export function upsertProject(workspaceId: string, project: {
  id: number;
  name: string;
  description?: string;
  file_count?: number;
  primary_manuscript_id?: number | null;
  created_at: string;
  updated_at: string;
}): void {
  getDatabase().prepare(`
    INSERT INTO writing_projects (id, workspace_id, name, description, file_count, primary_manuscript_id, server_created_at, server_updated_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      file_count = excluded.file_count,
      primary_manuscript_id = excluded.primary_manuscript_id,
      server_created_at = excluded.server_created_at,
      server_updated_at = excluded.server_updated_at,
      synced_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
  `).run(
    project.id,
    workspaceId,
    project.name,
    project.description ?? '',
    project.file_count ?? 0,
    project.primary_manuscript_id ?? null,
    project.created_at,
    project.updated_at,
  );
}

export function listProjects(workspaceId: string): WritingProject[] {
  return getDatabase()
    .prepare('SELECT * FROM writing_projects WHERE workspace_id = ? ORDER BY server_updated_at DESC')
    .all(workspaceId) as WritingProject[];
}

export function deleteProjectsForWorkspace(workspaceId: string): void {
  getDatabase()
    .prepare('DELETE FROM writing_projects WHERE workspace_id = ?')
    .run(workspaceId);
}

// --- Project Files (manuscripts) ---

export function upsertProjectFile(projectId: number, file: {
  id: number;
  file_name: string;
  file_type?: string;
  file_path?: string;
  is_primary_manuscript?: boolean;
  size?: number;
  tag?: string | null;
  created_at: string;
  updated_at: string;
}): void {
  getDatabase().prepare(`
    INSERT INTO writing_project_files (id, project_id, file_name, file_type, rel_path, is_primary_manuscript, size, tag, server_created_at, server_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_name = excluded.file_name,
      file_type = excluded.file_type,
      rel_path = excluded.rel_path,
      is_primary_manuscript = excluded.is_primary_manuscript,
      size = excluded.size,
      tag = excluded.tag,
      server_created_at = excluded.server_created_at,
      server_updated_at = excluded.server_updated_at
  `).run(
    file.id,
    projectId,
    file.file_name,
    file.file_type ?? 'other',
    file.file_path ?? null,
    file.is_primary_manuscript ? 1 : 0,
    file.size ?? 0,
    file.tag ?? null,
    file.created_at,
    file.updated_at,
  );
}

export function listProjectFiles(projectId: number): WritingProjectFile[] {
  return getDatabase()
    .prepare('SELECT * FROM writing_project_files WHERE project_id = ? ORDER BY file_name')
    .all(projectId) as WritingProjectFile[];
}

export function clearProjectFiles(projectId: number): void {
  getDatabase()
    .prepare('DELETE FROM writing_project_files WHERE project_id = ?')
    .run(projectId);
}

// --- Supporting Files (user-level) ---

export function upsertSupportingFile(workspaceId: string, file: {
  id: number;
  file_name: string;
  file_type?: string;
  file_path?: string;
  size?: number;
  tag?: string | null;
  summary?: string | null;
  created_at: string;
  updated_at: string;
}): void {
  getDatabase().prepare(`
    INSERT INTO writing_supporting_files (id, workspace_id, file_name, file_type, rel_path, size, tag, summary, server_created_at, server_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_name = excluded.file_name,
      file_type = excluded.file_type,
      rel_path = excluded.rel_path,
      size = excluded.size,
      tag = excluded.tag,
      summary = excluded.summary,
      server_created_at = excluded.server_created_at,
      server_updated_at = excluded.server_updated_at
  `).run(
    file.id,
    workspaceId,
    file.file_name,
    file.file_type ?? 'other',
    file.file_path ?? null,
    file.size ?? 0,
    file.tag ?? null,
    file.summary ?? null,
    file.created_at,
    file.updated_at,
  );
}

export function listSupportingFiles(workspaceId: string): WritingSupportingFile[] {
  return getDatabase()
    .prepare('SELECT * FROM writing_supporting_files WHERE workspace_id = ? ORDER BY file_name')
    .all(workspaceId) as WritingSupportingFile[];
}

export function deleteSupportingFilesForWorkspace(workspaceId: string): void {
  getDatabase()
    .prepare('DELETE FROM writing_supporting_files WHERE workspace_id = ?')
    .run(workspaceId);
}

// --- Conversations ---

export function upsertConversation(projectId: number, conversation: {
  id: number;
  agent_name: string;
  title?: string | null;
  summary?: string | null;
  created_at: string;
  updated_at: string;
}): void {
  getDatabase().prepare(`
    INSERT INTO writing_conversations (id, project_id, agent_name, title, summary, server_created_at, server_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      agent_name = excluded.agent_name,
      title = excluded.title,
      summary = excluded.summary,
      server_created_at = excluded.server_created_at,
      server_updated_at = excluded.server_updated_at
  `).run(
    conversation.id,
    projectId,
    conversation.agent_name,
    conversation.title ?? null,
    conversation.summary ?? null,
    conversation.created_at,
    conversation.updated_at,
  );
}

export function getConversation(id: number): WritingConversation | undefined {
  return getDatabase()
    .prepare('SELECT * FROM writing_conversations WHERE id = ?')
    .get(id) as WritingConversation | undefined;
}

export function listConversations(projectId: number): WritingConversation[] {
  return getDatabase()
    .prepare('SELECT * FROM writing_conversations WHERE project_id = ? ORDER BY server_updated_at DESC')
    .all(projectId) as WritingConversation[];
}

export function clearConversations(projectId: number): void {
  getDatabase()
    .prepare('DELETE FROM writing_conversations WHERE project_id = ?')
    .run(projectId);
}

// --- Conversation Messages ---

export interface WritingConversationMessage {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  format: string | null;
  server_created_at: string;
}

export function upsertConversationMessage(conversationId: number, message: {
  id: number;
  role: string;
  content: string;
  format?: string | null;
  created_at: string;
}): void {
  getDatabase().prepare(`
    INSERT INTO writing_conversation_messages (id, conversation_id, role, content, format, server_created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      content = excluded.content,
      format = excluded.format,
      server_created_at = excluded.server_created_at
  `).run(
    message.id,
    conversationId,
    message.role,
    message.content ?? '',
    message.format ?? null,
    message.created_at,
  );
}

export function listConversationMessages(conversationId: number): WritingConversationMessage[] {
  return getDatabase()
    .prepare('SELECT * FROM writing_conversation_messages WHERE conversation_id = ? ORDER BY server_created_at ASC')
    .all(conversationId) as WritingConversationMessage[];
}

export function clearConversationMessages(conversationId: number): void {
  getDatabase()
    .prepare('DELETE FROM writing_conversation_messages WHERE conversation_id = ?')
    .run(conversationId);
}
