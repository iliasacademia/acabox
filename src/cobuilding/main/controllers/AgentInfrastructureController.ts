import { app, Notification as ElectronNotification } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import log from 'electron-log';
import type { WorkspaceController } from './WorkspaceController';
import type { containerService as containerServiceInstance } from '../containerService';
import { getCredentials } from '../cobuildingTokenManager';
import { getScannedFilesByType, getScannedFiles } from '../db/scannedFilesRepository';
import {
  handleCreateSuggestion,
  handleListSuggestions,
  handleUpdateSuggestion,
  handleReorderSuggestions,
  handleDeleteSuggestion,
  type SuggestedTasksContext,
} from '../mcpServers/suggestedTasksMcpServer';
import { getLatestReport } from '../db/reportRepository';
import { AGENT_MEMORY_SUBDIR, REFERENCES_SUBDIR, REFERENCES_INDEX } from '../../shared/paths';
import { queryActivity } from '../activityQuery';
import { checkLogin } from '../../../apiClient';
import { createSession as createDbSession, insertMessage as insertDbMessage, updateSessionTitle } from '../db/chatRepository';
import { buildMiniApp } from '../miniAppBuilder';
import { ensurePythonVenv } from '../pythonSetup';

export interface AgentInfrastructureDeps {
  workspaceController: WorkspaceController;
  containerService: typeof containerServiceInstance;
  refreshCredentials: () => Promise<{ apiKey: string; baseURL?: string }>;
  onNotificationClick?: (action: any) => void;
  onBriefingsChanged?: () => void;
}

export class AgentInfrastructureController {
  private _activeNotifications = new Set<any>();
  private deps: AgentInfrastructureDeps;

  constructor(deps: AgentInfrastructureDeps) {
    this.deps = deps;
  }

  private registerHostMcpServers(workspace: { id: string }, agentDir: string, userDirectoryPaths: string[]): void {
    const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

    const onNotificationClick = this.deps.onNotificationClick;
    const onBriefingsChanged = this.deps.onBriefingsChanged;
    const activeNotificationsSet = this._activeNotifications;
    const { containerService } = this.deps;

    const handlers: Record<string, Record<string, (args: any) => Promise<any>>> = {
      activity: {
        query_activity: async (args: any) => {
          const result = queryActivity(args);
          if ('error' in result) return fail(result.error);
          const fileCount = result.file_sessions?.length || 0;
          const header = `Activity from ${result.query.since} to ${result.query.until}\nFile sessions: ${fileCount}\n`;
          return ok(header + '\n' + JSON.stringify(result, null, 2));
        },
      },

      notification: {
        show_notification: async (args: any) => {
          try {
            const notification = new ElectronNotification({ title: args.title, body: args.body });
            activeNotificationsSet.add(notification);

            const release = () => {
              activeNotificationsSet.delete(notification);
            };

            if (onNotificationClick) {
              notification.on('click', () => {
                release();
                if (args.navigation) {
                  const nav = args.navigation;
                  if (nav.type === 'thread' && nav.threadId) {
                    onNotificationClick({ type: 'thread', threadId: nav.threadId, sidebarTab: nav.sidebarTab });
                  } else if (nav.type === 'sidebar' && nav.sidebarTab) {
                    onNotificationClick({ type: 'sidebar', tab: nav.sidebarTab });
                  } else {
                    onNotificationClick(null);
                  }
                } else {
                  onNotificationClick(null);
                }
              });
              notification.on('close', () => release());
            } else {
              release();
            }

            notification.show();
            return ok('Notification shown successfully.');
          } catch (err: any) {
            return fail(`Failed to show notification: ${err.message}`);
          }
        },
      },

      reaction: {
        create_reaction_thread: async (args: any) => {
          try {
            const sessionId = randomUUID();
            createDbSession(sessionId, workspace.id, 'reactions');
            insertDbMessage(sessionId, 'assistant', JSON.stringify([{ type: 'text', text: args.message }]));
            updateSessionTitle(sessionId, args.title);
            return ok(`Reaction thread created: ${args.title} (id: ${sessionId})`);
          } catch (err: any) {
            return fail(`Failed to create reaction thread: ${err.message}`);
          }
        },
      },

      'mini-apps': {
        open_mini_application: async (args: any) => {
          const appDir = path.join(agentDir, '.applications', args.dir_name);
          const exists = await fs.promises.access(appDir).then(() => true, () => false);
          if (!exists) return fail(`Mini-application directory not found: .applications/${args.dir_name}`);
          return ok(`Opened mini-application: ${args.dir_name}`);
        },
        build_and_open_mini_application: async (args: any) => {
          const build = await buildMiniApp(agentDir, args.dir_name);
          if (!build.ok) {
            return fail(`Build failed for ${args.dir_name}:\n${build.error}`);
          }
          return ok(`Built and opened mini-application: ${args.dir_name}`);
        },
        list_published_servers: async () => {
          const { miniAppMcpRegistry } = await import('../miniAppMcpRegistry');
          const servers = miniAppMcpRegistry.list();
          return ok(JSON.stringify(servers, null, 2));
        },
        call_published_tool: async (args: any) => {
          const { miniAppMcpRegistry } = await import('../miniAppMcpRegistry');
          const { server_name, tool_name, arguments: toolArgs } = args ?? {};
          if (typeof server_name !== 'string' || typeof tool_name !== 'string') {
            return fail('server_name and tool_name are required strings.');
          }
          const { result, error } = await miniAppMcpRegistry.invoke(server_name, tool_name, toolArgs ?? {});
          if (error) return fail(error);
          return ok(typeof result === 'string' ? result : JSON.stringify(result));
        },
      },

      'suggested-tasks': (() => {
        const stCtx: SuggestedTasksContext = { workspaceId: workspace.id, onBriefingsChanged };
        return {
          list_suggestions: async (args: any) => {
            try { return await handleListSuggestions(args, stCtx); }
            catch (err: any) { return fail(`Failed to list suggestions: ${err.message}`); }
          },
          create_suggestion: async (args: any) => {
            try { return await handleCreateSuggestion(args, stCtx); }
            catch (err: any) { return fail(`Failed to create suggestion: ${err.message}`); }
          },
          update_suggestion: async (args: any) => {
            try { return await handleUpdateSuggestion(args, stCtx); }
            catch (err: any) { return fail(`Failed to update suggestion: ${err.message}`); }
          },
          reorder_suggestions: async (args: any) => {
            try { return await handleReorderSuggestions(args, stCtx); }
            catch (err: any) { return fail(`Failed to reorder suggestions: ${err.message}`); }
          },
          delete_suggestion: async (args: any) => {
            try { return await handleDeleteSuggestion(args, stCtx); }
            catch (err: any) { return fail(`Failed to delete suggestion: ${err.message}`); }
          },
        };
      })(),

      workspace: {
        get_scanned_files: async (args: any) => {
          try {
            const files = args.file_type
              ? getScannedFilesByType(workspace.id, args.file_type)
              : getScannedFiles(workspace.id);

            let refIndex: Record<string, string> = {};
            try {
              const indexPath = path.join(agentDir, REFERENCES_SUBDIR, REFERENCES_INDEX);
              const raw = await fsPromises.readFile(indexPath, 'utf-8');
              refIndex = JSON.parse(raw);
            } catch { /* no index yet */ }

            const cleaned = files.map(({ file_path, file_name, file_type }: { file_path: string; file_name: string; file_type: string }) => ({
              file_path, file_name, file_type,
              ...(file_type === 'reference' && refIndex[file_path]
                ? { markdown_path: `${REFERENCES_SUBDIR}/${refIndex[file_path]}` }
                : {}),
            }));
            return ok(JSON.stringify({ files: cleaned, count: cleaned.length }));
          } catch (err: any) {
            return fail(`Failed to get scanned files: ${err.message}`);
          }
        },

        get_research_profile: async () => {
          try {
            const report = getLatestReport(workspace.id, 'directory_scan');
            if (!report) {
              return ok(JSON.stringify({ about_you: null, working_on: null, status: 'not_started' }));
            }
            if (report.status !== 'completed') {
              return ok(JSON.stringify({ about_you: null, working_on: null, status: report.status }));
            }
            let aboutYou: string | null = null;
            let workingOn: string | null = null;
            try {
              const parsed = JSON.parse(report.report_data);
              aboutYou = parsed.about_you ?? null;
              workingOn = parsed.working_on ?? null;
            } catch { /* ignore */ }
            if (!aboutYou || !workingOn) {
              const memoryDir = path.join(agentDir, AGENT_MEMORY_SUBDIR);
              if (!aboutYou) {
                try { aboutYou = await fs.promises.readFile(path.join(memoryDir, 'about_you.md'), 'utf-8'); } catch { /* not available */ }
              }
              if (!workingOn) {
                try { workingOn = await fs.promises.readFile(path.join(memoryDir, 'working_on.md'), 'utf-8'); } catch { /* not available */ }
              }
            }
            return ok(JSON.stringify({ about_you: aboutYou, working_on: workingOn, status: report.status }));
          } catch (err: any) {
            return fail(`Failed to get research profile: ${err.message}`);
          }
        },
      },
    };

    (globalThis as any).__hostMcpServers = handlers;
    log.info(`[MCP] Registered host MCP handlers: ${Object.keys(handlers).join(', ')}`);
  }

  async start(workspacePath: string): Promise<void> {
    const activeWorkspace = this.deps.workspaceController.activeWorkspace;
    if (!activeWorkspace) return;

    try {
      await this.deps.refreshCredentials();
    } catch (err) {
      log.warn('[AgentInfrastructure] Credential refresh failed, using stored key:', err);
    }

    void migrateMissingManifests(workspacePath);

    await this.deps.containerService.ensureAgentFilesInWorkspace(workspacePath);

    this.registerHostMcpServers(activeWorkspace, workspacePath, this.deps.workspaceController.userDirectoryPaths);

    const { apiKey: agentApiKey, baseURL: agentBaseURL } = getCredentials();
    const agentConfig = {
      port: 8080,
      mcpServers: {},
      anthropicApiKey: agentApiKey ?? '',
      ...(agentBaseURL ? { anthropicBaseURL: agentBaseURL } : {}),
      model: 'claude-opus-4-7',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      allowedTools: [
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent',
        'WebSearch', 'Skill', 'TodoWrite',
        'EnterPlanMode', 'ExitPlanMode',
        'mcp__activity__query_activity',
        'mcp__mini-apps__open_mini_application',
        'mcp__mini-apps__build_and_open_mini_application',
        'mcp__mini-apps__list_published_servers',
        'mcp__mini-apps__call_published_tool',
        'mcp__notification__show_notification',
        'mcp__reaction__create_reaction_thread',
        'mcp__suggested-tasks__list_suggestions',
        'mcp__suggested-tasks__create_suggestion',
        'mcp__suggested-tasks__update_suggestion',
        'mcp__suggested-tasks__reorder_suggestions',
        'mcp__suggested-tasks__delete_suggestion',
        'mcp__workspace__get_scanned_files',
        'mcp__workspace__get_research_profile',
      ],
      settingSources: ['project'],
    };

    await this.deps.containerService.startAgentServer(JSON.stringify(agentConfig, null, 2), workspacePath);

    // Bootstrap the Python venv in the background so the agent's install
    // wrapper has a `pip` to call when it first encounters a Python
    // dependency. Best-effort: if the user has no system Python the agent
    // can still operate without Python tooling.
    void ensurePythonVenv().catch((err) => {
      log.warn(`[AgentInfrastructure] Python venv bootstrap deferred: ${(err as Error).message}`);
    });
  }

  async stop(): Promise<void> {
    await this.deps.containerService.stopAgentServer();
    (globalThis as any).__hostMcpServers = null;
  }
}

/**
 * TODO: Remove this migration once most workspaces have been migrated past
 * this version. Added: 2026-05-05. Safe to remove after ~2026-08-05.
 *
 * Every mini-app must have a manifest.json describing its name, description,
 * icon (Lucide name), and lastOpened timestamp — the Tools page reads this to
 * render each app and order by recency. Apps created before this change don't
 * have one. On startup we scan .applications/* for missing manifests and
 * launch a background job per app that asks Claude to generate the metadata
 * from the app's source. Failures are logged and retried on next startup.
 */
async function migrateMissingManifests(agentDir: string): Promise<void> {
  const appsDir = path.join(agentDir, '.applications');

  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(appsDir, { withFileTypes: true });
  } catch {
    return;
  }

  const missing: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const manifestPath = path.join(appsDir, entry.name, 'manifest.json');
    try {
      await fsPromises.access(manifestPath);
    } catch {
      missing.push(entry.name);
    }
  }

  if (missing.length === 0) return;
  log.info(`[ManifestMigration] Generating manifests for ${missing.length} apps: ${missing.join(', ')}`);

  for (const dirName of missing) {
    try {
      await generateManifestForApp(agentDir, dirName);
    } catch (err) {
      log.warn(`[ManifestMigration] Failed for ${dirName}: ${(err as Error).message ?? err}`);
    }
  }
}

async function generateManifestForApp(agentDir: string, dirName: string): Promise<void> {
  const appDir = path.join(agentDir, '.applications', dirName);
  const manifestPath = path.join(appDir, 'manifest.json');

  try {
    await fsPromises.access(manifestPath);
    return;
  } catch { /* keep going */ }

  const { apiKey: manifestApiKey, baseURL: manifestBaseURL } = getCredentials();
  if (!manifestApiKey) {
    log.warn(`[ManifestMigration] No API key — skipping ${dirName}`);
    return;
  }

  let appSource = '';
  try {
    appSource = await fsPromises.readFile(path.join(appDir, 'src', 'App.tsx'), 'utf-8');
  } catch { /* fall back to dir name */ }
  if (appSource.length > 8000) appSource = appSource.slice(0, 8000);

  const client = new Anthropic({ apiKey: manifestApiKey, baseURL: manifestBaseURL });
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `You are generating manifest.json metadata for a mini-app. Return only JSON with these fields:
- name: short user-visible title (≤ 40 chars)
- description: one-sentence summary of what the app does (≤ 80 chars)
- icon: a Lucide icon name in PascalCase (e.g. FlaskConical, LineChart, Microscope, Dna, Beaker, Image, Table, BarChart3) that visually fits

Directory name: ${dirName}

App source (truncated):
${appSource || '(no App.tsx found — infer from the directory name)'}

Output JSON only. No prose, no code fences.`,
    }],
  });

  const block = message.content[0] as { type: string; text?: string };
  const text = (block && block.type === 'text' && block.text) ? block.text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in model response');

  const parsed = JSON.parse(jsonMatch[0]) as { name?: unknown; description?: unknown; icon?: unknown };
  const fallbackName = dirName.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const manifest = {
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : fallbackName,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    icon: typeof parsed.icon === 'string' && parsed.icon.trim() ? parsed.icon : 'LayoutGrid',
    lastOpened: null,
  };

  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log.info(`[ManifestMigration] Wrote manifest for ${dirName}: ${manifest.name} / ${manifest.icon}`);
}
