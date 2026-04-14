import React, { useState, useEffect } from 'react';

export const AuthDebug: React.FC = () => {
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [refetching, setRefetching] = useState(false);
  const [result, setResult] = useState<{ success: boolean; keyIdentifier?: string; error?: string } | null>(null);

  useEffect(() => {
    window.authAPI.getApiKey().then(({ apiKey }) => {
      setCurrentKey(apiKey);
    });
  }, []);

  const handleRefetch = async () => {
    setRefetching(true);
    setResult(null);
    try {
      const res = await window.authAPI.refetchApiKey();
      setResult(res);
      if (res.success) {
        const { apiKey } = await window.authAPI.getApiKey();
        setCurrentKey(apiKey);
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setRefetching(false);
    }
  };

  const maskedKey = currentKey
    ? `${currentKey.slice(0, 10)}...${currentKey.slice(-4)}`
    : 'None';

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">API Key</h3>

      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Current Key:</span>
        <code className="debugSection__infoValue">{maskedKey}</code>
      </div>

      <div className="debugSection__actions">
        <button
          className="debugSection__btn"
          onClick={handleRefetch}
          disabled={refetching}
        >
          {refetching ? 'Refetching...' : 'Refetch API Key'}
        </button>
      </div>

      {result?.success && (
        <div className="debugSection__progress">
          API key refetched successfully{result.keyIdentifier ? ` (identifier: ${result.keyIdentifier})` : ''}
        </div>
      )}
      {result && !result.success && (
        <div className="debugSection__error">
          {result.error || 'Failed to refetch API key'}
        </div>
      )}
    </div>
  );
};
