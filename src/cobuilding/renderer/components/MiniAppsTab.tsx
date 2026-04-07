import React, { useState, useEffect, useCallback } from 'react';
import { LayoutGridIcon, RefreshCwIcon } from 'lucide-react';

interface MiniAppEntry {
  name: string;
  dirName: string;
}

export function MiniAppsTab({
  workspacePath,
  onSelectApp,
}: {
  workspacePath: string;
  onSelectApp: (dirName: string) => void;
}) {
  const [apps, setApps] = useState<MiniAppEntry[]>([]);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="miniAppsTab">
      <div className="miniAppsTabHeader">
        <span className="miniAppsTabTitle">Applications</span>
        <button
          className="miniAppsTabRefresh"
          onClick={refresh}
          title="Refresh"
          disabled={loading}
        >
          <RefreshCwIcon style={{ width: 14, height: 14 }} />
        </button>
      </div>
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
