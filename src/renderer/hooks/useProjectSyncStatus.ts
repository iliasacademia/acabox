import { useState, useEffect } from 'react';
import { IPC_CHANNELS } from '../../shared/types';

type SyncStatus = 'watching' | 'syncing' | 'error' | 'idle';

/**
 * Hook to monitor aggregate sync status for a project's folders
 * Returns the "most important" status across all folders:
 * - error if any folder has error
 * - syncing if any folder is syncing
 * - watching if any folder is watching (active)
 * - idle if no folders or all idle
 */
export function useProjectSyncStatus(projectId: number | null): SyncStatus {
  const [folderStatuses, setFolderStatuses] = useState<Map<string, SyncStatus>>(new Map());

  useEffect(() => {
    if (!projectId) {
      setFolderStatuses(new Map());
      return;
    }

    // Fetch initial status for all project folders
    const fetchInitialStatus = async () => {
      try {
        // Get project folders from API
        const response = await window.electronAPI.invoke('api-call', {
          method: 'GET',
          endpoint: `v0/co_scientist/projects/${projectId}/folders`
        });

        if (response && response.folders) {
          const folders = response.folders;

          // Fetch watcher status for each folder
          for (const folder of folders) {
            try {
              const status = await window.electronAPI.invoke(
                IPC_CHANNELS.GET_PROJECT_WATCHER_STATUS,
                projectId,
                folder.id
              );

              if (status) {
                const key = `${projectId}-${folder.id}`;
                const displayStatus: SyncStatus =
                  !status.watcherActive ? 'idle' :
                  status.status === 'error' ? 'error' :
                  status.status === 'syncing' ? 'syncing' :
                  'watching';

                setFolderStatuses(prev => {
                  const updated = new Map(prev);
                  updated.set(key, displayStatus);
                  return updated;
                });
              }
            } catch (error) {
              console.warn(`Failed to get watcher status for folder ${folder.id}:`, error);
            }
          }
        }
      } catch (error) {
        console.warn('Failed to fetch initial folder status:', error);
      }
    };

    fetchInitialStatus();

    // Listen for watcher status changes
    const handleWatcherStatusChanged = (
      _event: any,
      data: {
        projectId: number;
        folderId: number;
        watcherActive: boolean;
        status: 'idle' | 'syncing' | 'synced' | 'error';
      }
    ) => {
      if (data.projectId === projectId) {
        const key = `${data.projectId}-${data.folderId}`;

        // Map backend status to display status
        let displayStatus: SyncStatus;
        if (!data.watcherActive) {
          displayStatus = 'idle';
        } else if (data.status === 'error') {
          displayStatus = 'error';
        } else if (data.status === 'syncing') {
          displayStatus = 'syncing';
        } else {
          // synced or idle with active watcher = watching
          displayStatus = 'watching';
        }

        setFolderStatuses(prev => {
          const updated = new Map(prev);
          updated.set(key, displayStatus);
          return updated;
        });
      }
    };

    // Listen for project sync status updates (from PROJECT_SYNC_STATUS channel)
    const handleProjectSyncStatus = (
      _event: any,
      data: {
        projectId: number;
        folderId: number;
        status: 'idle' | 'syncing' | 'synced' | 'error';
      }
    ) => {
      if (data.projectId === projectId) {
        const key = `${data.projectId}-${data.folderId}`;

        // Map backend status to display status
        const displayStatus: SyncStatus =
          data.status === 'syncing' ? 'syncing' :
          data.status === 'error' ? 'error' :
          'watching';

        setFolderStatuses(prev => {
          const updated = new Map(prev);
          updated.set(key, displayStatus);
          return updated;
        });
      }
    };

    window.electronAPI.on(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, handleWatcherStatusChanged);
    window.electronAPI.on(IPC_CHANNELS.PROJECT_SYNC_STATUS, handleProjectSyncStatus);

    return () => {
      window.electronAPI.removeListener(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, handleWatcherStatusChanged);
      window.electronAPI.removeListener(IPC_CHANNELS.PROJECT_SYNC_STATUS, handleProjectSyncStatus);
    };
  }, [projectId]);

  // Aggregate status: return the "most important" status
  if (folderStatuses.size === 0) {
    return 'idle';
  }

  const statuses = Array.from(folderStatuses.values());

  // Priority: error > syncing > watching > idle
  if (statuses.some(s => s === 'error')) {
    return 'error';
  }
  if (statuses.some(s => s === 'syncing')) {
    return 'syncing';
  }
  if (statuses.some(s => s === 'watching')) {
    return 'watching';
  }

  return 'idle';
}
