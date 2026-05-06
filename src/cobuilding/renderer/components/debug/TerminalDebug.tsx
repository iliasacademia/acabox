/// <reference path="../../types.d.ts" />
import React, { useState, useEffect, useRef } from 'react';

interface TerminalEntry {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const TerminalDebug: React.FC = () => {
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [executing, setExecuting] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.containerAPI.status().then(({ running: r }) => setRunning(r));
    const interval = setInterval(() => {
      window.containerAPI.status().then(({ running: r }) => setRunning(r));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Scroll to bottom when new output arrives
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [entries, executing]);

  const handleRun = async () => {
    const cmd = input.trim();
    if (!cmd || executing) return;

    setExecuting(true);
    setInput('');
    setHistory((prev) => [cmd, ...prev.filter((h) => h !== cmd)].slice(0, 100));
    setHistoryIndex(-1);

    try {
      const result = await window.containerAPI.exec(['bash', '-c', cmd]);
      setEntries((prev) => [
        ...prev,
        { command: cmd, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      ]);
    } catch (err) {
      setEntries((prev) => [
        ...prev,
        { command: cmd, stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 },
      ]);
    } finally {
      setExecuting(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleRun();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(idx);
      if (history[idx] !== undefined) setInput(history[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = Math.max(historyIndex - 1, -1);
      setHistoryIndex(idx);
      setInput(idx === -1 ? '' : history[idx]);
    }
  };

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">Terminal</h3>

      <div className="debugSection__status">
        <span
          className={`debugSection__indicator ${running ? 'debugSection__indicator--running' : 'debugSection__indicator--stopped'}`}
        />
        <span>{running ? 'Container running' : 'Container not running — start it in the Podman section'}</span>
      </div>

      <div className="terminalDebug__output" ref={outputRef}>
        {entries.length === 0 && !executing && (
          <span className="terminalDebug__empty">No commands yet</span>
        )}
        {entries.map((entry, i) => (
          <div key={i} className="terminalDebug__entry">
            <div className="terminalDebug__prompt">$ {entry.command}</div>
            {entry.stdout && (
              <pre className="terminalDebug__text">{entry.stdout}</pre>
            )}
            {entry.stderr && (
              <pre className="terminalDebug__text terminalDebug__text--err">{entry.stderr}</pre>
            )}
            {entry.exitCode !== 0 && (
              <div className="terminalDebug__exitCode">Exit {entry.exitCode}</div>
            )}
          </div>
        ))}
        {executing && <div className="terminalDebug__running">Running...</div>}
      </div>

      <div className="terminalDebug__inputRow">
        <span className="terminalDebug__promptSymbol">$</span>
        <input
          ref={inputRef}
          className="terminalDebug__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={running ? 'Enter command...' : 'Start container first'}
          disabled={!running || executing}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          className="debugSection__btn"
          onClick={handleRun}
          disabled={!running || executing || !input.trim()}
        >
          {executing ? 'Running...' : 'Run'}
        </button>
        {entries.length > 0 && (
          <button
            className="debugSection__btn"
            onClick={() => setEntries([])}
            disabled={executing}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
};
