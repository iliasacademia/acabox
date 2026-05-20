import React, { useState } from 'react';

export const BriefingsDebug: React.FC = () => {
  const [status, setStatus] = useState<'idle' | 'running'>('idle');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleTrigger = async () => {
    setStatus('running');
    setResult(null);
    setError(null);
    try {
      await window.debugAPI.triggerInDepthSuggestions();
      setResult('In-depth suggestion run completed');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus('idle');
    }
  };

  return (
    <div className="debugSection">
      <h2 className="debugSection__title">Briefings</h2>
      <div className="debugSection__actions">
        <button
          className="debugSection__btn"
          onClick={handleTrigger}
          disabled={status === 'running'}
        >
          {status === 'running' ? 'Running...' : 'Run In-Depth Task Suggestions'}
        </button>
      </div>
      {result && <p className="debugSection__progress">{result}</p>}
      {error && <p className="debugSection__error">{error}</p>}
    </div>
  );
};
