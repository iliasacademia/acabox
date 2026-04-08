/// <reference path="../types.d.ts" />
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';

type LogTab = 'system' | 'commands';

export const AppsDebug: React.FC = () => {
  const [activeTab, setActiveTab] = useState<LogTab>(
    () => (localStorage.getItem('logViewer:tab') as LogTab) || 'system'
  );
  const [selectedApp, setSelectedApp] = useState(
    () => localStorage.getItem('logViewer:appFilter') || 'all'
  );

  const handleTabChange = (tab: LogTab) => {
    setActiveTab(tab);
    localStorage.setItem('logViewer:tab', tab);
  };

  const handleAppChange = (app: string) => {
    setSelectedApp(app);
    localStorage.setItem('logViewer:appFilter', app);
  };
  const [appNames, setAppNames] = useState<string[]>([]);

  useEffect(() => {
    window.commandLogAPI.getAppNames().then(setAppNames);
  }, []);

  useEffect(() => {
    const cleanup = window.commandLogAPI.onEntry((entry) => {
      if (entry.appDirName) {
        setAppNames(prev =>
          prev.includes(entry.appDirName!) ? prev : [...prev, entry.appDirName!].sort()
        );
      }
    });
    return cleanup;
  }, []);

  return (
    <div className="logViewer">
      <div className="logViewer__tabs">
        <button
          className={`logViewer__tab ${activeTab === 'system' ? 'logViewer__tab--active' : ''}`}
          onClick={() => handleTabChange('system')}
        >
          System Logs
        </button>
        <button
          className={`logViewer__tab ${activeTab === 'commands' ? 'logViewer__tab--active' : ''}`}
          onClick={() => handleTabChange('commands')}
        >
          Command Logs
        </button>
        {activeTab === 'commands' && (
          <Select value={selectedApp} onValueChange={handleAppChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Apps</SelectItem>
              {appNames.map(name => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {activeTab === 'system' ? <SystemLogs /> : <CommandLogs selectedApp={selectedApp} />}
    </div>
  );
};

// ─── System Logs ─────────────────────────────────────────────

const SystemLogs: React.FC = () => {
  const [entries, setEntries] = useState<SystemLogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);

  useEffect(() => {
    window.systemLogAPI.getAll().then(setEntries);
  }, []);

  useEffect(() => {
    const cleanup = window.systemLogAPI.onEntry((entry) => {
      setEntries(prev => [...prev, entry]);
    });
    return cleanup;
  }, []);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!initialScrollDone.current && entries.length > 0 && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      initialScrollDone.current = true;
    }
  }, [entries]);

  return (
    <div className="logViewer__scroll" ref={scrollRef}>
      {entries.length === 0 ? (
        <div className="logViewer__empty">No system logs yet</div>
      ) : entries.map(entry => (
        <div key={entry.id} className={`sysLog sysLog--${entry.level}`}>
          <span className="sysLog__time">{formatTime(entry.timestamp)}</span>
          <span className={`sysLog__level sysLog__level--${entry.level}`}>{entry.level}</span>
          <span className="sysLog__text">{entry.text}</span>
        </div>
      ))}
    </div>
  );
};

// ─── Command Logs ────────────────────────────────────────────

const CommandLogs: React.FC<{ selectedApp: string }> = ({ selectedApp }) => {
  const [entries, setEntries] = useState<CommandLogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);

  const refresh = useCallback(async () => {
    const all = await window.commandLogAPI.getAll();
    setEntries(all);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const cleanup = window.commandLogAPI.onEntry((entry) => {
      setEntries(prev => [...prev, entry]);
    });
    return cleanup;
  }, []);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!initialScrollDone.current && entries.length > 0 && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      initialScrollDone.current = true;
    }
  }, [entries]);

  const filtered = selectedApp === 'all'
    ? entries
    : entries.filter(e => e.appDirName === selectedApp);

  return (
    <div className="logViewer__scroll" ref={scrollRef}>
      {filtered.length === 0 ? (
        <div className="logViewer__empty">No commands logged yet</div>
      ) : filtered.map(entry => (
        <div
          key={entry.id}
          className={`logEntry ${entry.exitCode !== 0 ? 'logEntry--error' : ''}`}
        >
          <div className="logEntry__header">
            <span className="logEntry__time">{formatTime(entry.timestamp)}</span>
            <span className={`logEntry__source logEntry__source--${entry.source}`}>
              {entry.source}
            </span>
            {entry.appDirName && (
              <span className="logEntry__app">{entry.appDirName}</span>
            )}
            <span className={`logEntry__exit ${entry.exitCode !== 0 ? 'logEntry__exit--error' : ''}`}>
              exit {entry.exitCode}
            </span>
          </div>
          <div className="logEntry__command">
            <span className="logEntry__prompt">$</span> {entry.command.join(' ')}
          </div>
          {entry.stdout && (
            <pre className="logEntry__output">{entry.stdout}</pre>
          )}
          {entry.stderr && (
            <pre className="logEntry__output logEntry__output--stderr">{entry.stderr}</pre>
          )}
        </div>
      ))}
    </div>
  );
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}
