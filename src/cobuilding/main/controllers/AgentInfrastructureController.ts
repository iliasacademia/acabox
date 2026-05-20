import { app, Notification as ElectronNotification } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
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
import { getWordFilePath, getWordText, getWordSelection, saveWordDocument, openWordDocument } from '../../../server/wordActions';
import { googleDocsGetActiveDoc, googleDocsGetText, googleDocsFindAndReplace } from '../mcpServers/googleDocsMcpServer';
import { createGoogleDriveHandlers } from '../mcpServers/googleDriveMcpServer';
import { listWorkspaceDirectoriesBySource } from '../db/workspaceRepository';
import {
  appleNotesGetActiveNote,
  appleNotesGetText,
  appleNotesListNotes,
  appleNotesSearchNotes,
  appleNotesSaveNote,
  appleNotesOpenNote,
  appleNotesFindAndReplace,
} from '../mcpServers/appleNotesMcpServer';
import { createObsidianHandlers } from '../mcpServers/obsidianMcpServer';
import { resolveObsidianDocumentPath } from '../hostApps/obsidianHostApp';
import { checkLogin } from '../../../apiClient';
import { findReferencesForFile, findReferencesForText, createCitationReportFromText, getCitationReport, addClaimToReport, searchCitationsForClaim, formatCitations, listCitationReports } from '../citeright/citeRightClient';
import { saveUserContext as grantsSaveUserContext, createProject as grantsCreateProject, getProject as grantsGetProject, listProjects as grantsListProjects, setFavoriteOpportunity, setHiddenOpportunity, setHiddenReason as grantsSetHiddenReason, visitOpportunity, updateProject as grantsUpdateProject } from '../grants/grantsClient';
import { summarizeReport } from '../citeright/reportSummary';
import { createSession as createDbSession, insertMessage as insertDbMessage, updateSessionTitle } from '../db/chatRepository';
import { getZoteroLocalStatus, searchZoteroLibrary, getZoteroItem, addDoiToZotero } from '../../../zoteroLocalClient';

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
          const browserCount = result.browser_sessions
            ? result.browser_sessions.reduce((sum: number, group: any) => sum + (group.sessions as unknown[]).length, 0) : 0;
          const fileCount = result.file_sessions?.length || 0;
          const header = `Activity from ${result.query.since} to ${result.query.until}\nBrowser sessions: ${browserCount} | File sessions: ${fileCount}\n`;
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

      'google-docs': {
        get_active_doc: googleDocsGetActiveDoc,
        get_text: googleDocsGetText,
        find_and_replace: googleDocsFindAndReplace,
      },

      'google-drive': createGoogleDriveHandlers({
        getAllowedItems: () => {
          const dirs = listWorkspaceDirectoriesBySource(workspace.id, 'google-drive');
          return dirs.map(d => {
            const meta = d.metadata ? JSON.parse(d.metadata) : {};
            return {
              driveId: meta.driveId as string,
              name: d.display_name,
              mimeType: (meta.mimeType as string) ?? 'application/vnd.google-apps.folder',
            };
          }).filter(d => d.driveId);
        },
        getWorkspaceId: () => workspace.id,
      }),

      'apple-notes': {
        get_active_note: appleNotesGetActiveNote,
        get_text: appleNotesGetText,
        list_notes: appleNotesListNotes,
        search_notes: appleNotesSearchNotes,
        save_note: appleNotesSaveNote,
        open_note: appleNotesOpenNote,
        find_and_replace: appleNotesFindAndReplace,
      },

      obsidian: createObsidianHandlers({
        workspaceDir: userDirectoryPaths[0] ?? '',
        getActiveNotePath: () => resolveObsidianDocumentPath(userDirectoryPaths),
      }),

      'ms-word': {
        get_file_path: async () => { try { return ok(JSON.stringify(await getWordFilePath())); } catch (e: any) { return fail(String(e)); } },
        get_text: async (args: any) => { try { return ok(JSON.stringify(await getWordText(args.offset, args.limit))); } catch (e: any) { return fail(String(e)); } },
        get_selection: async () => { try { return ok(JSON.stringify(await getWordSelection())); } catch (e: any) { return fail(String(e)); } },
        save_document: async () => { try { return ok(JSON.stringify(await saveWordDocument())); } catch (e: any) { return fail(String(e)); } },
        open_document: async (args: any) => { try { return ok(JSON.stringify(await openWordDocument(args.path))); } catch (e: any) { return fail(String(e)); } },
        find_and_replace: async (args: any) => ok(JSON.stringify({ proposed: true, ...args })),
      },

      citeright: {
        find_references: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
          const pollOptions = { timeoutMs: (args.timeout_seconds ?? 600) * 1000, pollIntervalMs: (args.poll_interval_seconds ?? 3) * 1000 };
          const response = args.file_path ? await findReferencesForFile(args.file_path, pollOptions) : await findReferencesForText(args.document_text, pollOptions);
          return ok(JSON.stringify(summarizeReport(response)));
        },
        create_citation_report: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
          return ok(JSON.stringify(summarizeReport(await createCitationReportFromText(args.document_text))));
        },
        get_citation_report: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
          return ok(JSON.stringify(summarizeReport(await getCitationReport(args.report_id))));
        },
        add_claim_to_report: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
          return ok(JSON.stringify(summarizeReport(await addClaimToReport(args.report_id, args.text))));
        },
        search_citations_for_claim: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
          return ok(JSON.stringify(summarizeReport(await searchCitationsForClaim(args.report_id, args.claim_id))));
        },
        format_citations: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await formatCitations(args.works)));
        },
        list_citation_reports: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('CiteRight requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await listCitationReports(args.page, args.per_page)));
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
          const appDir = path.join(agentDir, '.applications', args.dir_name);
          const exists = await fs.promises.access(appDir).then(() => true, () => false);
          if (!exists) return fail(`Mini-application directory not found: .applications/${args.dir_name}`);

          const entry = `.applications/${args.dir_name}/src/index.tsx`;
          const outfile = `.applications/${args.dir_name}/dist/bundle.js`;
          const build = await containerService.exec([
            'esbuild',
            entry,
            '--bundle',
            `--outfile=${outfile}`,
            '--jsx=automatic',
            '--loader:.tsx=tsx',
            '--loader:.ts=ts',
            '--format=iife',
            '--alias:@reusable=/data/.applications/_reusable',
          ]);
          if (build.exitCode !== 0) {
            const detail = (build.stderr || build.stdout || '').trim() || 'Unknown build error';
            return fail(`Build failed for ${args.dir_name}:\n${detail}`);
          }

          return ok(`Built and opened mini-application: ${args.dir_name}`);
        },
      },

      zotero: {
        status: async () => {
          try {
            const status = await getZoteroLocalStatus();
            return ok(JSON.stringify({ status }));
          } catch (e: any) { return fail(`Zotero status check failed: ${e.message}`); }
        },
        search_library: async (args: any) => {
          try {
            return ok(JSON.stringify(await searchZoteroLibrary(args.query, args.limit)));
          } catch (e: any) { return fail(`Zotero search failed: ${e.message}`); }
        },
        get_item: async (args: any) => {
          try {
            return ok(JSON.stringify(await getZoteroItem(args.key)));
          } catch (e: any) { return fail(`Zotero get_item failed: ${e.message}`); }
        },
        add_doi: async (args: any) => {
          try {
            return ok(JSON.stringify(await addDoiToZotero(args.doi)));
          } catch (e: any) { return fail(`Zotero add_doi failed: ${e.message}`); }
        },
      },

      grants: {
        save_user_context: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await grantsSaveUserContext(args.data)));
        },
        create_project: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await grantsCreateProject(args.research_summary, args.name)));
        },
        get_project: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await grantsGetProject(args.project_id)));
        },
        list_projects: async () => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await grantsListProjects()));
        },
        favorite_opportunity: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await setFavoriteOpportunity(args.project_id, args.grant_opportunity_id, args.favorite)));
        },
        hide_opportunity: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await setHiddenOpportunity(args.project_id, args.grant_opportunity_id, args.hidden)));
        },
        set_hidden_reason: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await grantsSetHiddenReason(args.project_id, args.grant_opportunity_id, args.hidden_reason)));
        },
        visit_opportunity: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await visitOpportunity(args.project_id, args.grant_opportunity_id)));
        },
        update_project: async (args: any) => {
          const isLoggedIn = await checkLogin(); if (!isLoggedIn) return fail('Grants Finder requires a logged-in academia.edu account.');
          return ok(JSON.stringify(await grantsUpdateProject(args.project_id, { name: args.name, research_summary: args.research_summary })));
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

    await migrateHostSessionsToContainer(workspacePath);

    if (this.deps.containerService.isOverlayEnabled() && this.deps.containerService.isRunning()) {
      try {
        await this.deps.containerService.exec([
          'rsync', '-a',
          '/data-host/.academia/', '/data/.academia/',
        ]);
      } catch (err) {
        log.warn(`[AgentInfrastructure] Failed to sync host files into overlay: ${(err as Error).message}`);
      }
    }

    void migrateMissingManifests(workspacePath);

    await this.deps.containerService.ensureAgentFilesInWorkspace(workspacePath);

    this.registerHostMcpServers(activeWorkspace, workspacePath, this.deps.workspaceController.userDirectoryPaths);

    const { apiKey: agentApiKey, baseURL: agentBaseURL } = getCredentials();
    const agentConfig = {
      port: 8080,
      claudeBinaryPath: '/data/.academia/claude',
      mcpServers: {},
      anthropicApiKey: agentApiKey ?? '',
      ...(agentBaseURL ? { anthropicBaseURL: agentBaseURL } : {}),
      model: 'claude-opus-4-7',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      allowedTools: [
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent',
        'NotebookEdit', 'WebSearch', 'Skill', 'TodoWrite',
        'EnterPlanMode', 'ExitPlanMode',
        'mcp__activity__query_activity',
        'mcp__mini-apps__open_mini_application',
        'mcp__mini-apps__build_and_open_mini_application',
        'mcp__notification__show_notification',
        'mcp__reaction__create_reaction_thread',
        'mcp__citeright__find_references', 'mcp__citeright__create_citation_report',
        'mcp__citeright__get_citation_report', 'mcp__citeright__add_claim_to_report',
        'mcp__citeright__search_citations_for_claim', 'mcp__citeright__format_citations',
        'mcp__citeright__list_citation_reports',
        'mcp__zotero__status', 'mcp__zotero__search_library',
        'mcp__zotero__get_item', 'mcp__zotero__add_doi',
        'mcp__google-drive__list_files', 'mcp__google-drive__search_files',
        'mcp__google-drive__get_file_metadata', 'mcp__google-drive__download_file',
        'mcp__grants__save_user_context', 'mcp__grants__create_project',
        'mcp__grants__get_project', 'mcp__grants__list_projects',
        'mcp__grants__favorite_opportunity', 'mcp__grants__hide_opportunity',
        'mcp__grants__set_hidden_reason', 'mcp__grants__visit_opportunity',
        'mcp__grants__update_project',
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
  }

  async stop(): Promise<void> {
    await this.deps.containerService.stopAgentServer();
    (globalThis as any).__hostMcpServers = null;
  }
}

async function migrateHostSessionsToContainer(workspacePath: string): Promise<void> {
  const markerPath = path.join(workspacePath, '.academia', 'claude-config', '.sessions-migrated');
  try { await fsPromises.access(markerPath); return; } catch { /* not migrated yet */ }

  const suffix = app.isPackaged ? '' : '-dev';
  const podmanHome = path.join(os.homedir(), `.cobuild-podman${suffix}`);
  const hostProjectsDir = path.join(podmanHome, '.claude', 'projects');
  const containerProjectsDir = path.join(workspacePath, '.academia', 'claude-config', 'projects', '-data');

  const hostExists = await fsPromises.access(hostProjectsDir).then(() => true, () => false);
  if (!hostExists) {
    await fsPromises.mkdir(path.dirname(markerPath), { recursive: true });
    await fsPromises.writeFile(markerPath, new Date().toISOString());
    return;
  }

  let copied = 0;
  try {
    await fsPromises.mkdir(containerProjectsDir, { recursive: true });

    const projectDirs = await fsPromises.readdir(hostProjectsDir);
    for (const projectDir of projectDirs) {
      const projectPath = path.join(hostProjectsDir, projectDir);
      const stat = await fsPromises.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fsPromises.readdir(projectPath);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const src = path.join(projectPath, file);
        const dest = path.join(containerProjectsDir, file);
        const destExists = await fsPromises.access(dest).then(() => true, () => false);
        if (destExists) continue;

        await fsPromises.copyFile(src, dest);
        copied++;

        const sessionId = file.replace('.jsonl', '');
        const subagentDir = path.join(projectPath, sessionId, 'subagents');
        const subagentExists = await fsPromises.access(subagentDir).then(() => true, () => false);
        if (subagentExists) {
          const destSubDir = path.join(containerProjectsDir, sessionId, 'subagents');
          await fsPromises.mkdir(destSubDir, { recursive: true });
          const subs = await fsPromises.readdir(subagentDir);
          for (const sub of subs) {
            await fsPromises.copyFile(path.join(subagentDir, sub), path.join(destSubDir, sub));
          }
        }
      }
    }
  } catch (err) {
    log.warn(`[SessionMigration] Error: ${(err as Error).message}`);
  }

  await fsPromises.mkdir(path.dirname(markerPath), { recursive: true });
  await fsPromises.writeFile(markerPath, new Date().toISOString());
  if (copied > 0) {
    log.info(`[SessionMigration] Migrated ${copied} session files from ${podmanHome} to container config`);
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
