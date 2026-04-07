import React, { useState, useEffect, useCallback, useRef } from 'react';

export const AppsDebug: React.FC = () => {
  const [entries, setEntries] = useState<CommandLogEntry[]>([]);
  const [appNames, setAppNames] = useState<string[]>([]);
  const [selectedApp, setSelectedApp] = useState('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const [all, names] = await Promise.all([
      window.commandLogAPI.getAll(),
      window.commandLogAPI.getAppNames(),
    ]);
    setEntries(all);
    setAppNames(names);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Live updates
  useEffect(() => {
    const cleanup = window.commandLogAPI.onEntry((entry) => {
      setEntries(prev => [...prev, entry]);
      if (entry.appDirName) {
        setAppNames(prev =>
          prev.includes(entry.appDirName!) ? prev : [...prev, entry.appDirName!].sort()
        );
      }
    });
    return cleanup;
  }, []);

  // Auto-scroll on new entries
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const filtered = selectedApp === 'all'
    ? entries
    : entries.filter(e => e.appDirName === selectedApp);

  return (
    <div className="debugSection">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h3 className="debugSection__title" style={{ margin: 0 }}>App Commands</h3>
        <select
          value={selectedApp}
          onChange={e => setSelectedApp(e.target.value)}
          style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid #ccc' }}
        >
          <option value="all">All ({entries.length})</option>
          {appNames.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
          Auto-scroll
        </label>
      </div>

      <div className="debugSection__tableWrap" ref={scrollRef} style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        <table className="debugSection__table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Source</th>
              <th>App</th>
              <th>Command</th>
              <th>Exit</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: '#999', padding: 24 }}>
                  No commands logged yet
                </td>
              </tr>
            ) : filtered.map(entry => (
              <React.Fragment key={entry.id}>
                <tr
                  onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  style={{
                    cursor: 'pointer',
                    background: entry.exitCode !== 0 ? '#fff0f0' : undefined,
                  }}
                >
                  <td className="debugSection__mono" style={{ whiteSpace: 'nowrap' }}>
                    {formatTime(entry.timestamp)}
                  </td>
                  <td>
                    <span style={{
                      fontSize: 10,
                      padding: '1px 5px',
                      borderRadius: 3,
                      background: entry.source === 'agent' ? '#e8f0fe' : '#fef3e0',
                      color: entry.source === 'agent' ? '#1a73e8' : '#e65100',
                    }}>
                      {entry.source}
                    </span>
                  </td>
                  <td style={{ fontSize: 12 }}>{entry.appDirName ?? '—'}</td>
                  <td className="debugSection__mono" title={entry.command.join(' ')} style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.command.join(' ')}
                  </td>
                  <td style={{ color: entry.exitCode !== 0 ? '#c00' : '#1a7f37', fontWeight: 600 }}>
                    {entry.exitCode}
                  </td>
                </tr>
                {expandedId === entry.id && (
                  <tr>
                    <td colSpan={5} style={{ padding: 0 }}>
                      <pre className="debugSection__mono" style={{
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        maxHeight: 200,
                        overflow: 'auto',
                        margin: 0,
                        padding: '8px 10px',
                        background: '#f8f8f8',
                        fontSize: 11,
                        lineHeight: 1.5,
                      }}>
                        {entry.stdout || '(no stdout)'}
                        {entry.stderr ? `\n--- stderr ---\n${entry.stderr}` : ''}
                      </pre>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}
