import React, { useState, useEffect } from 'react';

interface SyncFolder {
  id: string;
  path: string;
  status: 'idle' | 'syncing' | 'synced' | 'error';
  lastSync: string | null;
  fileCount: number;
  errorMessage?: string;
  initialSyncStatus?: 'fetching' | 'syncing' | 'completed' | 'partial' | 'error';
  initialSyncMessage?: string;
  initialSyncProgress?: { synced: number; total: number };
}

interface SyncedFile {
  path: string;
  fileName: string;
  status: 'pending' | 'uploading' | 'success' | 'error';
  timestamp: string;
}

const SyncSection: React.FC = () => {
  const [folders, setFolders] = useState<SyncFolder[]>([]);
  const [syncedFiles, setSyncedFiles] = useState<SyncedFile[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadSyncFolders();

    // Listen for file sync events
    window.electronAPI.on('file-synced', (_event: any, data: any) => {
      console.log('File synced:', data);
      setSyncedFiles((prev) => {
        // Remove any existing entry for this file path to prevent duplicates
        const filtered = prev.filter(f => f.path !== data.filePath);
        return [
          {
            path: data.filePath,
            fileName: data.fileName,
            status: data.status >= 200 && data.status < 300 ? 'success' : 'error',
            timestamp: new Date().toISOString(),
          },
          ...filtered,
        ];
      });

      // Update folder status - don't increment fileCount as backend will have correct count
      if (data.folderId) {
        setFolders((prev) =>
          prev.map((folder) =>
            folder.id === data.folderId
              ? {
                  ...folder,
                  lastSync: new Date().toISOString(),
                  status: 'synced',
                }
              : folder
          )
        );
      }
    });

    // Listen for folder status updates
    window.electronAPI.on('folder-sync-status', (_event: any, data: any) => {
      console.log('Folder sync status:', data);
      setFolders((prev) =>
        prev.map((folder) =>
          folder.id === data.folderId
            ? {
                ...folder,
                status: data.status,
                errorMessage: data.error,
              }
            : folder
        )
      );
    });

    // Listen for initial sync status
    window.electronAPI.on('initial-sync-status', (_event: any, data: any) => {
      console.log('Initial sync status:', data);
      setFolders((prev) =>
        prev.map((folder) =>
          folder.id === data.folderId
            ? {
                ...folder,
                initialSyncStatus: data.status,
                initialSyncMessage: data.message,
                initialSyncProgress: data.totalFiles
                  ? { synced: data.syncedCount || 0, total: data.totalFiles }
                  : undefined,
                fileCount: data.syncedCount || folder.fileCount,
              }
            : folder
        )
      );
    });

    // Listen for initial sync progress
    window.electronAPI.on('initial-sync-progress', (_event: any, data: any) => {
      console.log('Initial sync progress:', data);
      setFolders((prev) =>
        prev.map((folder) =>
          folder.id === data.folderId
            ? {
                ...folder,
                initialSyncProgress: { synced: data.synced, total: data.total },
              }
            : folder
        )
      );
    });

    return () => {
      window.electronAPI.removeAllListeners('file-synced');
      window.electronAPI.removeAllListeners('folder-sync-status');
      window.electronAPI.removeAllListeners('initial-sync-status');
      window.electronAPI.removeAllListeners('initial-sync-progress');
    };
  }, []);

  const loadSyncFolders = async () => {
    setIsLoading(true);
    try {
      const result = await window.electronAPI.invoke('get-sync-folders');
      if (result.success) {
        setFolders(result.folders || []);

        // Show offline message if backend is not responding
        if (result.offline) {
          console.warn('[SYNC UI] Backend is offline, showing local data only');
        }
      }
    } catch (error) {
      console.error('Error loading sync folders:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddFolder = async () => {
    const folderPath = await window.electronAPI.invoke('select-folder');
    if (folderPath) {
      try {
        const result = await window.electronAPI.invoke('add-sync-folder', folderPath);
        if (result.success) {
          setFolders((prev) => [...prev, result.folder]);
        } else {
          alert(result.error || 'Failed to add folder');
        }
      } catch (error: any) {
        console.error('Error adding folder:', error);
        alert(error.message || 'Failed to add folder');
      }
    }
  };

  const handleRemoveFolder = async (folderId: string) => {
    if (!confirm('Are you sure you want to stop syncing this folder?')) {
      return;
    }

    try {
      const result = await window.electronAPI.invoke('remove-sync-folder', folderId);
      if (result.success) {
        setFolders((prev) => prev.filter((f) => f.id !== folderId));
        if (selectedFolderId === folderId) {
          setSelectedFolderId(null);
        }
      } else {
        alert(result.error || 'Failed to remove folder');
      }
    } catch (error: any) {
      console.error('Error removing folder:', error);
      alert(error.message || 'Failed to remove folder');
    }
  };

  const handleSyncNow = async (folderId: string) => {
    try {
      const result = await window.electronAPI.invoke('sync-folder-now', folderId);
      if (!result.success) {
        alert(result.error || 'Failed to trigger sync');
      }
    } catch (error: any) {
      console.error('Error syncing folder:', error);
      alert(error.message || 'Failed to trigger sync');
    }
  };

  const handleViewFiles = async (folderId: string) => {
    setSelectedFolderId(folderId);
    try {
      const result = await window.electronAPI.invoke('get-folder-files', folderId);
      if (result.success) {
        setSyncedFiles(result.files || []);
      }
    } catch (error) {
      console.error('Error loading folder files:', error);
    }
  };

  const getStatusIcon = (status: SyncFolder['status']) => {
    switch (status) {
      case 'syncing':
        return '🔄';
      case 'synced':
        return '✅';
      case 'error':
        return '⚠️';
      default:
        return '⏸️';
    }
  };

  const getStatusText = (folder: SyncFolder) => {
    if (folder.status === 'error' && folder.errorMessage === 'Backend offline') {
      return 'Offline (watching locally)';
    }
    return folder.status;
  };

  const getFileStatusIcon = (status: SyncedFile['status']) => {
    switch (status) {
      case 'uploading':
        return '🔄';
      case 'success':
        return '✅';
      case 'error':
        return '❌';
      default:
        return '⏳';
    }
  };

  const formatTimestamp = (timestamp: string | null) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleString();
  };

  if (isLoading) {
    return (
      <div style={{ padding: '20px' }}>
        <h1>Folder Sync</h1>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>
      <h1>Sync Agent</h1>
      <p>Add folders to automatically sync files to your Academia account.</p>

      <div style={{ marginTop: '20px' }}>
        <button
          onClick={handleAddFolder}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            backgroundColor: '#28a745',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
          }}
        >
          Add Folder
        </button>
      </div>

      {folders.length === 0 && (
        <div style={{ marginTop: '20px', padding: '20px', backgroundColor: '#f8f9fa', borderRadius: '5px' }}>
          <p>No folders added yet. Click "Add Folder" to start syncing.</p>
        </div>
      )}

      {folders.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <h2>Synced Folders</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: '#f8f9fa' }}>
                <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #dee2e6' }}>Status</th>
                <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #dee2e6' }}>Folder Path</th>
                <th style={{ padding: '10px', textAlign: 'center', borderBottom: '2px solid #dee2e6' }}>Files</th>
                <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #dee2e6' }}>Last Sync</th>
                <th style={{ padding: '10px', textAlign: 'center', borderBottom: '2px solid #dee2e6' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr key={folder.id} style={{ borderBottom: '1px solid #dee2e6' }}>
                  <td style={{ padding: '10px', textAlign: 'center' }}>
                    <span title={getStatusText(folder)}>{getStatusIcon(folder.status)}</span>
                  </td>
                  <td style={{ padding: '10px' }}>
                    <div style={{ fontSize: '14px' }}>{folder.path}</div>
                    {folder.errorMessage === 'Backend offline' && (
                      <div style={{ fontSize: '12px', color: '#ff9800', marginTop: '4px' }}>
                        ⚠️ Backend offline - files are being watched locally and will sync when connection is restored
                      </div>
                    )}
                    {folder.initialSyncStatus && folder.initialSyncStatus !== 'completed' && (
                      <div style={{ fontSize: '12px', color: '#007bff', marginTop: '4px' }}>
                        {folder.initialSyncMessage}
                        {folder.initialSyncProgress && (
                          <span> ({folder.initialSyncProgress.synced}/{folder.initialSyncProgress.total})</span>
                        )}
                      </div>
                    )}
                    {folder.initialSyncStatus === 'completed' && (
                      <div style={{ fontSize: '12px', color: '#28a745', marginTop: '4px' }}>
                        {folder.initialSyncMessage}
                      </div>
                    )}
                    {folder.initialSyncStatus === 'error' && (
                      <div style={{ fontSize: '12px', color: '#dc3545', marginTop: '4px' }}>
                        {folder.initialSyncMessage}
                      </div>
                    )}
                    {folder.initialSyncStatus === 'partial' && (
                      <div style={{ fontSize: '12px', color: '#ffc107', marginTop: '4px' }}>
                        {folder.initialSyncMessage}
                      </div>
                    )}
                    {folder.errorMessage && !folder.initialSyncStatus && (
                      <div style={{ fontSize: '12px', color: '#dc3545', marginTop: '4px' }}>
                        {folder.errorMessage}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px', textAlign: 'center' }}>{folder.fileCount}</td>
                  <td style={{ padding: '10px', fontSize: '14px' }}>{formatTimestamp(folder.lastSync)}</td>
                  <td style={{ padding: '10px', textAlign: 'center' }}>
                    <button
                      onClick={() => handleSyncNow(folder.id)}
                      style={{
                        padding: '5px 10px',
                        marginRight: '5px',
                        fontSize: '12px',
                        backgroundColor: '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: 'pointer',
                      }}
                      disabled={folder.status === 'syncing'}
                    >
                      Sync Now
                    </button>
                    <button
                      onClick={() => handleViewFiles(folder.id)}
                      style={{
                        padding: '5px 10px',
                        marginRight: '5px',
                        fontSize: '12px',
                        backgroundColor: '#6c757d',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: 'pointer',
                      }}
                    >
                      View Files
                    </button>
                    <button
                      onClick={() => handleRemoveFolder(folder.id)}
                      style={{
                        padding: '5px 10px',
                        fontSize: '12px',
                        backgroundColor: '#dc3545',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: 'pointer',
                      }}
                      disabled={folder.status === 'syncing'}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedFolderId && syncedFiles.length > 0 && (
        <div style={{ marginTop: '30px' }}>
          <h2>Recently Synced Files</h2>
          <button
            onClick={() => {
              setSelectedFolderId(null);
              setSyncedFiles([]);
            }}
            style={{
              padding: '5px 10px',
              marginBottom: '10px',
              fontSize: '12px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: '#f8f9fa' }}>
                <th style={{ padding: '10px', textAlign: 'center', borderBottom: '2px solid #dee2e6' }}>Status</th>
                <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #dee2e6' }}>File Name</th>
                <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #dee2e6' }}>Path</th>
                <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #dee2e6' }}>Synced At</th>
              </tr>
            </thead>
            <tbody>
              {syncedFiles.map((file, index) => (
                <tr key={index} style={{ borderBottom: '1px solid #dee2e6' }}>
                  <td style={{ padding: '10px', textAlign: 'center' }}>{getFileStatusIcon(file.status)}</td>
                  <td style={{ padding: '10px' }}>{file.fileName}</td>
                  <td style={{ padding: '10px', fontSize: '12px', color: '#6c757d' }}>{file.path}</td>
                  <td style={{ padding: '10px', fontSize: '14px' }}>{formatTimestamp(file.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SyncSection;
