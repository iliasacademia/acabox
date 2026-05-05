import React, { useState, useEffect, useCallback } from 'react';
import { LayoutGridIcon, PlusIcon, UploadIcon, ChevronRightIcon, PowerIcon, TrashIcon } from 'lucide-react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';

interface MiniAppEntry {
  name: string;
  dirName: string;
}

// --- Stub data (to be replaced with real data later) ---

interface PersonalizedStub {
  name: string;
  timeEstimate: string;
  description: string;
}

interface AvailableStub {
  name: string;
  description: string;
  tag: 'ON-DEMAND' | 'SCHEDULED';
  preBuilt?: boolean;
}

const PERSONALIZED_TOOLS_STUB: PersonalizedStub[] = [
  {
    name: 'Wound closure quantification pipeline',
    timeEstimate: '~45 MIN PER IMAGE SET',
    description: 'Automatically processes time-lapse scratch assay images and produces closure curves, summary statistics, and figures in your style.',
  },
  {
    name: 'Protocol templater',
    timeEstimate: '~30 MIN PER NEW PROTOCOL',
    description: 'Generates new protocol drafts in your lab\u2019s standard format from a brief description.',
  },
];

const AVAILABLE_TOOLS_STUB: AvailableStub[] = [
  { name: 'Peer Review Assistant', description: 'Manuscript review with structured feedback', tag: 'ON-DEMAND', preBuilt: true },
  { name: 'Literature Synthesis', description: 'Build a structured review across many papers', tag: 'ON-DEMAND', preBuilt: true },
  { name: 'Wound healing weekly', description: 'New papers \u00b7 weekly digest \u00b7 5 journals', tag: 'SCHEDULED' },
  { name: 'YAP/TAZ flag-watcher', description: 'Daily \u00b7 flags papers that contradict your work', tag: 'SCHEDULED' },
];

// --- End stub data ---

export function ToolsPage({
  workspacePath,
  onSelectApp,
  onSwitchToChat,
}: {
  workspacePath: string;
  onSelectApp: (dirName: string) => void;
  onSwitchToChat: () => void;
}) {
  const [apps, setApps] = useState<MiniAppEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const appsDir = `${workspacePath}/.applications`;
      const entries = await window.filesAPI.readDirectory(appsDir);
      const miniApps = entries
        .filter((e) => e.isDirectory && !e.name.startsWith('_'))
        .map((e) => {
          const raw = e.name.replace(/[-_]/g, ' ');
          return {
            name: raw.charAt(0).toUpperCase() + raw.slice(1),
            dirName: e.name,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
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

  const handleAddTool = useCallback(() => {
    assistantRuntime.switchToNewThread();
    setTimeout(() => {
      composerRuntime.setText('Make a new tool for me that does the following: ');
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

  const handleStubAction = useCallback(() => {
    alert('This is a placeholder for now.');
  }, []);

  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MiniAppEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async (app: MiniAppEntry) => {
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

  const installedCount = apps.length;
  const suggestedCount = PERSONALIZED_TOOLS_STUB.length;
  const availableCount = AVAILABLE_TOOLS_STUB.length;

  return (
    <div className="toolsPage">
      <div className="toolsPage__scroll">
        {/* Page header */}
        <div className="toolsPage__header">
          <div className="toolsPage__stats">
            {installedCount} INSTALLED &middot; {suggestedCount} SUGGESTED &middot; {availableCount} AVAILABLE
          </div>
          <h1 className="toolsPage__title">Tools</h1>
          <p className="toolsPage__subtitle">
            Things the workspace can do for you &mdash; on-demand or in the background. Install or uninstall any of these.
          </p>
          {/* Filter pills (stub — to be replaced later) */}
          <div className="toolsPage__filters">
            <button className="toolsPage__filterPill toolsPage__filterPill--active" onClick={handleStubAction}>All</button>
            <button className="toolsPage__filterPill" onClick={handleStubAction}>On-demand</button>
            <button className="toolsPage__filterPill" onClick={handleStubAction}>Scheduled</button>
          </div>
        </div>

        {/* Installed tools (real apps) */}
        <section className="toolsSection">
          <h2 className="toolsSection__heading">
            Installed
            <span className="toolsSection__count">{installedCount}</span>
          </h2>
          <div className="toolsCard">
            {loading && apps.length === 0 ? (
              <div className="toolsSection__empty">Loading...</div>
            ) : apps.length === 0 ? (
              <div className="toolsSection__empty">No tools installed yet</div>
            ) : (
              apps.map((app, i) => (
                <div key={app.dirName}>
                  <div className={`toolRow${i > 0 ? ' toolRow--bordered' : ''}`}>
                    <div className="toolRow__icon">
                      <LayoutGridIcon style={{ width: 18, height: 18 }} />
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
                        View
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
              ))
            )}
          </div>
        </section>

        {/* Personalized tools (stub — to be replaced later) */}
        <section className="toolsSection">
          <h2 className="toolsSection__heading">
            Personalized tools I can build for you
            <span className="toolsSection__count">{suggestedCount}</span>
            <span className="toolsSection__meta">&middot; based on patterns I noticed in your work</span>
          </h2>
          {PERSONALIZED_TOOLS_STUB.map((tool) => (
            <div key={tool.name} className="toolsCard toolsCard--spaced">
              <div className="toolRow toolRow--tall">
                <div className="toolRow__icon">
                  <LayoutGridIcon style={{ width: 18, height: 18 }} />
                </div>
                <div className="toolRow__info">
                  <div className="toolRow__header">
                    <button className="toolRow__name" onClick={handleStubAction}>
                      {tool.name}
                    </button>
                    <span className="toolRow__tag toolRow__tag--plain">{tool.timeEstimate}</span>
                  </div>
                  <div className="toolRow__description">{tool.description}</div>
                </div>
                <div className="toolRow__actions toolRow__actions--stacked">
                  <button className="toolRow__primaryBtn" onClick={handleStubAction}>
                    Build it
                  </button>
                  <button className="toolRow__secondaryBtn" onClick={handleStubAction}>
                    Skip
                  </button>
                </div>
              </div>
            </div>
          ))}
        </section>

        {/* Available tools (stub — to be replaced later) */}
        <section className="toolsSection">
          <h2 className="toolsSection__heading">
            Available tools
            <span className="toolsSection__count">{availableCount}</span>
          </h2>
          <div className="toolsCard">
            {AVAILABLE_TOOLS_STUB.map((tool, i) => (
              <div key={tool.name} className={`toolRow${i > 0 ? ' toolRow--bordered' : ''}`}>
                <div className="toolRow__icon">
                  <LayoutGridIcon style={{ width: 18, height: 18 }} />
                </div>
                <div className="toolRow__info">
                  <div className="toolRow__header">
                    <button className="toolRow__name" onClick={handleStubAction}>
                      {tool.name}
                    </button>
                    {tool.preBuilt && (
                      <span className="toolRow__tag toolRow__tag--prebuilt">PRE-BUILT</span>
                    )}
                    <span className="toolRow__tag toolRow__tag--plain">{tool.tag}</span>
                  </div>
                  <div className="toolRow__description">{tool.description}</div>
                  <div className="toolRow__status">not installed</div>
                </div>
                <div className="toolRow__actions">
                  <button className="toolRow__settingsBtn" onClick={handleStubAction}>
                    <ChevronRightIcon style={{ width: 14, height: 14 }} />
                    Settings
                  </button>
                  <button className="toolRow__primaryBtn" onClick={handleStubAction}>
                    <PowerIcon style={{ width: 14, height: 14 }} />
                    Install
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Footer actions */}
        <div className="toolsPage__footer">
          <button className="toolsPage__addBtn" onClick={handleAddTool}>
            <PlusIcon style={{ width: 16, height: 16 }} />
            Add a tool &mdash; describe what you want it to do
          </button>
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
    </div>
  );
}
