import React, { useState, useCallback, useEffect } from 'react';
import { AlertDialog } from 'radix-ui';
import './GoogleDrivePicker.css';

declare global {
  interface Window {
    googleDriveAPI: {
      status: () => Promise<{ connected: boolean; hasCredentials: boolean; hasDriveScope: boolean }>;
      connect: () => Promise<{ success: boolean; error?: string }>;
      listFolder: (folderId?: string, options?: { sharedWithMe?: boolean }) => Promise<any>;
      saveSelection: (selection: any) => Promise<{ success: boolean; error?: string }>;
      getSelection: () => Promise<{ success: boolean; data: any }>;
    };
  }
}

interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  shared?: boolean;
}

interface SelectedItem {
  id: string;
  name: string;
  mimeType: string;
  path: string;
}

interface GoogleDrivePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectionSaved?: (items: SelectedItem[]) => void;
  skipSave?: boolean;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function GoogleDrivePicker({ open, onOpenChange, onSelectionSaved, skipSave }: GoogleDrivePickerProps) {
  const [authState, setAuthState] = useState<'loading' | 'needs-auth' | 'needs-scope' | 'ready'>('loading');
  const [authError, setAuthError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [myDriveItems, setMyDriveItems] = useState<DriveItem[]>([]);
  const [sharedItems, setSharedItems] = useState<DriveItem[]>([]);
  const [folderChildren, setFolderChildren] = useState<Map<string, DriveItem[]>>(new Map());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [selectedItems, setSelectedItems] = useState<Map<string, SelectedItem>>(new Map());
  const [myDriveLoading, setMyDriveLoading] = useState(false);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [myDriveExpanded, setMyDriveExpanded] = useState(true);
  const [sharedExpanded, setSharedExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  const checkAuth = useCallback(async () => {
    setAuthState('loading');
    try {
      const status = await window.googleDriveAPI.status();
      if (!status.connected || !status.hasCredentials) {
        setAuthState('needs-auth');
      } else if (!status.hasDriveScope) {
        setAuthState('needs-scope');
      } else {
        setAuthState('ready');
      }
    } catch {
      setAuthState('needs-auth');
    }
  }, []);

  const loadMyDrive = useCallback(async () => {
    setMyDriveLoading(true);
    try {
      const result = await window.googleDriveAPI.listFolder();
      if (result.success && result.data) {
        setMyDriveItems(result.data.files ?? []);
      }
    } finally {
      setMyDriveLoading(false);
    }
  }, []);

  const loadSharedWithMe = useCallback(async () => {
    setSharedLoading(true);
    try {
      const result = await window.googleDriveAPI.listFolder(undefined, { sharedWithMe: true });
      if (result.success && result.data) {
        setSharedItems(result.data.files ?? []);
      }
    } finally {
      setSharedLoading(false);
    }
  }, []);

  const loadFolder = useCallback(async (folderId: string) => {
    setLoadingFolders(prev => new Set(prev).add(folderId));
    try {
      const result = await window.googleDriveAPI.listFolder(folderId);
      if (result.success && result.data) {
        setFolderChildren(prev => new Map(prev).set(folderId, result.data.files ?? []));
      }
    } finally {
      setLoadingFolders(prev => { const n = new Set(prev); n.delete(folderId); return n; });
    }
  }, []);

  useEffect(() => {
    if (open) {
      checkAuth();
    }
  }, [open, checkAuth]);

  useEffect(() => {
    if (open && authState === 'ready' && myDriveItems.length === 0) {
      loadMyDrive();
      window.googleDriveAPI.getSelection().then(result => {
        if (result.success && result.data?.selectedItems) {
          const map = new Map<string, SelectedItem>();
          for (const item of result.data.selectedItems) {
            map.set(item.id, item);
          }
          setSelectedItems(map);
        }
      });
    }
  }, [open, authState, myDriveItems.length, loadMyDrive]);

  useEffect(() => {
    if (sharedExpanded && sharedItems.length === 0 && !sharedLoading) {
      loadSharedWithMe();
    }
  }, [sharedExpanded, sharedItems.length, sharedLoading, loadSharedWithMe]);

  const handleConnect = async () => {
    setConnecting(true);
    setAuthError(null);
    try {
      const result = await window.googleDriveAPI.connect();
      if (result.success) {
        await checkAuth();
      } else {
        setAuthError(result.error ?? 'Connection failed');
      }
    } catch (err: any) {
      setAuthError(err?.message ?? 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const toggleFolder = async (item: DriveItem) => {
    const folderId = item.id;
    if (expandedFolders.has(folderId)) {
      setExpandedFolders(prev => { const n = new Set(prev); n.delete(folderId); return n; });
    } else {
      setExpandedFolders(prev => new Set(prev).add(folderId));
      if (!folderChildren.has(folderId)) {
        await loadFolder(folderId);
      }
    }
  };

  const toggleSelect = (item: DriveItem, itemPath: string) => {
    setSelectedItems(prev => {
      const next = new Map(prev);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.set(item.id, {
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
          path: itemPath,
        });
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const items = Array.from(selectedItems.values());
      if (skipSave) {
        onSelectionSaved?.(items);
        onOpenChange(false);
        return;
      }
      const selection = { selectedItems: items, connectedAt: new Date().toISOString() };
      const result = await window.googleDriveAPI.saveSelection(selection);
      if (result.success) {
        onSelectionSaved?.(items);
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  const isFolder = (item: DriveItem) => item.mimeType === FOLDER_MIME;

  const renderItem = (item: DriveItem, depth: number, parentPath: string) => {
    const itemPath = `${parentPath}/${item.name}`;
    const folder = isFolder(item);
    const expanded = expandedFolders.has(item.id);
    const loading = loadingFolders.has(item.id);
    const selected = selectedItems.has(item.id);
    const children = folderChildren.get(item.id) ?? [];

    return (
      <div key={item.id}>
        <div
          className="gdp-item"
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
        >
          <label className="gdp-item__checkbox" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => toggleSelect(item, itemPath)}
            />
          </label>
          {folder ? (
            <button
              className="gdp-item__expand"
              onClick={() => toggleFolder(item)}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {loading ? '...' : expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="gdp-item__expand gdp-item__expand--file" />
          )}
          <span className="gdp-item__icon">{folder ? '📁' : '📄'}</span>
          <span className="gdp-item__name" title={item.name}>{item.name}</span>
          {item.shared && item.owners?.[0]?.displayName && (
            <span className="gdp-item__owner" title={item.owners[0].emailAddress}>
              {item.owners[0].displayName}
            </span>
          )}
        </div>
        {folder && expanded && (
          <div className="gdp-children">
            {loading && children.length === 0 && (
              <div className="gdp-loading" style={{ paddingLeft: `${(depth + 1) * 20 + 8}px` }}>Loading...</div>
            )}
            {children.map(child => renderItem(child, depth + 1, itemPath))}
          </div>
        )}
      </div>
    );
  };

  const renderAuthScreen = () => {
    const isReconnect = authState === 'needs-scope';
    return (
      <div className="gdp-auth">
        <div className="gdp-auth__icon">🔗</div>
        <h3 className="gdp-auth__title">
          {isReconnect ? 'Drive access needed' : 'Connect Google Drive'}
        </h3>
        <p className="gdp-auth__desc">
          {isReconnect
            ? 'Your Google connection needs updating to include Drive access. Click below to grant the additional scope.'
            : 'Sign in with your Google account to browse and select files from your Drive.'}
        </p>
        {authError && <p className="gdp-auth__error">{authError}</p>}
        <button
          className="chatListModalBtn chatListModalBtn--primary"
          onClick={handleConnect}
          disabled={connecting}
        >
          {connecting ? 'Connecting...' : isReconnect ? 'Reconnect Google' : 'Connect Google'}
        </button>
      </div>
    );
  };

  const selectedCount = selectedItems.size;

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="chatListModalOverlay" />
        <AlertDialog.Content className="gdp-modal">
          <AlertDialog.Title className="chatListModalTitle">Google Drive</AlertDialog.Title>
          <AlertDialog.Description className="chatListModalDesc">
            Select folders and files to make available to your workspace.
          </AlertDialog.Description>

          {authState === 'loading' && (
            <div className="gdp-loading">Checking connection...</div>
          )}

          {(authState === 'needs-auth' || authState === 'needs-scope') && renderAuthScreen()}

          {authState === 'ready' && (
            <>
              <div className="gdp-tree">
                {/* My Drive section */}
                <div className="gdp-section">
                  <button
                    className="gdp-section-header"
                    onClick={() => setMyDriveExpanded(prev => !prev)}
                  >
                    <span className="gdp-section-header__arrow">{myDriveExpanded ? '▾' : '▸'}</span>
                    <span className="gdp-section-header__icon">💾</span>
                    My Drive
                  </button>
                  {myDriveExpanded && (
                    <div className="gdp-section-body">
                      {myDriveLoading && myDriveItems.length === 0 && (
                        <div className="gdp-loading" style={{ paddingLeft: '28px' }}>Loading...</div>
                      )}
                      {myDriveItems.map(item => renderItem(item, 1, ''))}
                    </div>
                  )}
                </div>

                {/* Shared with me section */}
                <div className="gdp-section">
                  <button
                    className="gdp-section-header"
                    onClick={() => setSharedExpanded(prev => !prev)}
                  >
                    <span className="gdp-section-header__arrow">{sharedExpanded ? '▾' : '▸'}</span>
                    <span className="gdp-section-header__icon">👥</span>
                    Shared with me
                  </button>
                  {sharedExpanded && (
                    <div className="gdp-section-body">
                      {sharedLoading && sharedItems.length === 0 && (
                        <div className="gdp-loading" style={{ paddingLeft: '28px' }}>Loading...</div>
                      )}
                      {sharedItems.map(item => renderItem(item, 1, 'Shared'))}
                    </div>
                  )}
                </div>
              </div>

              {selectedCount > 0 && (
                <div className="gdp-selection-summary">
                  {selectedCount} item{selectedCount !== 1 ? 's' : ''} selected
                </div>
              )}
            </>
          )}

          <div className="chatListModalActions">
            <AlertDialog.Cancel asChild>
              <button className="chatListModalBtn chatListModalBtn--secondary" onClick={handleClose}>
                Cancel
              </button>
            </AlertDialog.Cancel>
            {authState === 'ready' && (
              <AlertDialog.Action asChild>
                <button
                  className="chatListModalBtn chatListModalBtn--primary"
                  onClick={(e) => { e.preventDefault(); handleSave(); }}
                  disabled={saving || selectedCount === 0}
                >
                  {saving ? 'Saving...' : `Add ${selectedCount} item${selectedCount !== 1 ? 's' : ''}`}
                </button>
              </AlertDialog.Action>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
