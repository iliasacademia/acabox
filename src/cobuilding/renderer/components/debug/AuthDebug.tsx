import React, { useState, useEffect } from 'react';

type Provider = 'cloudflare' | 'anthropic' | 'custom';

export const AuthDebug: React.FC = () => {
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [baseURL, setBaseURL] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>('cloudflare');
  const [customKey, setCustomKey] = useState('');
  const [customBaseURL, setCustomBaseURL] = useState('');
  const [refetching, setRefetching] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [result, setResult] = useState<{ success: boolean; keyIdentifier?: string; error?: string } | null>(null);

  useEffect(() => {
    window.authAPI.getApiKey().then(({ apiKey, baseURL: url, provider: p }: any) => {
      setCurrentKey(apiKey);
      setBaseURL(url ?? null);
      if (p) setProvider(p);
    });
  }, []);

  const handleRefetch = async () => {
    setRefetching(true);
    setResult(null);
    try {
      const res = await window.authAPI.refetchApiKey();
      setResult(res);
      if (res.success) {
        const { apiKey, baseURL: url } = await window.authAPI.getApiKey();
        setCurrentKey(apiKey);
        setBaseURL(url ?? null);
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setRefetching(false);
    }
  };

  const handleProviderChange = async (newProvider: Provider) => {
    if (newProvider === 'custom') {
      setProvider(newProvider);
      setResult(null);
      return;
    }
    setSwitching(true);
    setResult(null);
    try {
      const res = await window.authAPI.setApiProvider(newProvider);
      if (res.success) {
        setProvider(newProvider);
        const { apiKey, baseURL: url } = await window.authAPI.getApiKey();
        setCurrentKey(apiKey);
        setBaseURL(url ?? null);
        setResult({ success: true });
      } else {
        setResult({ success: false, error: res.error });
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSwitching(false);
    }
  };

  const handleSaveCustomKey = async () => {
    if (!customKey.trim()) return;
    setSwitching(true);
    setResult(null);
    try {
      const res = await window.authAPI.setApiProvider('custom', customKey.trim(), customBaseURL.trim() || undefined);
      if (res.success) {
        setCurrentKey(customKey.trim());
        setBaseURL(customBaseURL.trim() || null);
        setCustomKey('');
        setCustomBaseURL('');
        setResult({ success: true });
      } else {
        setResult({ success: false, error: res.error });
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSwitching(false);
    }
  };

  const maskedKey = currentKey
    ? `${currentKey.slice(0, 10)}...${currentKey.slice(-4)}`
    : 'None';

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">API Key</h3>

      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Provider:</span>
        <span className="debugSection__infoValue">
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as Provider)}
            disabled={switching}
            style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border-color, #555)' }}
          >
            <option value="cloudflare">Cloudflare AI Gateway</option>
            <option value="anthropic">Anthropic API (direct)</option>
            <option value="custom">Custom API Key</option>
          </select>
        </span>
      </div>

      {provider === 'custom' && (
        <>
          <div className="debugSection__infoRow">
            <span className="debugSection__infoLabel">API Key:</span>
            <span className="debugSection__infoValue">
              <input
                type="password"
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                placeholder="sk-ant-..."
                style={{
                  width: '100%',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  border: '1px solid var(--border-color, #555)',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                }}
              />
            </span>
          </div>
          <div className="debugSection__infoRow">
            <span className="debugSection__infoLabel">Base URL:</span>
            <span className="debugSection__infoValue">
              <input
                type="text"
                value={customBaseURL}
                onChange={(e) => setCustomBaseURL(e.target.value)}
                placeholder="https://api.anthropic.com (default if blank)"
                style={{
                  width: '100%',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  border: '1px solid var(--border-color, #555)',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                }}
              />
            </span>
          </div>
          <div className="debugSection__actions">
            <button
              className="debugSection__btn"
              onClick={handleSaveCustomKey}
              disabled={switching || !customKey.trim()}
            >
              {switching ? 'Saving...' : 'Save'}
            </button>
          </div>
        </>
      )}

      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Current Key:</span>
        <code className="debugSection__infoValue">{maskedKey}</code>
      </div>

      {baseURL && (
        <div className="debugSection__infoRow">
          <span className="debugSection__infoLabel">Base URL:</span>
          <code className="debugSection__infoValue" style={{ fontSize: '11px', wordBreak: 'break-all' }}>{baseURL}</code>
        </div>
      )}

      {provider !== 'custom' && (
        <div className="debugSection__actions">
          <button
            className="debugSection__btn"
            onClick={handleRefetch}
            disabled={refetching || switching}
          >
            {refetching ? 'Refetching...' : 'Refetch API Key'}
          </button>
        </div>
      )}

      {result?.success && (
        <div className="debugSection__progress">
          Provider updated successfully
        </div>
      )}
      {result && !result.success && (
        <div className="debugSection__error">
          {result.error || 'Operation failed'}
        </div>
      )}
    </div>
  );
};
