import React, { useState, useEffect, useCallback } from 'react';
import * as LucideIcons from 'lucide-react';
import { LayoutGridIcon, PlusIcon, TrashIcon, UploadIcon } from 'lucide-react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';

type MiniAppsTabApp = MiniAppEntry;

function resolveLucideIcon(name: string | null): React.ComponentType<{ style?: React.CSSProperties }> {
  if (!name) return LayoutGridIcon;
  const registry = LucideIcons as unknown as Record<string, React.ComponentType<{ style?: React.CSSProperties }>>;
  return registry[`${name}Icon`] ?? registry[name] ?? LayoutGridIcon;
}

export function MiniAppsTab({
  workspacePath,
  onSelectApp,
  onDeleteApp,
  onNewApplication,
  activeAppDirName,
  autoSelectFirst,
  onAutoSelectDone,
}: {
  workspacePath: string;
  onSelectApp: (dirName: string) => void;
  onDeleteApp?: (dirName: string) => void;
  onNewApplication?: () => void;
  activeAppDirName?: string;
  autoSelectFirst?: boolean;
  onAutoSelectDone?: () => void;
}) {
  const [apps, setApps] = useState<MiniAppsTabApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<MiniAppsTabApp | null>(null);
  const [importing, setImporting] = useState(false);
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const miniApps = await window.miniAppsAPI.list();
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

  // Auto-select first app when requested (e.g. clicking Apps nav with no miniapp tabs open)
  useEffect(() => {
    if (autoSelectFirst && apps.length > 0) {
      onSelectApp(apps[0].dirName);
      onAutoSelectDone?.();
    } else if (autoSelectFirst && !loading && apps.length === 0) {
      // No apps available — clear the flag
      onAutoSelectDone?.();
    }
  }, [autoSelectFirst, apps, loading, onSelectApp, onAutoSelectDone]);

  const handleDeleteApp = useCallback(async (app: MiniAppsTabApp) => {
    try {
      const appDir = `${workspacePath}/.applications/${app.dirName}`;
      await window.filesAPI.deleteFile(appDir);
      setApps(prev => prev.filter(a => a.dirName !== app.dirName));
      onDeleteApp?.(app.dirName);
    } catch (err) {
      console.error('Failed to delete app:', err);
    } finally {
      setPendingDelete(null);
    }
  }, [workspacePath]);

  const handleImportApp = useCallback(async () => {
    setImporting(true);
    try {
      const result = await window.miniAppsAPI.importApp();
      if (result.ok && result.dirName) {
        // Show the app in the sidebar and open it immediately
        await refresh();
        onSelectApp(result.dirName);
        // Install deps in the background — the ContainerGate will show
        // "Installing software..." via the ensureAppDeps IPC
        window.containerAPI.ensureAppDeps(result.dirName).catch(() => {});
      } else if (!result.canceled) {
        console.error('Import failed:', result.error);
      }
    } finally {
      setImporting(false);
    }
  }, [refresh, onSelectApp]);

  const handleNewApplication = useCallback(() => {
    assistantRuntime.switchToNewThread();
    // Set composer text after the thread switch settles
    setTimeout(() => {
      composerRuntime.setText('Make a new application for me that does the following: ');
      onNewApplication?.();
      // Focus the composer input and highlight after tab switch renders
      setTimeout(() => {
        const input = document.querySelector<HTMLTextAreaElement>('.composerInput');
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
        const shell = document.querySelector('.composerShell');
        if (shell) {
          shell.classList.remove('composerShell--highlight');
          // Force reflow so re-adding the class restarts the animation
          void (shell as HTMLElement).offsetWidth;
          shell.classList.add('composerShell--highlight');
        }
      }, 0);
    }, 0);
  }, [assistantRuntime, composerRuntime, onNewApplication]);

  return (
    <div className="miniAppsTab">
      <button className="threadListNewBtn" onClick={handleNewApplication}>
        <PlusIcon style={{ width: 16, height: 16 }} />
        New Application
      </button>
      <button className="threadListNewBtn miniAppsImportBtn" onClick={handleImportApp} disabled={importing}>
        <UploadIcon style={{ width: 16, height: 16 }} />
        {importing ? 'Importing…' : 'Import App'}
      </button>
      {loading && apps.length === 0 ? (
        <div className="miniAppsTabEmpty">Loading…</div>
      ) : apps.length === 0 ? (
        <div className="miniAppsTabEmpty">No applications yet</div>
      ) : (
        <div className="miniAppsTabList">
          {apps.map((app) => {
            const Icon = resolveLucideIcon(app.icon);
            return (
            <div key={app.dirName} className={`miniAppsTabItem${activeAppDirName === app.dirName ? ' miniAppsTabItem--active' : ''}`}>
              <button
                className="miniAppsTabItemTrigger"
                onClick={() => onSelectApp(app.dirName)}
              >
                <Icon style={{ width: 16, height: 16, flexShrink: 0 }} />
                <span className="miniAppsTabItemName">{app.name}</span>
              </button>
              <button
                className="miniAppsTabItemAction miniAppsTabItemDelete"
                onClick={(e) => { e.stopPropagation(); setPendingDelete(app); }}
                title="Delete application"
              >
                <TrashIcon style={{ width: 14, height: 14 }} />
              </button>
            </div>
            );
          })}
        </div>
      )}
      {pendingDelete && (
        <div className="miniAppsModal__overlay" onClick={() => setPendingDelete(null)}>
          <div className="miniAppsModal" onClick={e => e.stopPropagation()}>
            <p className="miniAppsModal__message">
              Are you sure you want to delete this application?
            </p>
            <div className="miniAppsModal__actions">
              <button className="miniAppsModal__btn" onClick={() => setPendingDelete(null)}>
                Cancel
              </button>
              <button
                className="miniAppsModal__btn miniAppsModal__btn--danger"
                onClick={() => handleDeleteApp(pendingDelete)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
