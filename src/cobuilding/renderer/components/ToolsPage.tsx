import React, { useState, useEffect, useCallback } from 'react';
import * as LucideIcons from 'lucide-react';
import { LayoutGridIcon, UploadIcon, ChevronRightIcon, PlayIcon, TrashIcon, SparklesIcon, ArrowRightIcon, FileTextIcon, FolderOpenIcon, XIcon } from 'lucide-react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';
import { ensureAccessibilityPermission } from '../utils/ensureAccessibilityPermission';

type ToolsPageMiniApp = MiniAppEntry;

// Resolve a Lucide icon by manifest name. Lucide exports each icon under both
// `Foo` and `FooIcon`; the agent typically writes the PascalCase form (e.g.
// "FlaskConical"), but we accept either. Falls back to the generic grid icon.
function resolveLucideIcon(name: string | null): React.ComponentType<{ style?: React.CSSProperties }> {
  if (!name) return LayoutGridIcon;
  const registry = LucideIcons as unknown as Record<string, React.ComponentType<{ style?: React.CSSProperties }>>;
  return registry[`${name}Icon`] ?? registry[name] ?? LayoutGridIcon;
}

function formatLastUsed(lastOpened: string | null): string | null {
  if (!lastOpened) return null;
  const then = Date.parse(lastOpened);
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'used just now';

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'used just now';
  if (diffMs < hour) {
    const m = Math.floor(diffMs / minute);
    return `used ${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diffMs < day) {
    const h = Math.floor(diffMs / hour);
    return `used ${h} hour${h === 1 ? '' : 's'} ago`;
  }
  if (diffMs < 30 * day) {
    const d = Math.floor(diffMs / day);
    return d === 1 ? 'used yesterday' : `used ${d} days ago`;
  }
  if (diffMs < 365 * day) {
    const months = Math.floor(diffMs / (30 * day));
    return `used ${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(diffMs / (365 * day));
  return `used ${years} year${years === 1 ? '' : 's'} ago`;
}

interface SuggestedMiniApp {
  name: string;
  type?: string;
  why_im_suggesting_this: string;
  description?: string;
  details_on_what_to_build?: string;
}

interface AvailableStub {
  name: string;
  description: string;
  tag: 'ON-DEMAND' | 'SCHEDULED';
  preBuilt?: boolean;
  lastOpened: string;
  status?: string;
  filePickerType?: 'manuscript' | 'grant' | 'presentation' | 'reference' | 'all' | 'manuscript_grant';
  chatPromptTemplate?: (filePath: string) => string;
  /**
   * If set, picking a file opens it in MS Word with the popup-v2 overlay
   * docked right (~33%) and a manuscript-specific kickoff prompt auto-sent
   * in the overlay's chat. Picker is filtered to .docx files only — Word's
   * find_and_replace MCP is the only host we have for live tracked-changes.
   */
  useWordOverlay?: boolean;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

const AVAILABLE_TOOLS_STUB: AvailableStub[] = [
  {
    name: 'Peer Review',
    description: 'Review your manuscript and provide structured feedback in MS Word',
    tag: 'ON-DEMAND',
    preBuilt: true,
    lastOpened: hoursAgoIso(2),
    filePickerType: 'manuscript',
    useWordOverlay: true,
  },
  { name: 'Grant Finder', description: 'Funding opportunities matched to your research', tag: 'ON-DEMAND', preBuilt: true, lastOpened: hoursAgoIso(72) },
  {
    name: 'Grant Writer',
    description: 'AI-assisted grant writing, specific aims, and narrative drafting',
    tag: 'ON-DEMAND',
    preBuilt: true,
    lastOpened: hoursAgoIso(72),
    filePickerType: 'grant',
    chatPromptTemplate: (filePath) =>
      `/academic-writing-agent\n\nPlease help me write and improve my grant proposal: ${filePath}`,
  },
  { name: 'Literature Synthesis', description: 'Build a structured review across many papers', tag: 'ON-DEMAND', preBuilt: true, lastOpened: hoursAgoIso(48) },
  { name: 'Paper Monitor', description: 'New papers in your topics, weekly digest', tag: 'SCHEDULED', preBuilt: true, lastOpened: hoursAgoIso(5), status: 'ran this morning \u00b7 4 items' },
  { name: 'Citation Alerts', description: 'When new work cites your publications', tag: 'SCHEDULED', preBuilt: true, lastOpened: hoursAgoIso(6), status: 'ran 6h ago \u00b7 1 new citation' },
  { name: 'Reactions', description: 'AI reactions to your browser and file activity, delivered periodically', tag: 'SCHEDULED', preBuilt: true, lastOpened: hoursAgoIso(24) },
];

import { resolveWorkspacePath } from '../utils/resolveWorkspacePath';

export function ToolsPage({
  workspacePath,
  userDirectoryPaths,
  onSelectApp,
  onSwitchToChat,
  onOpenReactions,
}: {
  workspacePath: string;
  userDirectoryPaths?: string[];
  onSelectApp: (dirName: string, opts?: { preBuilt?: boolean }) => void;
  onSwitchToChat: () => void;
  onOpenReactions: () => void;
}) {
  const [reactionsStatus, setReactionsStatus] = useState<string | null>(null);
  const [apps, setApps] = useState<ToolsPageMiniApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [suggestedApps, setSuggestedApps] = useState<SuggestedMiniApp[]>([]);
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const miniApps = await window.miniAppsAPI.list();
      // Most-recently-opened first; never-opened apps fall to the bottom,
      // tie-broken by name so the order is stable.
      miniApps.sort((a, b) => {
        const aTs = a.lastOpened ? Date.parse(a.lastOpened) : 0;
        const bTs = b.lastOpened ? Date.parse(b.lastOpened) : 0;
        if (aTs !== bTs) return bTs - aTs;
        return a.name.localeCompare(b.name);
      });
      setApps(miniApps);
    } catch {
      setApps([]);
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.settingsAPI.getReactionsEnabled().then((enabled) => {
      setReactionsStatus(enabled ? 'enabled' : 'not set up');
    });
  }, []);

  useEffect(() => {
    window.reportsAPI.getLatest('directory_scan').then((report) => {
      if (!report?.suggested_mini_apps) return;
      try {
        const parsed = JSON.parse(report.suggested_mini_apps);
        if (Array.isArray(parsed)) {
          const miniApps = parsed.filter(
            (s: SuggestedMiniApp) => !s.type || s.type === 'mini_app',
          );
          setSuggestedApps(miniApps);
        }
      } catch {
        // ignore malformed JSON
      }
    });
  }, []);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createToolText, setCreateToolText] = useState('');

  const handleCreateTool = useCallback(() => {
    const text = createToolText.trim();
    if (!text) return;
    setShowCreateModal(false);
    setCreateToolText('');
    assistantRuntime.switchToNewThread();
    setTimeout(() => {
      composerRuntime.setText(`Create a tool for me that does the following:\n\n${text}`);
      composerRuntime.send();
      onSwitchToChat();
    }, 0);
  }, [createToolText, assistantRuntime, composerRuntime, onSwitchToChat]);

  const handleImportTool = useCallback(async () => {
    setImporting(true);
    try {
      const result = await window.miniAppsAPI.importApp();
      if (result.ok && result.dirName) {
        await refresh();
        onSelectApp(result.dirName);
        window.containerAPI.ensureAppDeps(result.dirName).catch(() => {});
      } else if (!result.canceled) {
        console.error('Import failed:', result.error);
      }
    } finally {
      setImporting(false);
    }
  }, [refresh, onSelectApp]);

  const handleBuildSuggested = useCallback((tool: SuggestedMiniApp) => {
    assistantRuntime.switchToNewThread();
    setTimeout(() => {
      composerRuntime.setText(`Build me a tool called "${tool.name}". ${tool.description ?? tool.details_on_what_to_build}`);
      onSwitchToChat();
      setTimeout(() => {
        const input = document.querySelector<HTMLTextAreaElement>('.composerInput');
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
        const shell = document.querySelector('.composerShell');
        if (shell) {
          shell.classList.remove('composerShell--highlight');
          void (shell as HTMLElement).offsetWidth;
          shell.classList.add('composerShell--highlight');
        }
      }, 0);
    }, 0);
  }, [assistantRuntime, composerRuntime, onSwitchToChat]);

  const handleDismissSuggested = useCallback((tool: SuggestedMiniApp) => {
    setSuggestedApps((prev) => prev.filter((t) => t.name !== tool.name));
  }, []);

  const [toolFilter, setToolFilter] = useState<'all' | 'on-demand' | 'scheduled'>('all');
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ToolsPageMiniApp | null>(null);
  const [deleting, setDeleting] = useState(false);

  // File picker modal for pre-built writing tools
  const [filePicker, setFilePicker] = useState<{
    stub: AvailableStub;
    files: ScannedFile[];
    loading: boolean;
  } | null>(null);

  const handleOpenFilePicker = useCallback(async (stub: AvailableStub) => {
    if (!stub.filePickerType) { alert('This is a placeholder for now.'); return; }
    setFilePicker({ stub, files: [], loading: true });
    try {
      let files = (stub.filePickerType === 'all' || stub.filePickerType === 'manuscript_grant')
        ? await window.scannedFilesAPI.getAll()
        : await window.scannedFilesAPI.getByType(stub.filePickerType);
      // The Word-overlay flow needs an editable .docx (ms-word MCP target),
      // so prune the picker to that subset.
      if (stub.useWordOverlay) {
        files = files.filter((f) => f.file_path.toLowerCase().endsWith('.docx'));
        // Fall back to every .docx in the workspace when nothing was tagged
        // as a manuscript yet — only workspace files work here, so we
        // surface them inline rather than punting to a Browse dialog.
        if (files.length === 0) {
          const docx = await window.filesAPI.findByExtension(['docx']);
          files = docx.map((f) => {
            const name = f.relPath.split('/').pop() ?? f.relPath;
            return {
              id: f.relPath,
              workspace_id: '',
              report_id: null,
              file_path: f.relPath,
              file_name: name,
              file_type: 'manuscript' as const,
              created_at: '',
            };
          });
        }
      }
      setFilePicker((prev) => prev ? { ...prev, files, loading: false } : null);
    } catch {
      setFilePicker((prev) => prev ? { ...prev, files: [], loading: false } : null);
    }
  }, []);

  const handlePickFile = useCallback(async (stub: AvailableStub, filePath: string) => {
    if (stub.useWordOverlay) {
      if (!(await ensureAccessibilityPermission())) return;
      const absolutePath = resolveWorkspacePath(filePath, workspacePath, userDirectoryPaths ?? []);
      const fileUrl = absolutePath.startsWith('file://') ? absolutePath : `file://${absolutePath}`;
      setFilePicker(null);
      try {
        await window.fileMonitorAPI.requestNewOverlayChatForDocument(absolutePath);
      } catch (err) {
        console.warn('[PeerReviewAssistant] Failed to request new overlay chat:', err);
      }
      window.fileMonitorAPI.openFile(fileUrl, 'com.microsoft.Word');
      window.fileMonitorAPI.setDockRightForDocument(absolutePath, true);
      return;
    }
    setFilePicker(null);
    if (!stub.chatPromptTemplate) return;
    assistantRuntime.switchToNewThread();
    onSwitchToChat();
    setTimeout(() => {
      composerRuntime.setText(stub.chatPromptTemplate!(filePath));
      composerRuntime.send();
    }, 100);
  }, [assistantRuntime, composerRuntime, onSwitchToChat, workspacePath, userDirectoryPaths]);

  const handleBrowseFile = useCallback(async (stub: AvailableStub) => {
    setFilePicker(null);
    const filePath = await window.filesAPI.selectFile();
    if (!filePath || !stub.chatPromptTemplate) return;
    assistantRuntime.switchToNewThread();
    onSwitchToChat();
    setTimeout(() => {
      composerRuntime.setText(stub.chatPromptTemplate!(filePath));
      composerRuntime.send();
    }, 100);
  }, [assistantRuntime, composerRuntime, onSwitchToChat]);

  const handleStubAction = useCallback((stub: AvailableStub) => {
    if (stub.name === 'Reactions') {
      onOpenReactions();
      return;
    }
    if (stub.filePickerType) {
      handleOpenFilePicker(stub);
    } else {
      alert('This is a placeholder for now.');
    }
  }, [handleOpenFilePicker, onOpenReactions]);

  const handleDelete = useCallback(async (app: ToolsPageMiniApp) => {
    setDeleting(true);
    try {
      const appDir = `${workspacePath}/.applications/${app.dirName}`;
      await window.filesAPI.deleteFile(appDir);
      setConfirmDelete(null);
      setSettingsOpen(null);
      await refresh();
    } catch (err) {
      console.error('Failed to delete tool:', err);
    } finally {
      setDeleting(false);
    }
  }, [workspacePath, refresh]);

  const suggestedCount = suggestedApps.length;
  const toolCount = apps.length + AVAILABLE_TOOLS_STUB.length;

  return (
    <div className="pageShell">
      <div className="pageShell__inner">
        {/* Page header */}
        <div className="pageShell__headerBlock">
          <div className="pageShell__stats">
            {toolCount} TOOLS AVAILABLE
          </div>
          <h1 className="pageShell__title">Tools</h1>
          <p className="pageShell__subtitle">
            Things the workspace can do for you &mdash; on-demand or in the background. All tools are ready to use; configure their settings when you want to tune behavior.
          </p>
        </div>

        {/* Ask me CTA */}
        <button className="toolsAskCard" onClick={() => setShowCreateModal(true)}>
          <div className="toolsAskCard__icon">
            <SparklesIcon style={{ width: 20, height: 20 }} />
          </div>
          <div className="toolsAskCard__text">
            <div className="toolsAskCard__title">Ask me to do something or build a tool</div>
            <div className="toolsAskCard__description">Describe what you need &mdash; I&rsquo;ll either do it now as a one-time task, or build it as a tool you can return to.</div>
          </div>
          <ArrowRightIcon className="toolsAskCard__arrow" style={{ width: 18, height: 18 }} />
        </button>

        {/* Personalized tools from directory scan */}
        {suggestedApps.length > 0 && (
          <section className="toolsSection">
            <h2 className="toolsSection__heading">
              Tools I can build for you
              <span className="toolsSection__count">{suggestedCount}</span>
              <span className="toolsSection__meta">&middot; based on patterns I noticed in your work</span>
            </h2>
            <div className="toolsCard">
              {suggestedApps.map((tool, i) => {
                const bordered = i > 0 ? ' toolRow--bordered' : '';
                return (
                  <div key={tool.name} className={`toolRow${bordered}`}>
                    <div className="toolRow__icon">
                      <LayoutGridIcon style={{ width: 18, height: 18 }} />
                    </div>
                    <div className="toolRow__info">
                      <div className="toolRow__header">
                        <button className="toolRow__name" onClick={() => handleBuildSuggested(tool)}>
                          {tool.name}
                        </button>
                      </div>
                      <div className="toolRow__description">{tool.why_im_suggesting_this}</div>
                    </div>
                    <div className="toolRow__actions">
                      <button className="toolRow__secondaryBtn" onClick={() => handleDismissSuggested(tool)}>
                        Skip
                      </button>
                      <button className="toolRow__primaryBtn" onClick={() => handleBuildSuggested(tool)}>
                        Build it
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Tools I've built for you (installed mini-apps) */}
        <section className="toolsSection">
          <h2 className="toolsSection__heading">
            Tools I&rsquo;ve built for you
            <span className="toolsSection__count">{apps.length}</span>
          </h2>
          <div className="toolsCard">
            {loading && apps.length === 0 ? (
              <div className="toolsSection__empty">Loading...</div>
            ) : (() => {
              if (apps.length === 0) {
                return (
                  <div className="toolsSection__empty">
                    You haven’t built any tools yet — describe one above to get started.
                  </div>
                );
              }
              return apps.map((app, i) => {
                const bordered = i > 0 ? ' toolRow--bordered' : '';
                const Icon = resolveLucideIcon(app.icon);
                return (
                  <div key={`app:${app.dirName}`}>
                    <div className={`toolRow${bordered}`}>
                      <div className="toolRow__icon">
                        <Icon style={{ width: 18, height: 18 }} />
                      </div>
                      <div className="toolRow__info">
                        <div className="toolRow__header">
                          <button
                            className="toolRow__name"
                            onClick={() => onSelectApp(app.dirName, { preBuilt: app.preBuilt })}
                          >
                            {app.name}
                          </button>
                          {app.preBuilt && <span className="toolRow__tag toolRow__tag--prebuilt">PRE-BUILT</span>}
                          <span className="toolRow__tag toolRow__tag--plain">ON-DEMAND</span>
                        </div>
                        {app.description && <div className="toolRow__description">{app.description}</div>}
                        {(() => {
                          const status = formatLastUsed(app.lastOpened);
                          return status ? <div className="toolRow__status">{status}</div> : null;
                        })()}
                      </div>
                      <div className="toolRow__actions">
                        <button
                          className="toolRow__settingsBtn"
                          onClick={() => setSettingsOpen(settingsOpen === app.dirName ? null : app.dirName)}
                        >
                          <ChevronRightIcon style={{ width: 14, height: 14, transform: settingsOpen === app.dirName ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                          Settings
                        </button>
                        <button
                          className="toolRow__primaryBtn"
                          onClick={() => onSelectApp(app.dirName, { preBuilt: app.preBuilt })}
                        >
                          <PlayIcon style={{ width: 14, height: 14 }} />
                          Use
                        </button>
                      </div>
                    </div>
                    {settingsOpen === app.dirName && (
                      <div className="toolRow__settingsPanel">
                        <button
                          className="toolRow__deleteBtn"
                          onClick={() => setConfirmDelete(app)}
                        >
                          <TrashIcon style={{ width: 14, height: 14 }} />
                          Delete tool
                        </button>
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </section>

        {/* Other available tools (pre-built stubs) */}
        <section className="toolsSection">
          <div className="toolsSection__headingRow">
            <h2 className="toolsSection__heading">
              Other available tools
              <span className="toolsSection__count">{AVAILABLE_TOOLS_STUB.length}</span>
            </h2>
            <div className="toolsPage__filters">
              <button className={`toolsPage__filterPill${toolFilter === 'all' ? ' toolsPage__filterPill--active' : ''}`} onClick={() => setToolFilter('all')}>All</button>
              <button className={`toolsPage__filterPill${toolFilter === 'on-demand' ? ' toolsPage__filterPill--active' : ''}`} onClick={() => setToolFilter('on-demand')}>On-demand</button>
              <button className={`toolsPage__filterPill${toolFilter === 'scheduled' ? ' toolsPage__filterPill--active' : ''}`} onClick={() => setToolFilter('scheduled')}>Scheduled</button>
            </div>
          </div>
          <div className="toolsCard">
            {(() => {
              const filteredStubs = AVAILABLE_TOOLS_STUB.filter((stub) => {
                if (toolFilter === 'all') return true;
                if (toolFilter === 'on-demand') return stub.tag === 'ON-DEMAND';
                if (toolFilter === 'scheduled') return stub.tag === 'SCHEDULED';
                return true;
              });
              const sortedStubs = [...filteredStubs].sort(
                (a, b) => Date.parse(b.lastOpened) - Date.parse(a.lastOpened),
              );
              if (sortedStubs.length === 0) {
                return <div className="toolsSection__empty">No tools match this filter.</div>;
              }
              return sortedStubs.map((tool, i) => {
                const bordered = i > 0 ? ' toolRow--bordered' : '';
                const stubAction = () => handleStubAction(tool);
                return (
                  <div key={`stub:${tool.name}`} className={`toolRow${bordered}`}>
                    <div className="toolRow__icon">
                      <LayoutGridIcon style={{ width: 18, height: 18 }} />
                    </div>
                    <div className="toolRow__info">
                      <div className="toolRow__header">
                        <button className="toolRow__name" onClick={stubAction}>
                          {tool.name}
                        </button>
                        <span className="toolRow__tag toolRow__tag--prebuilt">PRE-BUILT</span>
                        <span className="toolRow__tag toolRow__tag--plain">{tool.tag}</span>
                      </div>
                      <div className="toolRow__description">{tool.description}</div>
                      {(() => {
                        const status = tool.name === 'Reactions' ? reactionsStatus : (tool.status ?? formatLastUsed(tool.lastOpened));
                        return status ? <div className="toolRow__status">{status}</div> : null;
                      })()}
                    </div>
                    <div className="toolRow__actions">
                      {!tool.useWordOverlay && (
                        <button className="toolRow__settingsBtn" onClick={() => handleStubAction(tool)}>
                          <ChevronRightIcon style={{ width: 14, height: 14 }} />
                          Settings
                        </button>
                      )}
                      {tool.tag === 'SCHEDULED' ? (
                        <button className="toolRow__primaryBtn" onClick={() => handleStubAction(tool)}>
                          View outputs
                        </button>
                      ) : (
                        <button className="toolRow__primaryBtn" onClick={stubAction}>
                          <PlayIcon style={{ width: 14, height: 14 }} />
                          Use
                        </button>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </section>

        {/* Footer actions */}
        <div className="toolsPage__footer">
          <button className="toolsPage__addBtn" onClick={handleImportTool} disabled={importing}>
            <UploadIcon style={{ width: 16, height: 16 }} />
            {importing ? 'Importing...' : 'Import tool'}
          </button>
        </div>
      </div>

      {confirmDelete && (
        <div className="toolsConfirmOverlay" onClick={() => !deleting && setConfirmDelete(null)}>
          <div className="toolsConfirmModal" onClick={(e) => e.stopPropagation()}>
            <h3 className="toolsConfirmModal__title">Delete tool</h3>
            <p className="toolsConfirmModal__message">
              Are you sure you want to delete <strong>{confirmDelete.name}</strong>? This will remove all of its files and cannot be undone.
            </p>
            <div className="toolsConfirmModal__actions">
              <button
                className="toolRow__secondaryBtn"
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="toolRow__deleteBtn"
                onClick={() => handleDelete(confirmDelete)}
                disabled={deleting}
              >
                <TrashIcon style={{ width: 14, height: 14 }} />
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {filePicker && (
        <div
          className="toolsConfirmOverlay"
          onClick={() => setFilePicker(null)}
        >
          <div className="filePickerModal" onClick={(e) => e.stopPropagation()}>

            <div className="filePickerModal__header">
              <div>
                <h2 className="filePickerModal__title">{filePicker.stub.name}</h2>
                <p className="filePickerModal__subtitle">
                  {filePicker.stub.useWordOverlay
                    ? 'Pick a manuscript to open in Word with the Peer Review Assistant alongside.'
                    : 'Select a file to work on, or browse to choose one.'}
                </p>
              </div>
              <button
                className="filePickerModal__close"
                onClick={() => setFilePicker(null)}
              >
                <XIcon style={{ width: 16, height: 16 }} />
              </button>
            </div>

            <div className="filePickerModal__body">
              {filePicker.loading ? (
                <div className="filePickerModal__empty">Loading files…</div>
              ) : filePicker.files.length === 0 ? (
                <div className="filePickerModal__empty">
                  {filePicker.stub.useWordOverlay
                    ? 'No .docx files found in your workspace. Add a manuscript to your workspace folder and try again.'
                    : 'No tagged files found from your last scan. Use "Browse files" to select manually.'}
                </div>
              ) : (
                (['manuscript', 'grant', 'presentation', 'reference'] as const)
                  .filter((type) => {
                    if (filePicker.stub.filePickerType === 'all') return filePicker.files.some((f) => f.file_type === type);
                    if (filePicker.stub.filePickerType === 'manuscript_grant') return (type === 'manuscript' || type === 'grant') && filePicker.files.some((f) => f.file_type === type);
                    return type === filePicker.stub.filePickerType;
                  })
                  .map((type) => {
                    const group = filePicker.files.filter((f) => f.file_type === type);
                    if (group.length === 0) return null;
                    const label = type === 'manuscript' ? 'Manuscripts' : type === 'grant' ? 'Grants' : type === 'reference' ? 'References' : 'Presentations';
                    return (
                      <div key={type} className="filePickerModal__group">
                        <div className="filePickerModal__groupLabel">{label}</div>
                        {group.map((file, i) => (
                          <button
                            key={file.id}
                            className={`filePickerModal__row${i > 0 ? ' filePickerModal__row--bordered' : ''}`}
                            onClick={() => handlePickFile(filePicker.stub, file.file_path)}
                          >
                            <FileTextIcon className="filePickerModal__rowIcon" />
                            <span className="filePickerModal__rowName">{file.file_name}</span>
                            <span className="filePickerModal__rowPath">{file.file_path}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })
              )}
            </div>

            <div className="filePickerModal__footer">
              <button
                className="createToolModal__cancelBtn"
                onClick={() => setFilePicker(null)}
              >
                Cancel
              </button>
              {!filePicker.stub.useWordOverlay && (
                <button
                  className="createToolModal__createBtn"
                  onClick={() => handleBrowseFile(filePicker.stub)}
                >
                  <FolderOpenIcon style={{ width: 14, height: 14, marginRight: 6 }} />
                  Browse files
                </button>
              )}
            </div>

          </div>
        </div>
      )}

      {showCreateModal && (
        <div className="toolsConfirmOverlay" onClick={() => setShowCreateModal(false)}>
          <div className="createToolModal" onClick={(e) => e.stopPropagation()}>
            <button className="createToolModal__close" onClick={() => setShowCreateModal(false)}>&times;</button>
            <h2 className="createToolModal__title">Create a tool</h2>
            <p className="createToolModal__subtitle">
              Describe what you&rsquo;d like your new tool to do and how you want it to work.
            </p>
            <textarea
              className="createToolModal__textarea"
              placeholder="e.g. Analyze scratch assay images and produce closure curves..."
              value={createToolText}
              onChange={(e) => setCreateToolText(e.target.value)}
              rows={5}
              autoFocus
            />
            <div className="createToolModal__actions">
              <button
                className="createToolModal__cancelBtn"
                onClick={() => setShowCreateModal(false)}
              >
                Cancel
              </button>
              <button
                className="createToolModal__createBtn"
                onClick={handleCreateTool}
                disabled={!createToolText.trim()}
              >
                Create Tool
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
