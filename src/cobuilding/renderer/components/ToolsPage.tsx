import React, { useState, useEffect, useCallback } from 'react';
import * as LucideIcons from 'lucide-react';
import { LayoutGridIcon, UploadIcon, ChevronRightIcon, PlayIcon, TrashIcon, SparklesIcon, ArrowRightIcon } from 'lucide-react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';

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
  why_im_suggesting_this: string;
  details_on_what_to_build: string;
}

interface AvailableStub {
  name: string;
  description: string;
  tag: 'ON-DEMAND' | 'SCHEDULED';
  preBuilt?: boolean;
  lastOpened: string;
  status?: string;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

const AVAILABLE_TOOLS_STUB: AvailableStub[] = [
  { name: 'Grant Finder', description: 'Funding opportunities matched to your research', tag: 'ON-DEMAND', preBuilt: true, lastOpened: hoursAgoIso(72) },
  { name: 'Peer Review Assistant', description: 'Manuscript review with structured feedback', tag: 'ON-DEMAND', preBuilt: true, lastOpened: hoursAgoIso(240) },
  { name: 'Literature Synthesis', description: 'Build a structured review across many papers', tag: 'ON-DEMAND', preBuilt: true, lastOpened: hoursAgoIso(48) },
  { name: 'Paper Monitor', description: 'New papers in your topics, weekly digest', tag: 'SCHEDULED', preBuilt: true, lastOpened: hoursAgoIso(5), status: 'ran this morning \u00b7 4 items' },
  { name: 'Citation Alerts', description: 'When new work cites your publications', tag: 'SCHEDULED', preBuilt: true, lastOpened: hoursAgoIso(6), status: 'ran 6h ago \u00b7 1 new citation' },
];

export function ToolsPage({
  workspacePath,
  onSelectApp,
  onSwitchToChat,
}: {
  workspacePath: string;
  onSelectApp: (dirName: string) => void;
  onSwitchToChat: () => void;
}) {
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
    window.reportsAPI.getLatest('directory_scan').then((report) => {
      if (!report?.suggested_mini_apps) return;
      try {
        const parsed = JSON.parse(report.suggested_mini_apps);
        if (Array.isArray(parsed)) setSuggestedApps(parsed);
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
    onSwitchToChat();
    setTimeout(() => {
      composerRuntime.setText(
        `Please build the following mini-app for me:\n\n${tool.details_on_what_to_build}`
      );
      composerRuntime.send();
    }, 100);
  }, [assistantRuntime, composerRuntime, onSwitchToChat]);

  const handleDismissSuggested = useCallback((tool: SuggestedMiniApp) => {
    setSuggestedApps((prev) => prev.filter((t) => t.name !== tool.name));
  }, []);

  const handleStubAction = useCallback(() => {
    alert('This is a placeholder for now.');
  }, []);

  const [toolFilter, setToolFilter] = useState<'all' | 'on-demand' | 'scheduled'>('all');
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ToolsPageMiniApp | null>(null);
  const [deleting, setDeleting] = useState(false);

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
            {suggestedApps.map((tool) => (
              <div key={tool.name} className="toolsCard toolsCard--spaced">
                <div className="toolRow toolRow--tall">
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
                  <div className="toolRow__actions toolRow__actions--stacked">
                    <button className="toolRow__primaryBtn" onClick={() => handleBuildSuggested(tool)}>
                      Build it
                    </button>
                    <button className="toolRow__secondaryBtn" onClick={() => handleDismissSuggested(tool)}>
                      Skip
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Available tools (installed + pre-built) */}
        <section className="toolsSection">
          <div className="toolsSection__headingRow">
            <h2 className="toolsSection__heading">
              Available tools
              <span className="toolsSection__count">{toolCount}</span>
            </h2>
            <div className="toolsPage__filters">
              <button className={`toolsPage__filterPill${toolFilter === 'all' ? ' toolsPage__filterPill--active' : ''}`} onClick={() => setToolFilter('all')}>All</button>
              <button className={`toolsPage__filterPill${toolFilter === 'on-demand' ? ' toolsPage__filterPill--active' : ''}`} onClick={() => setToolFilter('on-demand')}>On-demand</button>
              <button className={`toolsPage__filterPill${toolFilter === 'scheduled' ? ' toolsPage__filterPill--active' : ''}`} onClick={() => setToolFilter('scheduled')}>Scheduled</button>
            </div>
          </div>
          <div className="toolsCard">
            {loading && apps.length === 0 ? (
              <div className="toolsSection__empty">Loading...</div>
            ) : (
              <>
                {(() => {
                  type Item =
                    | { kind: 'installed'; key: string; lastTs: number; app: ToolsPageMiniApp }
                    | { kind: 'stub'; key: string; lastTs: number; stub: AvailableStub };
                  const items: Item[] = [
                    ...apps.map<Item>((app) => ({
                      kind: 'installed',
                      key: `app:${app.dirName}`,
                      lastTs: app.lastOpened ? Date.parse(app.lastOpened) : 0,
                      app,
                    })),
                    ...AVAILABLE_TOOLS_STUB.map<Item>((stub) => ({
                      kind: 'stub',
                      key: `stub:${stub.name}`,
                      lastTs: Date.parse(stub.lastOpened),
                      stub,
                    })),
                  ];
                  const filtered = items.filter((item) => {
                    if (toolFilter === 'all') return true;
                    const tag = item.kind === 'installed' ? 'ON-DEMAND' : item.stub.tag;
                    if (toolFilter === 'on-demand') return tag === 'ON-DEMAND';
                    if (toolFilter === 'scheduled') return tag === 'SCHEDULED';
                    return true;
                  });
                  filtered.sort((a, b) => b.lastTs - a.lastTs);
                  return filtered.map((item, i) => {
                    const bordered = i > 0 ? ' toolRow--bordered' : '';
                    if (item.kind === 'installed') {
                      const { app } = item;
                      const Icon = resolveLucideIcon(app.icon);
                      return (
                        <div key={item.key}>
                          <div className={`toolRow${bordered}`}>
                            <div className="toolRow__icon">
                              <Icon style={{ width: 18, height: 18 }} />
                            </div>
                            <div className="toolRow__info">
                              <div className="toolRow__header">
                                <button
                                  className="toolRow__name"
                                  onClick={() => onSelectApp(app.dirName)}
                                >
                                  {app.name}
                                </button>
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
                                onClick={() => onSelectApp(app.dirName)}
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
                    }
                    const { stub: tool } = item;
                    return (
                      <div key={item.key} className={`toolRow${bordered}`}>
                        <div className="toolRow__icon">
                          <LayoutGridIcon style={{ width: 18, height: 18 }} />
                        </div>
                        <div className="toolRow__info">
                          <div className="toolRow__header">
                            <button className="toolRow__name" onClick={handleStubAction}>
                              {tool.name}
                            </button>
                            <span className="toolRow__tag toolRow__tag--prebuilt">PRE-BUILT</span>
                            <span className="toolRow__tag toolRow__tag--plain">{tool.tag}</span>
                          </div>
                          <div className="toolRow__description">{tool.description}</div>
                          {(() => {
                            const status = tool.status ?? formatLastUsed(tool.lastOpened);
                            return status ? <div className="toolRow__status">{status}</div> : null;
                          })()}
                        </div>
                        <div className="toolRow__actions">
                          <button className="toolRow__settingsBtn" onClick={handleStubAction}>
                            <ChevronRightIcon style={{ width: 14, height: 14 }} />
                            Settings
                          </button>
                          {tool.tag === 'SCHEDULED' ? (
                            <button className="toolRow__primaryBtn" onClick={handleStubAction}>
                              View outputs
                            </button>
                          ) : (
                            <button className="toolRow__primaryBtn" onClick={handleStubAction}>
                              <PlayIcon style={{ width: 14, height: 14 }} />
                              Use
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  });
                })()}
              </>
            )}
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
