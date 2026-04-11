import React, { useState, useEffect } from 'react';

interface DataPathInfo {
  label: string;
  path: string;
}

export const StorageDebug: React.FC = () => {
  const [environment, setEnvironment] = useState('');
  const [paths, setPaths] = useState<DataPathInfo[]>([]);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    window.debugAPI.getDataPaths().then((data) => {
      setEnvironment(data.environment);
      setPaths(data.paths);
    });
  }, []);

  const handleClearAll = async () => {
    const confirmed = window.confirm(
      `This will delete ALL ${environment} data including databases, settings, podman VM, and logs.\n\nThe app will quit after clearing. Continue?`
    );
    if (!confirmed) return;

    setClearing(true);
    setError(null);
    setResult(null);
    try {
      const results = await window.debugAPI.clearAllData();
      const removed = results.filter(r => r.removed).length;
      const failed = results.filter(r => !r.removed && r.error !== 'not found');
      if (failed.length > 0) {
        setError(`Cleared ${removed} paths, but ${failed.length} failed: ${failed.map(f => f.error).join(', ')}`);
      } else {
        setResult(`Cleared ${removed} paths. The app will now quit.`);
        setTimeout(() => (window.electronAPI as any).invoke('app:quit'), 1500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">Storage</h3>

      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Environment:</span>
        <code className="debugSection__infoValue">{environment}</code>
      </div>

      <h4 className="debugSection__subtitle">Data Paths</h4>
      <div className="debugSection__tableWrap">
        <table className="debugSection__table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {paths.map((p, i) => (
              <tr key={i}>
                <td>{p.label}</td>
                <td className="debugSection__mono">{p.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="debugSection__actions" style={{ marginTop: 16 }}>
        <button
          className="debugSection__btn debugSection__btn--stop"
          onClick={handleClearAll}
          disabled={clearing}
        >
          {clearing ? 'Clearing...' : `Clear All ${environment} Data`}
        </button>
      </div>

      {error && <div className="debugSection__error">{error}</div>}
      {result && <div className="debugSection__progress">{result}</div>}
    </div>
  );
};
