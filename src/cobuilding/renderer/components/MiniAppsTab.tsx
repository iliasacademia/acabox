import React, { useState, useEffect, useCallback } from 'react';
import { LayoutGridIcon, PlusIcon } from 'lucide-react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';

interface MiniAppEntry {
  name: string;
  dirName: string;
}

export function MiniAppsTab({
  workspacePath,
  onSelectApp,
  onNewApplication,
}: {
  workspacePath: string;
  onSelectApp: (dirName: string) => void;
  onNewApplication?: () => void;
}) {
  const [apps, setApps] = useState<MiniAppEntry[]>([]);
  const [loading, setLoading] = useState(false);
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
            <button
              key={app.dirName}
              className="miniAppsTabItem"
              onClick={() => onSelectApp(app.dirName)}
            >
              <LayoutGridIcon style={{ width: 16, height: 16, flexShrink: 0 }} />
              <span className="miniAppsTabItemName">{app.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
