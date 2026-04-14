import React, { useState, useEffect, useCallback } from 'react';
import { LayoutGridIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';

interface MiniAppEntry {
  name: string;
  dirName: string;
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
  const [apps, setApps] = useState<MiniAppEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<MiniAppEntry | null>(null);
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const appsDir = `${workspacePath}/.applications`;
      const entries = await window.filesAPI.readDirectory(appsDir);
      const miniApps = entries
        .filter((e) => e.isDirectory && !e.name.startsWith('_'))
        .map((e) => ({
          name: e.name.replace(/[-_]/g, ' '),
          dirName: e.name,
        }))
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

  const handleDeleteApp = useCallback(async (app: MiniAppEntry) => {
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
      {loading && apps.length === 0 ? (
        <div className="miniAppsTabEmpty">Loading…</div>
      ) : apps.length === 0 ? (
        <div className="miniAppsTabEmpty">No applications yet</div>
      ) : (
        <div className="miniAppsTabList">
          {apps.map((app) => (
            <div key={app.dirName} className={`miniAppsTabItem${activeAppDirName === app.dirName ? ' miniAppsTabItem--active' : ''}`}>
              <button
                className="miniAppsTabItemTrigger"
                onClick={() => onSelectApp(app.dirName)}
              >
                <LayoutGridIcon style={{ width: 16, height: 16, flexShrink: 0 }} />
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
          ))}
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
