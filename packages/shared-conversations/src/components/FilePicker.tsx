import React, { useState, useEffect, useCallback } from 'react';
import { useApiClient } from '../context/ApiContext';
import { FileEntry } from '../types/api';

interface FilePickerProps {
  onSelect: (file: File) => void;
  onCancel: () => void;
  initialDir?: string;
}

const ALLOWED_EXT = new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'tex', 'rtf']);

function ext(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function isSelectable(entry: FileEntry) {
  return !entry.isDir && ALLOWED_EXT.has(ext(entry.name));
}

export function FilePicker({ onSelect, onCancel, initialDir }: FilePickerProps) {
  const client = useApiClient();
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(async (dir?: string) => {
    setLoading(true);
    setSelected(null);
    setError(null);
    try {
      const result = await client.browseFiles?.(dir);
      if (result) {
        setCurrentPath(result.path);
        setParent(result.parent);
        setEntries(result.entries);
      }
    } catch {
      setError('Could not read directory.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { navigate(initialDir); }, [navigate]);

  const handleConfirm = async () => {
    if (!selected) return;
    setReading(true);
    setError(null);
    try {
      const file = await client.readFile?.(selected.path);
      if (file) onSelect(file);
      else setError('Could not read file.');
    } catch {
      setError('Could not read file.');
    } finally {
      setReading(false);
    }
  };

  // Show just the last segment of the path as the title
  const dirName = currentPath
    ? currentPath.split('/').filter(Boolean).pop() ?? currentPath
    : '…';

  return (
    <div style={styles.backdrop}>
      <div style={styles.panel}>
        {/* Header */}
        <div style={styles.header}>
          <button
            style={styles.upBtn}
            onClick={() => parent && navigate(parent)}
            disabled={!parent || loading}
            title="Go up"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 11V3M3 7l4-4 4 4"/>
            </svg>
          </button>
          <span style={styles.dirName} title={currentPath}>{dirName}</span>
        </div>

        {/* File list */}
        <div style={styles.list}>
          {loading && <div style={styles.status}>Loading…</div>}
          {error && <div style={{ ...styles.status, color: '#dc2626' }}>{error}</div>}
          {!loading && entries.map(entry => {
            const selectable = isSelectable(entry);
            const isSelected = selected?.path === entry.path;
            return (
              <button
                key={entry.path}
                style={{
                  ...styles.entry,
                  ...(isSelected ? styles.entrySelected : {}),
                  ...(!entry.isDir && !selectable ? styles.entryDisabled : {}),
                }}
                onClick={() => {
                  if (entry.isDir) navigate(entry.path);
                  else if (selectable) setSelected(entry);
                }}
                title={entry.name}
              >
                <span style={styles.entryIcon}>
                  {entry.isDir ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2H5l1.5 2H11.5A1.5 1.5 0 0 1 13 5.5v5A1.5 1.5 0 0 1 11.5 12h-9A1.5 1.5 0 0 1 1 10.5v-7z" fill={isSelected ? '#3b6fd4' : '#6b7280'} />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <rect x="2" y="1" width="10" height="12" rx="1.5" fill={isSelected ? '#3b6fd4' : selectable ? '#9ca3af' : '#d1d5db'} />
                      <path d="M4 5h6M4 7.5h6M4 10h4" stroke="#fff" strokeWidth="1" strokeLinecap="round"/>
                    </svg>
                  )}
                </span>
                <span style={styles.entryName}>{entry.name}</span>
                {entry.isDir && (
                  <span style={styles.chevron}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                      <path d="M3 2l4 3-4 3"/>
                    </svg>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
          <button
            style={{ ...styles.selectBtn, ...(selected && !reading ? {} : styles.selectBtnDisabled) }}
            onClick={handleConfirm}
            disabled={!selected || reading}
          >
            {reading ? 'Loading…' : 'Select'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    background: '#ffffff',
    borderRadius: '12px',
    border: '1px solid #CCC9BC',
    width: 'calc(100% - 32px)',
    maxHeight: '420px',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
    overflow: 'hidden',
    fontFamily: "'DM Sans', -apple-system, sans-serif",
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 12px 10px',
    borderBottom: '1px solid #e5e5e5',
    flexShrink: 0,
  },
  upBtn: {
    background: 'none',
    border: '1px solid #CCC9BC',
    borderRadius: '6px',
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: '#535366',
    padding: 0,
    flexShrink: 0,
  },
  dirName: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#141413',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '4px 0',
    minHeight: 0,
  },
  status: {
    padding: '12px 14px',
    fontSize: '13px',
    color: '#535366',
  },
  entry: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '7px 14px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: '13px',
    color: '#141413',
    borderRadius: 0,
  },
  entrySelected: {
    backgroundColor: '#eef2f9',
    color: '#1a4bbf',
  },
  entryDisabled: {
    opacity: 0.4,
    cursor: 'default',
  },
  entryIcon: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  entryName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chevron: {
    flexShrink: 0,
    color: '#9ca3af',
    display: 'flex',
    alignItems: 'center',
  },
  footer: {
    display: 'flex',
    gap: '8px',
    padding: '10px 12px',
    borderTop: '1px solid #e5e5e5',
    justifyContent: 'flex-end',
    flexShrink: 0,
  },
  cancelBtn: {
    background: '#ffffff',
    border: '1px solid #CCC9BC',
    borderRadius: '8px',
    padding: '6px 14px',
    fontSize: '13px',
    cursor: 'pointer',
    color: '#141413',
    fontFamily: 'inherit',
  },
  selectBtn: {
    background: '#141413',
    border: 'none',
    borderRadius: '8px',
    padding: '6px 14px',
    fontSize: '13px',
    cursor: 'pointer',
    color: '#ffffff',
    fontFamily: 'inherit',
  },
  selectBtnDisabled: {
    opacity: 0.4,
    cursor: 'default',
  },
};
