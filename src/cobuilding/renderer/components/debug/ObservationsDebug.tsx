import React, { useEffect, useState, useCallback } from 'react';

declare global {
  interface Window {
    observationsAPI: {
      getBrowserSessions: () => Promise<any[]>;
      getFileSessions: () => Promise<any[]>;
      getSessionFiles: () => Promise<any[]>;
    };
  }
}

const MAX_CELL_LENGTH = 80;

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const DynamicTable: React.FC<{ rows: any[]; tableId: string }> = ({ rows, tableId }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (rows.length === 0) {
    return (
      <table className="debugSection__table">
        <tbody>
          <tr><td style={{ textAlign: 'center', color: '#999' }}>No data</td></tr>
        </tbody>
      </table>
    );
  }

  const columns = Object.keys(rows[0]);

  const toggleCell = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <table className="debugSection__table">
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col}>{col}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIdx) => (
          <tr key={row.id ?? rowIdx}>
            {columns.map((col) => {
              const raw = formatCellValue(row[col]);
              const cellKey = `${tableId}-${rowIdx}-${col}`;
              const isLong = raw.length > MAX_CELL_LENGTH;
              const isExpanded = expanded.has(cellKey);

              return (
                <td key={col} style={isExpanded ? { wordBreak: 'break-all', whiteSpace: 'normal' } : undefined}>
                  {isLong && !isExpanded ? (
                    <>
                      {raw.slice(0, MAX_CELL_LENGTH)}...{' '}
                      <a
                        href="#"
                        onClick={(e) => { e.preventDefault(); toggleCell(cellKey); }}
                        style={{ color: '#58a6ff', fontSize: '0.85em' }}
                      >
                        show more
                      </a>
                    </>
                  ) : isLong && isExpanded ? (
                    <>
                      {raw}{' '}
                      <a
                        href="#"
                        onClick={(e) => { e.preventDefault(); toggleCell(cellKey); }}
                        style={{ color: '#58a6ff', fontSize: '0.85em' }}
                      >
                        show less
                      </a>
                    </>
                  ) : (
                    raw
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export const ObservationsDebug: React.FC = () => {
  const [browserSessions, setBrowserSessions] = useState<any[]>([]);
  const [fileSessions, setFileSessions] = useState<any[]>([]);
  const [sessionFiles, setSessionFiles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [browser, files, sFiles] = await Promise.all([
        window.observationsAPI.getBrowserSessions(),
        window.observationsAPI.getFileSessions(),
        window.observationsAPI.getSessionFiles(),
      ]);
      setBrowserSessions(browser);
      setFileSessions(files);
      setSessionFiles(sFiles);
    } catch (err) {
      console.error('Failed to load observations:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 className="debugSection__title" style={{ margin: 0 }}>Observations</h2>
        <button className="debugSection__btn" onClick={refresh} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <h3 className="debugSection__subtitle">Browser Sessions ({browserSessions.length})</h3>
      <div className="debugSection__tableWrap">
        <DynamicTable rows={browserSessions} tableId="browser" />
      </div>

      <h3 className="debugSection__subtitle">File Sessions ({fileSessions.length})</h3>
      <div className="debugSection__tableWrap">
        <DynamicTable rows={fileSessions} tableId="file" />
      </div>

      <h3 className="debugSection__subtitle">Session Files ({sessionFiles.length})</h3>
      <div className="debugSection__tableWrap">
        <DynamicTable rows={sessionFiles} tableId="sfiles" />
      </div>
    </div>
  );
};
